import { secretFingerprint } from '../log-redaction'
import {
  ILINK_TYPING_KEEPALIVE_MS,
  ILINK_TYPING_STATUS_CANCEL,
  ILINK_TYPING_STATUS_TYPING,
  ILINK_TYPING_TICKET_TTL_MS
} from './types'

/**
 * 微信原生「正在输入」状态。
 *
 * 协议：`getconfig` 取 `typing_ticket`，再用 `sendtyping` 下发 status=1 / status=2。
 * `typing_ticket` 只用于输入状态，**不是** sendmessage 的鉴权凭据。
 *
 * 这个模块要解决四件事：
 * 1. **非致命**：所有失败都只记日志，绝不影响 Query Agent / 日报 / 最终消息发送。
 * 2. **必须收尾**：调用方在 finally 里 stop，任何异常路径都不会留下"对方正在输入"。
 * 3. **引用计数**：同一用户并发两个任务时，先结束的那个不能把另一个的 typing 一起取消。
 * 4. **少打接口**：typing_ticket 按「账号 + 对端用户」缓存，并发取票去重。
 */

export interface TypingLease {
  /** 幂等；可安全地在 finally 里调用。永不抛异常。 */
  stop(): Promise<void>
}

export interface TypingBeginInput {
  accountId?: string
  to: string
  contextToken?: string
}

export interface TypingCoordinatorDependencies {
  /** 取 typing_ticket；失败/无票返回 undefined 即可（上层已 catch）。 */
  fetchTicket: (input: {
    ilinkUserId: string
    contextToken?: string
  }) => Promise<string | undefined>
  /** 下发 status=1/2；返回是否成功。 */
  sendTyping: (input: { ilinkUserId: string; ticket: string; status: number }) => Promise<boolean>
  log: (level: 'info' | 'warn' | 'error', message: string) => void
  now?: () => number
  keepaliveMs?: number
  ticketTtlMs?: number
  maxPeers?: number
  /**
   * 定时器注入点：返回取消函数。
   * 测试用可控实现，生产用 setInterval。
   */
  schedule?: (tick: () => void, intervalMs: number) => () => void
}

interface PeerTypingState {
  key: string
  accountId: string
  to: string
  sessionId: string
  refCount: number
  /** 当前微信端是否处于「正在输入」。 */
  active: boolean
  startedAt: number
  cancelKeepalive: (() => void) | null
  ticket?: string
  ticketFetchedAt: number
  /** 并发取票去重。 */
  ticketFetch: Promise<string | undefined> | null
  contextToken?: string
  /** 串行化 activate / deactivate，避免本次 TYPING 被上一次的 CANCEL 吃掉。 */
  queue: Promise<void>
  keepaliveFailureLogged: boolean
  lastUseAt: number
}

const DEFAULT_MAX_PEERS = 50
const NOOP_LEASE: TypingLease = { stop: async () => undefined }

export class TypingCoordinator {
  private readonly deps: TypingCoordinatorDependencies
  private readonly keepaliveMs: number
  private readonly ticketTtlMs: number
  private readonly maxPeers: number
  private readonly states = new Map<string, PeerTypingState>()

  constructor(dependencies: TypingCoordinatorDependencies) {
    this.deps = dependencies
    this.keepaliveMs = dependencies.keepaliveMs ?? ILINK_TYPING_KEEPALIVE_MS
    this.ticketTtlMs = dependencies.ticketTtlMs ?? ILINK_TYPING_TICKET_TTL_MS
    this.maxPeers = dependencies.maxPeers ?? DEFAULT_MAX_PEERS
  }

  /** 当前处于「正在输入」的对端数量；用于测试与观测。 */
  get activePeerCount(): number {
    let count = 0
    for (const state of this.states.values()) if (state.active) count += 1
    return count
  }

  /**
   * 开始一次输入状态。**永不抛异常**：拿不到 ticket 或服务端失败时返回一个空实现，
   * 业务侧照常执行。
   */
  async begin(input: TypingBeginInput): Promise<TypingLease> {
    const to = String(input.to ?? '').trim()
    if (!to) return NOOP_LEASE
    const accountId = String(input.accountId ?? '').trim()
    const key = `${accountId}::${to}`

    try {
      this.pruneIfNeeded()
      const state = this.stateFor(key, accountId, to)
      state.refCount += 1
      state.lastUseAt = this.now()
      if (input.contextToken) state.contextToken = input.contextToken

      const shouldActivate = state.refCount === 1
      if (shouldActivate) {
        // 串行化：等上一次 deactivate 落地，避免 TYPING 紧接着被 CANCEL 掉。
        state.queue = state.queue.then(() => this.activate(state))
        await state.queue
      }
      return this.createLease(state)
    } catch (error) {
      // 兜底：任何意外都退化为空实现，绝不让 typing 影响业务。
      this.deps.log('warn', `typing.begin.failed error=${describeTypingError(error)}`)
      return NOOP_LEASE
    }
  }

  /** 账号切换 / 重新登录 / bot token 失效后调用：清空 ticket 缓存。 */
  invalidateTickets(): void {
    for (const state of this.states.values()) {
      state.ticket = undefined
      state.ticketFetchedAt = 0
      state.ticketFetch = null
    }
  }

  /** 连接器停止时调用：清掉全部状态与定时器，避免留下悬挂的 keepalive。 */
  clear(): void {
    for (const state of this.states.values()) {
      if (state.cancelKeepalive) {
        state.cancelKeepalive()
        state.cancelKeepalive = null
      }
      state.refCount = 0
      state.active = false
    }
    this.states.clear()
  }

  private createLease(state: PeerTypingState): TypingLease {
    let stopped = false
    return {
      stop: async (): Promise<void> => {
        if (stopped) return
        stopped = true
        try {
          state.refCount = Math.max(0, state.refCount - 1)
          if (state.refCount > 0) return
          state.queue = state.queue.then(() => this.deactivate(state))
          await state.queue
        } catch (error) {
          this.deps.log(
            'warn',
            `typing.stop.leaked session=${state.sessionId} error=${describeTypingError(error)}`
          )
        }
      }
    }
  }

  private stateFor(key: string, accountId: string, to: string): PeerTypingState {
    const existing = this.states.get(key)
    if (existing) return existing
    const state: PeerTypingState = {
      key,
      accountId,
      to,
      // 日志里只出现不可逆短指纹，不出现 openid 原文。
      sessionId: secretFingerprint(key),
      refCount: 0,
      active: false,
      startedAt: 0,
      cancelKeepalive: null,
      ticketFetchedAt: 0,
      ticketFetch: null,
      queue: Promise.resolve(),
      keepaliveFailureLogged: false,
      lastUseAt: this.now()
    }
    this.states.set(key, state)
    return state
  }

  private async activate(state: PeerTypingState): Promise<void> {
    if (state.active) return

    const ticket = await this.ensureTicket(state)
    if (!ticket) {
      // 无票（getconfig 失败 / 服务端没给）时静默降级，业务照常。
      return
    }

    const ok = await this.trySendTyping(state, ticket, ILINK_TYPING_STATUS_TYPING)
    if (!ok) {
      // ticket 可能已失效：丢掉缓存，下次需要时重取。
      state.ticket = undefined
      state.ticketFetchedAt = 0
      this.deps.log('warn', `typing.start.failed session=${state.sessionId} ticketPresent=true`)
      return
    }

    state.active = true
    state.startedAt = this.now()
    state.keepaliveFailureLogged = false
    const schedule = this.deps.schedule ?? defaultSchedule
    state.cancelKeepalive = schedule(() => {
      void this.keepalive(state)
    }, this.keepaliveMs)
    this.deps.log('info', `typing.start session=${state.sessionId} ticketPresent=true`)
  }

  private async deactivate(state: PeerTypingState): Promise<void> {
    if (state.cancelKeepalive) {
      state.cancelKeepalive()
      state.cancelKeepalive = null
    }
    if (!state.active) return
    state.active = false

    const durationMs = Math.max(0, this.now() - state.startedAt)
    const ticket = state.ticket
    if (!ticket) return

    const ok = await this.trySendTyping(state, ticket, ILINK_TYPING_STATUS_CANCEL)
    if (ok) {
      this.deps.log(
        'info',
        `typing.stop session=${state.sessionId} duration=${durationMs}ms success=true`
      )
    } else {
      this.deps.log(
        'warn',
        `typing.stop.failed session=${state.sessionId} duration=${durationMs}ms success=false`
      )
    }
  }

  /**
   * 长任务的输入状态会自己消失，必须周期性重发 status=1。
   * 失败只在同一会话里记一次日志，避免每 5 秒刷屏。
   */
  private async keepalive(state: PeerTypingState): Promise<void> {
    if (!state.active || !state.ticket) return
    const ok = await this.trySendTyping(state, state.ticket, ILINK_TYPING_STATUS_TYPING)
    if (ok) return
    if (state.keepaliveFailureLogged) return
    state.keepaliveFailureLogged = true
    this.deps.log('warn', `typing.keepalive.failed session=${state.sessionId}`)
  }

  private async ensureTicket(state: PeerTypingState): Promise<string | undefined> {
    const cached = String(state.ticket ?? '')
    if (cached && this.now() - state.ticketFetchedAt < this.ticketTtlMs) return cached
    if (state.ticketFetch) return state.ticketFetch

    const pending = (async (): Promise<string | undefined> => {
      try {
        const ticket = await this.deps.fetchTicket({
          ilinkUserId: state.to,
          ...(state.contextToken ? { contextToken: state.contextToken } : {})
        })
        const normalized = String(ticket ?? '').trim()
        if (!normalized) {
          this.deps.log(
            'warn',
            `typing.ticket.missing session=${state.sessionId} ticketPresent=false`
          )
          return undefined
        }
        state.ticket = normalized
        state.ticketFetchedAt = this.now()
        return normalized
      } catch (error) {
        this.deps.log(
          'warn',
          `typing.ticket.failed session=${state.sessionId} ticketPresent=false error=${describeTypingError(error)}`
        )
        return undefined
      } finally {
        state.ticketFetch = null
      }
    })()

    state.ticketFetch = pending
    return pending
  }

  private async trySendTyping(
    state: PeerTypingState,
    ticket: string,
    status: number
  ): Promise<boolean> {
    try {
      return await this.deps.sendTyping({ ilinkUserId: state.to, ticket, status })
    } catch (error) {
      // 由调用方决定记哪条日志，这里只吞掉异常保证非致命。
      void error
      return false
    }
  }

  private pruneIfNeeded(): void {
    if (this.states.size <= this.maxPeers) return
    const idle = [...this.states.values()]
      .filter((state) => state.refCount === 0 && !state.active)
      .sort((left, right) => left.lastUseAt - right.lastUseAt)
    for (const state of idle) {
      if (this.states.size <= this.maxPeers) break
      this.states.delete(state.key)
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }
}

function defaultSchedule(tick: () => void, intervalMs: number): () => void {
  const timer = setInterval(tick, intervalMs)
  // keepalive 不该阻止进程退出。
  if (typeof timer.unref === 'function') timer.unref()
  return () => clearInterval(timer)
}

function describeTypingError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
