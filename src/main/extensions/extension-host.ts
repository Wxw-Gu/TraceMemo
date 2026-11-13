import { fork, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { ExtensionError, toExtensionErrorPayload } from '../../shared/extensions/errors'
import type { ExtensionRuntimeSnapshot } from '../../shared/extensions/types'
import {
  sortPermissionsByRisk,
  type ExtensionPermission
} from '../../shared/extensions/permissions'
import { EXTENSION_API_VERSION } from '../../shared/extensions/manifest'
import {
  EXTENSION_HOST_PROTOCOL_VERSION,
  type ExtensionAutomationActionOutput,
  type ExtensionHostCall,
  type ExtensionHostCallMethod,
  type ExtensionHostInboundMessage,
  type ExtensionHostOutboundMessage,
  type ExtensionMessagesQueryRequest,
  type ExtensionQueriedMessage,
  type ExtensionSendImageRequest,
  type ExtensionSendTextRequest,
  type ExtensionSendTextResult,
  type ExtensionSendVideoRequest
} from '../../shared/extensions/rpc'
import type { ExtensionEventEnvelope } from '../../shared/extensions/events'
import type { ExtensionCapabilitySnapshot } from '../../shared/extensions/types'
import type { ExtensionStorage } from './extension-storage'

const DEFAULT_ACTIVATE_TIMEOUT_MS = 8_000
const DEFAULT_ACTION_TIMEOUT_MS = 15_000
const MAX_RESTARTS = 3
const RESTART_WINDOW_MS = 5 * 60 * 1000
const RESTART_BASE_DELAY_MS = 1_000
const EVENT_BUCKET_CAPACITY = 100
const EVENT_REFILL_PER_SECOND = 60

export interface ExtensionHostChild {
  send(message: unknown): void
  kill(): void
  on(event: 'message', listener: (message: unknown) => void): void
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): void
  on(event: 'error', listener: (error: Error) => void): void
  once?(event: 'exit', listener: () => void): void
  readonly pid?: number
}

export interface ExtensionHostSpawnOptions {
  extensionId: string
  extensionDir: string
}

export interface ExtensionHostDependencies {
  extensionId: string
  extensionDir: string
  /** 扩展私有数据目录；媒体文件只允许从这里或临时目录发送。 */
  dataDir: string
  permissions: ExtensionPermission[]
  storage: ExtensionStorage
  spawn: (options: ExtensionHostSpawnOptions) => ExtensionHostChild
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void
  onStateChange?: (snapshot: ExtensionRuntimeSnapshot) => void
  onActionsChanged?: () => void
  queryMessages?: (
    extensionId: string,
    request: ExtensionMessagesQueryRequest
  ) => Promise<ExtensionQueriedMessage[]>
  sendText?: (
    extensionId: string,
    request: ExtensionSendTextRequest
  ) => Promise<ExtensionSendTextResult>
  sendImage?: (
    extensionId: string,
    request: ExtensionSendImageRequest
  ) => Promise<ExtensionSendTextResult>
  sendVideo?: (
    extensionId: string,
    request: ExtensionSendVideoRequest
  ) => Promise<ExtensionSendTextResult>
  aiChat?: (
    extensionId: string,
    messages: Array<{ role: string; content: string }>
  ) => Promise<{ text: string }>
  capabilities?: (extensionId: string) => Promise<ExtensionCapabilitySnapshot>
  now?: () => number
  activateTimeoutMs?: number
  actionTimeoutMs?: number
}

interface PendingAction {
  resolve: (value: ExtensionAutomationActionOutput) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface RegisteredAction {
  id: string
  title: string
  description?: string
}

interface ActivationWaiter {
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  child: ExtensionHostChild
}

/**
 * 单个扩展的后台进程。
 *
 * **隔离边界**：每个扩展一个独立 Node 子进程，`require` 只发生在那里面；
 * 主进程从不 `require` 扩展代码。子进程拿不到 Electron API、数据库句柄、
 * 授权凭据或原生发送通道 —— 它只能通过本类转发的白名单 RPC 申请能力。
 *
 * ⚠️ 独立进程不等于强沙箱：后台仍是任意 Node 代码，安装时按「受信任本地开发者扩展」处理。
 */
export class ExtensionHost {
  private readonly dependencies: ExtensionHostDependencies
  private readonly storage: ExtensionStorage
  private readonly now: () => number
  private child: ExtensionHostChild | null = null
  private state: ExtensionRuntimeSnapshot
  private stopping = false
  private activation: Promise<void> | null = null
  private activationWaiter: ActivationWaiter | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private readonly pendingActions = new Map<string, PendingAction>()
  private readonly testHandlers = new Map<
    string,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private readonly actions = new Map<string, RegisteredAction>()
  private eventTokens = EVENT_BUCKET_CAPACITY
  private eventTokensAt: number
  private droppedEvents = 0
  private mutedDropLog = false
  private restartTimestamps: number[] = []

  constructor(dependencies: ExtensionHostDependencies) {
    this.dependencies = dependencies
    this.storage = dependencies.storage
    this.now = dependencies.now ?? (() => Date.now())
    this.eventTokensAt = this.now()
    this.state = { state: 'inactive', since: this.now(), restarts: 0 }
  }

  snapshot(): ExtensionRuntimeSnapshot {
    return { ...this.state }
  }

  registeredActions(): RegisteredAction[] {
    return Array.from(this.actions.values()).map((action) => ({ ...action }))
  }

  async testSend(params: Record<string, unknown>): Promise<unknown> {
    return this.runTestMessage('test-send', params)
  }

  private async runTestMessage(
    type: 'test-send',
    params: Record<string, unknown>
  ): Promise<unknown> {
    if (this.state.state !== 'active' || !this.child) {
      throw new ExtensionError('EXTENSION_HOST_UNAVAILABLE')
    }
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.testHandlers.delete(requestId)
        reject(new ExtensionError('ACTION_TIMEOUT'))
      }, 450_000)
      this.testHandlers.set(requestId, { resolve, reject, timer })
      try {
        this.child?.send({
          type,
          version: EXTENSION_HOST_PROTOCOL_VERSION,
          requestId,
          params
        })
      } catch (error) {
        clearTimeout(timer)
        this.testHandlers.delete(requestId)
        reject(
          new ExtensionError(
            'EXTENSION_HOST_UNAVAILABLE',
            error instanceof Error ? error.message : '扩展进程不可用'
          )
        )
      }
    })
  }

  /** 启动并等待 `activate` 握手完成。重复调用复用同一次启动。 */
  async start(): Promise<void> {
    if (this.state.state === 'active') return
    if (this.activation) return this.activation
    this.stopping = false
    this.activation = this.doStart().finally(() => {
      this.activation = null
    })
    return this.activation
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    const child = this.child
    this.child = null
    this.settleActivation(new ExtensionError('EXTENSION_HOST_UNAVAILABLE', '扩展已停止'))
    this.failPendingActions(new ExtensionError('EXTENSION_HOST_UNAVAILABLE', '扩展已停止'))
    this.failPendingTests(new ExtensionError('EXTENSION_HOST_UNAVAILABLE', '扩展已停止'))
    this.actions.clear()
    this.setState('inactive')
    if (!child) return
    try {
      child.send({ type: 'shutdown', version: EXTENSION_HOST_PROTOCOL_VERSION })
    } catch {
      // 进程可能已经断开；kill 兜底。
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          // ignore
        }
        resolve()
      }, 1_500)
      child.once?.('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  /**
   * 投递消息事件。
   *
   * 令牌桶是**背压边界**：扩展处理慢或消息突发时宁可丢事件并如实记日志，
   * 也不能让主进程的监听回调被拖垮。
   */
  deliverEvent(envelope: ExtensionEventEnvelope): boolean {
    if (this.state.state !== 'active' || !this.child) return false
    this.refillTokens()
    if (this.eventTokens < 1) {
      this.droppedEvents += 1
      if (!this.mutedDropLog && this.droppedEvents % 100 === 1) {
        this.dependencies.onLog?.('warn', '消息事件超过扩展处理上限，部分事件已丢弃')
        this.mutedDropLog = true
        setTimeout(() => {
          this.mutedDropLog = false
        }, 10_000)
      }
      return false
    }
    this.eventTokens -= 1
    try {
      this.child.send({ type: 'event', version: EXTENSION_HOST_PROTOCOL_VERSION, envelope })
      return true
    } catch {
      return false
    }
  }

  /** 调用扩展注册的自动化动作。超时由宿主强制结束，扩展无法自行取消。 */
  async invokeAction(
    actionId: string,
    input: Record<string, unknown>,
    timeoutMs = this.dependencies.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS
  ): Promise<ExtensionAutomationActionOutput> {
    if (this.state.state !== 'active' || !this.child) {
      throw new ExtensionError('EXTENSION_HOST_UNAVAILABLE')
    }
    if (!this.actions.has(actionId)) {
      throw new ExtensionError('ACTION_FAILED', `扩展没有注册动作 ${actionId}`)
    }
    const requestId = randomUUID()
    return new Promise<ExtensionAutomationActionOutput>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pendingActions.delete(requestId)
          reject(new ExtensionError('ACTION_TIMEOUT'))
        },
        Math.max(1_000, Math.min(timeoutMs, 60_000))
      )
      this.pendingActions.set(requestId, { resolve, reject, timer })
      try {
        this.child?.send({
          type: 'invoke-action',
          version: EXTENSION_HOST_PROTOCOL_VERSION,
          requestId,
          actionId,
          input,
          timeoutMs
        })
      } catch (error) {
        clearTimeout(timer)
        this.pendingActions.delete(requestId)
        reject(
          new ExtensionError(
            'EXTENSION_HOST_UNAVAILABLE',
            error instanceof Error ? error.message : '扩展进程不可用'
          )
        )
      }
    })
  }

  private async doStart(): Promise<void> {
    this.setState('starting')
    this.actions.clear()
    let child: ExtensionHostChild
    try {
      child = this.dependencies.spawn({
        extensionId: this.dependencies.extensionId,
        extensionDir: this.dependencies.extensionDir
      })
    } catch (error) {
      this.setState('error', error instanceof Error ? error.message : '扩展进程启动失败')
      throw new ExtensionError('EXTENSION_HOST_UNAVAILABLE', '扩展进程启动失败')
    }
    this.child = child
    this.wire(child)

    try {
      await this.activateChild(child)
      this.setState('active')
      this.dependencies.onLog?.('info', '扩展后台已启动')
    } catch (error) {
      this.dependencies.onLog?.(
        'error',
        `扩展启动失败：${error instanceof Error ? error.message : String(error)}`
      )
      // 先摘掉引用再 kill：否则 exit 回调会被当成「运行期崩溃」并触发重启。
      if (this.child === child) this.child = null
      try {
        child.kill()
      } catch {
        // ignore
      }
      this.setState('error', error instanceof Error ? error.message : '扩展启动失败')
      throw error instanceof Error
        ? error
        : new ExtensionError('EXTENSION_HOST_UNAVAILABLE', '扩展启动失败')
    }
  }

  /** 发 `activate` 并等待 `activated`。握手结果由 `handleMessage` 统一结算。 */
  private activateChild(child: ExtensionHostChild): Promise<void> {
    const timeoutMs = this.dependencies.activateTimeoutMs ?? DEFAULT_ACTIVATE_TIMEOUT_MS
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.settleActivation(new ExtensionError('ACTION_TIMEOUT', '扩展启动超时'))
        },
        Math.max(2_000, timeoutMs)
      )
      this.activationWaiter = { resolve, reject, timer, child }
      try {
        child.send({
          type: 'activate',
          version: EXTENSION_HOST_PROTOCOL_VERSION,
          extensionId: this.dependencies.extensionId,
          extensionDir: this.dependencies.extensionDir,
          dataDir: this.dependencies.dataDir,
          apiVersion: EXTENSION_API_VERSION,
          permissions: sortPermissionsByRisk(this.dependencies.permissions)
        })
      } catch (error) {
        this.settleActivation(
          new ExtensionError(
            'EXTENSION_HOST_UNAVAILABLE',
            error instanceof Error ? error.message : '无法向扩展进程发送激活指令'
          )
        )
      }
    })
  }

  private settleActivation(error?: Error): void {
    const waiter = this.activationWaiter
    if (!waiter) return
    this.activationWaiter = null
    clearTimeout(waiter.timer)
    if (error) waiter.reject(error)
    else waiter.resolve()
  }

  private wire(child: ExtensionHostChild): void {
    child.on('message', (message) => this.handleMessage(message))
    child.on('error', (error) => {
      this.dependencies.onLog?.('error', `扩展进程错误：${error.message}`)
    })
    child.on('exit', (code) => this.handleExit(child, code))
  }

  private handleExit(child: ExtensionHostChild, code: number | null): void {
    if (this.child !== child) return
    this.child = null
    this.actions.clear()
    this.settleActivation(new ExtensionError('EXTENSION_HOST_UNAVAILABLE', '扩展进程已退出'))
    this.failPendingActions(
      new ExtensionError('EXTENSION_HOST_UNAVAILABLE', `扩展进程已退出（${code ?? 'unknown'}）`)
    )
    this.failPendingTests(new ExtensionError('EXTENSION_HOST_UNAVAILABLE', '扩展进程已退出'))
    if (this.stopping) {
      this.setState('inactive')
      return
    }
    const timestamp = this.now()
    this.restartTimestamps = this.restartTimestamps.filter(
      (item) => timestamp - item < RESTART_WINDOW_MS
    )
    if (this.restartTimestamps.length >= MAX_RESTARTS) {
      this.dependencies.onLog?.('error', '扩展连续异常退出，已停止自动重启')
      this.setState('crashed', '扩展连续异常退出，已停止自动重启')
      return
    }
    this.restartTimestamps.push(timestamp)
    this.setState('starting', '扩展进程异常退出，正在重启')
    const delay = RESTART_BASE_DELAY_MS * 2 ** (this.restartTimestamps.length - 1)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.state = { ...this.state, restarts: this.state.restarts + 1, since: this.now() }
      void this.start().catch(() => undefined)
    }, delay)
  }

  private handleMessage(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return
    const message = raw as ExtensionHostOutboundMessage & { version?: number }
    if (message.version !== EXTENSION_HOST_PROTOCOL_VERSION) return
    switch (message.type) {
      case 'activated':
        this.settleActivation(
          message.ok
            ? undefined
            : new ExtensionError('ACTION_FAILED', message.error?.message || '扩展激活失败')
        )
        return
      case 'call':
        void this.handleCall(message)
        return
      case 'register-action': {
        const action = message.action
        if (!action || typeof action.id !== 'string') return
        this.actions.set(action.id, {
          id: action.id,
          title: String(action.title || action.id).slice(0, 60),
          ...(action.description ? { description: String(action.description).slice(0, 200) } : {})
        })
        this.dependencies.onActionsChanged?.()
        return
      }
      case 'log':
        this.dependencies.onLog?.(message.level, message.message)
        return
      case 'action-result': {
        const pending = this.pendingActions.get(message.requestId)
        if (!pending) return
        clearTimeout(pending.timer)
        this.pendingActions.delete(message.requestId)
        if (message.ok && message.output) {
          pending.resolve(message.output)
        } else {
          pending.reject(
            new ExtensionError(
              'ACTION_FAILED',
              message.error?.message || message.output?.error || '扩展动作执行失败'
            )
          )
        }
        return
      }
      case 'test-result': {
        const pending = this.testHandlers.get(message.requestId)
        if (!pending) return
        clearTimeout(pending.timer)
        this.testHandlers.delete(message.requestId)
        if (message.ok) pending.resolve(message.result)
        else
          pending.reject(
            new ExtensionError(message.error?.code || 'ACTION_FAILED', message.error?.message)
          )
        return
      }
    }
  }

  private async handleCall(message: ExtensionHostCall): Promise<void> {
    try {
      const result = await this.executeCall(message.method, message.params)
      this.send({
        type: 'call-result',
        version: EXTENSION_HOST_PROTOCOL_VERSION,
        callId: message.callId,
        ok: true,
        result
      })
    } catch (error) {
      this.send({
        type: 'call-result',
        version: EXTENSION_HOST_PROTOCOL_VERSION,
        callId: message.callId,
        ok: false,
        error: toExtensionErrorPayload(error)
      })
    }
  }

  private async executeCall(
    method: ExtensionHostCallMethod,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const extensionId = this.dependencies.extensionId
    switch (method) {
      case 'storage.get':
        this.requirePermission('storage')
        return this.storage.get(extensionId, params.key)
      case 'storage.set':
        this.requirePermission('storage')
        this.storage.set(extensionId, params.key, params.value)
        return { ok: true }
      case 'storage.remove':
        this.requirePermission('storage')
        return { removed: this.storage.remove(extensionId, params.key) }
      case 'storage.list':
        this.requirePermission('storage')
        return { entries: this.storage.list(extensionId) }
      case 'messages.query': {
        this.requirePermission('messages.query')
        if (!this.dependencies.queryMessages) throw new ExtensionError('CAPABILITY_UNAVAILABLE')
        return {
          messages: await this.dependencies.queryMessages(
            extensionId,
            params as unknown as ExtensionMessagesQueryRequest
          )
        }
      }
      case 'wechat.send.text': {
        this.requirePermission('wechat.send.text')
        if (!this.dependencies.sendText) throw new ExtensionError('SEND_NOT_SUPPORTED')
        return this.dependencies.sendText(
          extensionId,
          params as unknown as ExtensionSendTextRequest
        )
      }
      case 'wechat.send.image': {
        this.requirePermission('wechat.send.image')
        if (!this.dependencies.sendImage) throw new ExtensionError('SEND_NOT_SUPPORTED')
        return this.dependencies.sendImage(
          extensionId,
          params as unknown as ExtensionSendImageRequest
        )
      }
      case 'wechat.send.video': {
        this.requirePermission('wechat.send.video')
        if (!this.dependencies.sendVideo) throw new ExtensionError('SEND_NOT_SUPPORTED')
        return this.dependencies.sendVideo(
          extensionId,
          params as unknown as ExtensionSendVideoRequest
        )
      }
      case 'ai.chat': {
        this.requirePermission('ai.chat')
        if (!this.dependencies.aiChat) throw new ExtensionError('CAPABILITY_UNAVAILABLE')
        const messages = Array.isArray(params.messages) ? params.messages : []
        const normalized = messages
          .filter((item): item is { role: string; content: string } =>
            Boolean(item && typeof item === 'object')
          )
          .slice(0, 40)
          .map((item) => ({
            role: String((item as { role?: unknown }).role || 'user'),
            content: String((item as { content?: unknown }).content || '').slice(0, 20_000)
          }))
        return this.dependencies.aiChat(extensionId, normalized)
      }
      case 'capabilities.get':
        if (!this.dependencies.capabilities) throw new ExtensionError('CAPABILITY_UNAVAILABLE')
        return this.dependencies.capabilities(extensionId)
      default:
        throw new ExtensionError('INVALID_REQUEST', `未知方法：${String(method)}`)
    }
  }

  private requirePermission(permission: ExtensionPermission): void {
    if (!this.dependencies.permissions.includes(permission)) {
      throw new ExtensionError('PERMISSION_DENIED', `扩展没有 ${permission} 权限`)
    }
  }

  private send(message: ExtensionHostInboundMessage): void {
    try {
      this.child?.send(message)
    } catch {
      // 进程已退出：pending 会由 handleExit 统一失败。
    }
  }

  private failPendingActions(error: Error): void {
    for (const [requestId, pending] of this.pendingActions) {
      clearTimeout(pending.timer)
      this.pendingActions.delete(requestId)
      pending.reject(error)
    }
  }

  private failPendingTests(error: Error): void {
    for (const [requestId, pending] of this.testHandlers) {
      clearTimeout(pending.timer)
      this.testHandlers.delete(requestId)
      pending.reject(error)
    }
  }

  private refillTokens(): void {
    const now = this.now()
    const elapsed = Math.max(0, now - this.eventTokensAt)
    if (elapsed <= 0) return
    this.eventTokens = Math.min(
      EVENT_BUCKET_CAPACITY,
      this.eventTokens + (elapsed / 1000) * EVENT_REFILL_PER_SECOND
    )
    this.eventTokensAt = now
  }

  private setState(next: ExtensionRuntimeSnapshot['state'], lastError?: string): void {
    this.state = {
      state: next,
      since: this.now(),
      restarts: this.state.restarts,
      ...(lastError ? { lastError } : {})
    }
    this.dependencies.onStateChange?.(this.snapshot())
  }
}

/** 真实子进程：`ELECTRON_RUN_AS_NODE` 让 Electron 二进制以 Node 模式运行。 */
export function forkExtensionHost(
  scriptPath: string
): (options: ExtensionHostSpawnOptions) => ExtensionHostChild {
  return (options) => {
    const child: ChildProcess = fork(scriptPath, [], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      serialization: 'advanced',
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        TM_EXTENSION_ID: options.extensionId,
        TM_EXTENSION_DIR: options.extensionDir
      }
    })
    return {
      send: (message) => {
        if (!child.connected) throw new Error('扩展进程未连接')
        child.send(message as object)
      },
      kill: () => child.kill(),
      on: (event, listener) => {
        if (event === 'message') child.on('message', listener as (message: unknown) => void)
        else if (event === 'exit') child.on('exit', listener as (code: number | null) => void)
        else child.on('error', listener as (error: Error) => void)
      },
      once: (event, listener) => {
        child.once(event, listener)
      },
      ...(child.pid ? { pid: child.pid } : {})
    }
  }
}
