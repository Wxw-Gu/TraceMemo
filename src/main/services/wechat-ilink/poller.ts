import { describeError, ILinkError } from './errors'
import {
  ILINK_LONG_POLL_MAX_TIMEOUT_MS,
  ILINK_LONG_POLL_TIMEOUT_MS,
  type ILinkGetUpdatesResponse,
  type ILinkWeixinMessage,
  type WechatInboundMessage
} from './types'

export type PollLogLevel = 'info' | 'warn' | 'error'
export type PollLog = (level: PollLogLevel, message: string) => void

export interface ILinkPollerOptions {
  /** 拉取一批消息；timeoutMs 来自服务端上一次响应里的建议值。 */
  fetchUpdates: (getUpdatesBuf: string, timeoutMs: number) => Promise<ILinkGetUpdatesResponse>
  /**
   * 处理一批入站消息。
   * **只有全部消息被成功接收后才会推进游标**，因此这里抛错会让整批重投。
   */
  onMessages: (messages: WechatInboundMessage[]) => Promise<void>
  normalize: (raw: ILinkWeixinMessage) => WechatInboundMessage | undefined
  loadCursor: () => string
  saveCursor: (getUpdatesBuf: string) => void
  signal: AbortSignal
  log: PollLog
  /** bot token 失效（-14）：停止轮询，交由上层通知用户重新登录。 */
  onStaleToken?: (message: string) => void
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
  normalFailureDelayMs?: number
  repeatedFailureDelayMs?: number
  repeatedFailureThreshold?: number
  defaultTimeoutMs?: number
  maxTimeoutMs?: number
}

const DEFAULT_NORMAL_DELAY_MS = 2_000
const DEFAULT_REPEATED_DELAY_MS = 30_000
const DEFAULT_REPEATED_THRESHOLD = 3

/**
 * 长轮询循环。
 *
 * 1. **先 dispatch 成功，再持久化新游标**。先推进游标再投递的话，进程在两步之间
 *    崩溃就会静默丢消息；这里换取 at-least-once（允许重复，不允许丢失）。
 * 2. **客户端自身超时不算失败**：保留游标直接进入下一轮，不计退避。
 * 3. **ret/errcode = -14 表示 bot token 已失效**，必须停止业务请求并让用户重新登录；
 *    重置游标后紧密重试只会打满接口。
 * 4. 采用服务端 `longpolling_timeout_ms` 建议值，而不是写死超时。
 */
export class ILinkPoller {
  private readonly options: ILinkPollerOptions
  private cursor: string
  private consecutiveFailures = 0
  /** 是否正处于"连不上"的状态；用于在恢复时补一条日志，否则故障窗口在日志里看不出边界。 */
  private degraded = false
  private nextTimeoutMs: number

  constructor(options: ILinkPollerOptions) {
    this.options = options
    this.cursor = options.loadCursor()
    this.nextTimeoutMs = options.defaultTimeoutMs ?? ILINK_LONG_POLL_TIMEOUT_MS
  }

  get getUpdatesBuf(): string {
    return this.cursor
  }

  async run(): Promise<void> {
    const {
      signal,
      log,
      sleep = (milliseconds: number) => new Promise<void>((r) => setTimeout(r, milliseconds))
    } = this.options
    const normalDelay = this.options.normalFailureDelayMs ?? DEFAULT_NORMAL_DELAY_MS
    const repeatedDelay = this.options.repeatedFailureDelayMs ?? DEFAULT_REPEATED_DELAY_MS
    const threshold = this.options.repeatedFailureThreshold ?? DEFAULT_REPEATED_THRESHOLD
    const maxTimeout = this.options.maxTimeoutMs ?? ILINK_LONG_POLL_MAX_TIMEOUT_MS

    log('info', this.cursor ? '长轮询已启动（恢复上次游标）' : '长轮询已启动')

    while (!signal.aborted) {
      let response: ILinkGetUpdatesResponse
      try {
        response = await this.options.fetchUpdates(this.cursor, this.nextTimeoutMs)
      } catch (error) {
        if (signal.aborted) return
        const kind = error instanceof ILinkError ? error.kind : 'network'
        // 长轮询客户端超时属于正常控制流：保留游标，立即进入下一轮。
        if (kind === 'timeout') continue
        // 调用方主动取消（例如停止连接器）
        if (kind === 'aborted') return
        this.consecutiveFailures += 1
        this.degraded = true
        const delay = this.failureDelay(normalDelay, repeatedDelay, threshold)
        log('warn', `获取更新失败，${Math.round(delay / 1000)} 秒后重试：${describeError(error)}`)
        await sleep(delay)
        continue
      }

      if (signal.aborted) return

      const ret = Number(response.ret ?? 0)
      const errcode = Number(response.errcode ?? 0)

      if (ret === -14 || errcode === -14) {
        const message = '当前微信机器人登录凭证已失效，需要重新扫码登录'
        log('error', message)
        // 刻意不清理游标：重新登录后若账号相同，仍可续上原有进度。
        this.options.onStaleToken?.(message)
        return
      }

      if (ret !== 0 || errcode !== 0) {
        this.consecutiveFailures += 1
        this.degraded = true
        const delay = this.failureDelay(normalDelay, repeatedDelay, threshold)
        log(
          'warn',
          `服务端返回错误（ret=${ret} errcode=${errcode}${
            response.errmsg ? ` errmsg=${response.errmsg}` : ''
          }），${Math.round(delay / 1000)} 秒后重试`
        )
        await sleep(delay)
        continue
      }

      this.consecutiveFailures = 0
      if (this.degraded) {
        this.degraded = false
        log('info', '与微信服务器的连接已恢复')
      }

      const messages = this.collectMessages(response.msgs)
      if (messages.length > 0) {
        try {
          await this.options.onMessages(messages)
        } catch (error) {
          // 接收失败：绝不推进游标，让服务端重新投递这一批。
          this.consecutiveFailures += 1
          this.degraded = true
          const delay = this.failureDelay(normalDelay, repeatedDelay, threshold)
          log('error', `入站消息处理失败，游标保持不变以便重投：${describeError(error)}`)
          await sleep(delay)
          continue
        }
      }

      const nextBuf = String(response.get_updates_buf ?? '')
      if (nextBuf && nextBuf !== this.cursor) {
        this.cursor = nextBuf
        try {
          this.options.saveCursor(this.cursor)
        } catch (error) {
          log('warn', `游标持久化失败，下次启动可能重复投递：${describeError(error)}`)
        }
      }

      const suggested = Number(response.longpolling_timeout_ms ?? 0)
      if (Number.isFinite(suggested) && suggested > 0) {
        this.nextTimeoutMs = Math.min(suggested, maxTimeout)
      }
    }
  }

  private collectMessages(raw: ILinkWeixinMessage[] | undefined): WechatInboundMessage[] {
    if (!Array.isArray(raw) || raw.length === 0) return []
    const result: WechatInboundMessage[] = []
    for (const item of raw) {
      const normalized = this.options.normalize(item)
      if (!normalized) {
        this.options.log('warn', '收到一条无法识别的入站消息，已跳过')
        continue
      }
      result.push(normalized)
    }
    return result
  }

  private failureDelay(normalDelay: number, repeatedDelay: number, threshold: number): number {
    if (this.consecutiveFailures >= threshold) {
      this.consecutiveFailures = 0
      return repeatedDelay
    }
    return normalDelay
  }
}
