import { fork, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { killProcessTree, type ProcessTreeKillResult } from '../process-tree'
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
  type ExtensionSendVideoRequest,
  type ExtensionSendVoiceRequest
} from '../../shared/extensions/rpc'
import type { ExtensionEventEnvelope } from '../../shared/extensions/events'
import type { ExtensionCapabilitySnapshot } from '../../shared/extensions/types'
import {
  parseActionInputSchema,
  type ExtensionActionInputSchema
} from '../../shared/extensions/action-schema'
import type { ExtensionStorage } from './extension-storage'
import type { ExtensionSecretStore } from './extension-secret-store'

const DEFAULT_ACTIVATE_TIMEOUT_MS = 8_000
const DEFAULT_ACTION_TIMEOUT_MS = 15_000
const MAX_RESTARTS = 3
const RESTART_WINDOW_MS = 5 * 60 * 1000
const RESTART_BASE_DELAY_MS = 1_000
const EVENT_BUCKET_CAPACITY = 100
const EVENT_REFILL_PER_SECOND = 60

/** 发出 shutdown 后等待扩展自行退出的时间。 */
const GRACEFUL_EXIT_MS = 2_500
/** 结束进程树之后等待 exit 事件的时间。 */
const FORCE_EXIT_MS = 3_000
/** taskkill 的等待上限：卡住时按降级处理，不能拖死停用流程。 */
const TASKKILL_TIMEOUT_MS = 5_000

/** stderr 采样窗口：只把有代表性的片段写进日志，避免日志洪水拖住主进程。 */
const STDERR_WINDOW_MS = 10_000
const STDERR_WINDOW_BYTES = 64 * 1024
const STDERR_WINDOW_ENTRIES = 20
const STDERR_MAX_CHUNK_CHARS = 400

/** stderr 里的凭据形态；落日志前只保留键名。 */
const SECRET_ASSIGNMENT =
  /\b(cookie|token|authorization|password|passwd|secret|api[_-]?key)\b(\s*[:=]\s*)(?!Bearer\b)([^\s,;"']{4,})/gi
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi

export function redactSecrets(value: string): string {
  // 顺序不能反：先抹 `Bearer <token>` 整体，再按「键=值」处理，
  // 否则 `Authorization: Bearer xxx` 会只抹掉 `Bearer`，token 本体留在日志里。
  return String(value ?? '')
    .replace(BEARER_TOKEN, 'Bearer ***')
    .replace(
      SECRET_ASSIGNMENT,
      (_match, name: string, separator: string) => `${name}${separator}***`
    )
}

export interface ExtensionHostChild {
  send(message: unknown): void
  /** 终止本扩展的整棵进程树；实现方负责平台差异。 */
  kill(): void
  on(event: 'message', listener: (message: unknown) => void): void
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): void
  on(event: 'error', listener: (error: Error) => void): void
  once?(event: 'exit', listener: () => void): void
  readonly pid?: number
  /** stderr 必须持续消费，否则管道写满会让子进程阻塞在 write。 */
  readonly stderr?: NodeJS.ReadableStream | null
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
  secrets?: ExtensionSecretStore
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
  sendVoice?: (
    extensionId: string,
    request: ExtensionSendVoiceRequest
  ) => Promise<ExtensionSendTextResult>
  aiChat?: (
    extensionId: string,
    messages: Array<{ role: string; content: string }>
  ) => Promise<{ text: string }>
  capabilities?: (extensionId: string) => Promise<ExtensionCapabilitySnapshot>
  now?: () => number
  activateTimeoutMs?: number
  actionTimeoutMs?: number
  /** 覆盖「等扩展自行退出」的时间；生产默认 2.5s。 */
  gracefulExitMs?: number
  /** 覆盖「结束进程树后等 exit」的时间；生产默认 3s。 */
  forceExitMs?: number
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
  /** 已校验的参数 Schema；非法时为 undefined 且 `schemaError` 有值。 */
  inputSchema?: ExtensionActionInputSchema
  schemaError?: string
}

interface ActivationWaiter {
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  child: ExtensionHostChild
}

/** 单个扩展的后台进程：独立 Node 子进程，主进程从不 require 扩展代码。 */
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
  private readonly pendingPageRequests = new Map<
    string,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private eventTokens = EVENT_BUCKET_CAPACITY
  private eventTokensAt: number
  private droppedEvents = 0
  private mutedDropLog = false
  private restartTimestamps: number[] = []
  private stderrWindow = { bytes: 0, entries: 0, dropped: 0, at: 0 }

  constructor(dependencies: ExtensionHostDependencies) {
    this.dependencies = dependencies
    this.storage = dependencies.storage
    this.now = dependencies.now ?? (() => Date.now())
    this.eventTokensAt = this.now()
    this.stderrWindow.at = this.now()
    this.state = { state: 'inactive', since: this.now(), restarts: 0 }
  }

  snapshot(): ExtensionRuntimeSnapshot {
    return { ...this.state }
  }

  registeredActions(): RegisteredAction[] {
    return Array.from(this.actions.values()).map((action) => ({ ...action }))
  }

  /** 把页面请求转给同扩展的后台处理器；这是唯一入口：页面拿不到 Node，后台必须显式注册 `tm.page.onRequest`。 */
  async requestPage(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 90_000
  ): Promise<unknown> {
    const child = this.child
    if (!child) throw new ExtensionError('EXTENSION_HOST_UNAVAILABLE')
    const requestId = randomUUID()
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pendingPageRequests.delete(requestId)
          reject(new ExtensionError('ACTION_TIMEOUT', '页面请求超时'))
        },
        Math.max(1_000, timeoutMs)
      )
      this.pendingPageRequests.set(requestId, { resolve, reject, timer })
      try {
        child.send({
          type: 'page-request',
          version: EXTENSION_HOST_PROTOCOL_VERSION,
          requestId,
          method,
          params,
          timeoutMs
        })
      } catch (error) {
        clearTimeout(timer)
        this.pendingPageRequests.delete(requestId)
        reject(
          new ExtensionError(
            'EXTENSION_HOST_UNAVAILABLE',
            error instanceof Error ? error.message : '扩展进程不可用'
          )
        )
      }
    })
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

  /** 停止后台：等真实 exit 才算完成，只发信号会在进程占用文件时替换失败。 */
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
    if (!child) {
      this.setState('inactive')
      return
    }

    try {
      child.send({ type: 'shutdown', version: EXTENSION_HOST_PROTOCOL_VERSION })
    } catch {
      // 进程可能已经断开；后续按「未退出」处理。
    }

    if (await this.waitForExit(child, this.dependencies.gracefulExitMs ?? GRACEFUL_EXIT_MS)) {
      this.setState('inactive')
      return
    }

    this.dependencies.onLog?.('warn', '扩展未在预期时间内退出，正在结束进程树')
    await this.killTree(child)
    if (!(await this.waitForExit(child, this.dependencies.forceExitMs ?? FORCE_EXIT_MS))) {
      this.dependencies.onLog?.('error', '扩展进程树未能退出，可能有子进程仍在运行')
    }
    this.setState('inactive')
  }

  /** 结束进程树；Windows 的 taskkill /T 必须在父进程存活时执行，否则找不到孙进程。 */
  private async killTree(child: ExtensionHostChild): Promise<void> {
    const pid = child.pid
    if (!pid) {
      try {
        child.kill()
      } catch {
        // ignore
      }
      return
    }
    const result = await killProcessTree(pid, {
      timeoutMs: this.dependencies.forceExitMs ?? TASKKILL_TIMEOUT_MS
    })
    if (result === 'group' || result === 'taskkill') return
    try {
      child.kill()
    } catch {
      // 进程已退出。
    }
    if (process.platform === 'win32') {
      this.dependencies.onLog?.('warn', '结束扩展进程树失败，已退化为直接结束扩展进程')
      return
    }
    this.dependencies.onLog?.('warn', '未能结束扩展进程组，已退化为只结束主进程')
  }

  private waitForExit(child: ExtensionHostChild, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (exited: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(exited)
      }
      const timer = setTimeout(() => finish(false), timeoutMs)
      child.once?.('exit', () => finish(true))
    })
  }

  /** 投递消息事件；令牌桶是**背压边界**：扩展处理慢或消息突发时宁可丢事件并如实记日志， 也不能让主进程的监听回调被拖垮。 */
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
    this.consumeStderr(child)
  }

  /** 消费子进程 stderr；两点必须同时成立：管道始终有人读（否则子进程写满缓冲会阻塞）， 且进入日志的内容有速率与长度上限（否则一次日志风暴能把主进程拖垮）。 */
  private consumeStderr(child: ExtensionHostChild): void {
    const stream = child.stderr
    if (!stream || typeof stream.on !== 'function') return

    const onData = (chunk: Buffer | string): void => {
      try {
        const now = this.now()
        if (now - this.stderrWindow.at >= STDERR_WINDOW_MS) {
          const dropped = this.stderrWindow.dropped
          this.stderrWindow = { bytes: 0, entries: 0, dropped: 0, at: now }
          if (dropped > 0) {
            this.dependencies.onLog?.('warn', `扩展 stderr 有 ${dropped} 字节省略未记录`)
          }
        }
        const text = redactSecrets(String(chunk)).replace(/\s+/g, ' ').trim()
        if (!text) return
        const bytes = Buffer.byteLength(text, 'utf8')
        if (
          this.stderrWindow.entries >= STDERR_WINDOW_ENTRIES ||
          this.stderrWindow.bytes + bytes > STDERR_WINDOW_BYTES
        ) {
          this.stderrWindow.dropped += bytes
          return
        }
        this.stderrWindow.bytes += bytes
        this.stderrWindow.entries += 1
        this.dependencies.onLog?.('warn', `[stderr] ${text.slice(0, STDERR_MAX_CHUNK_CHARS)}`)
      } catch {
        // stderr 处理失败不能影响扩展运行。
      }
    }

    const onEnd = (): void => {
      if (this.stderrWindow.dropped > 0) {
        this.dependencies.onLog?.(
          'warn',
          `扩展 stderr 有 ${this.stderrWindow.dropped} 字节省略未记录`
        )
        this.stderrWindow.dropped = 0
      }
      stream.removeListener?.('data', onData)
      stream.removeListener?.('end', onEnd)
    }

    stream.on('data', onData)
    stream.on('end', onEnd)
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
        // Schema 不合法的动作仍然登记：界面上要能看到它，并显示具体原因，
        // 而不是让它凭空消失。
        let inputSchema: ExtensionActionInputSchema | undefined
        let schemaError: string | undefined
        if (action.inputSchema !== undefined) {
          const parsed = parseActionInputSchema(action.inputSchema)
          if (parsed.ok) inputSchema = parsed.schema
          else schemaError = parsed.reason
        }
        this.actions.set(action.id, {
          id: action.id,
          title: String(action.title || action.id).slice(0, 60),
          ...(action.description ? { description: String(action.description).slice(0, 200) } : {}),
          ...(inputSchema ? { inputSchema } : {}),
          ...(schemaError ? { schemaError } : {})
        })
        if (schemaError) {
          this.dependencies.onLog?.(
            'warn',
            `动作 ${action.id} 的参数 Schema 不可用：${schemaError}`
          )
        }
        this.dependencies.onActionsChanged?.()
        return
      }
      case 'page-result': {
        const pending = this.pendingPageRequests.get(message.requestId)
        if (!pending) return
        clearTimeout(pending.timer)
        this.pendingPageRequests.delete(message.requestId)
        if (message.ok) {
          pending.resolve(message.result)
        } else {
          pending.reject(
            new ExtensionError('ACTION_FAILED', message.error?.message || '扩展页面请求失败')
          )
        }
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
      case 'secrets.get': {
        this.requirePermission('secrets')
        if (!this.dependencies.secrets) throw new ExtensionError('CAPABILITY_UNAVAILABLE')
        return this.dependencies.secrets.get(extensionId, String(params.key ?? ''))
      }
      case 'secrets.set': {
        this.requirePermission('secrets')
        if (!this.dependencies.secrets) throw new ExtensionError('CAPABILITY_UNAVAILABLE')
        this.dependencies.secrets.set(
          extensionId,
          String(params.key ?? ''),
          String(params.value ?? '')
        )
        return { ok: true }
      }
      case 'secrets.delete': {
        this.requirePermission('secrets')
        if (!this.dependencies.secrets) throw new ExtensionError('CAPABILITY_UNAVAILABLE')
        return { removed: this.dependencies.secrets.delete(extensionId, String(params.key ?? '')) }
      }
      case 'secrets.has': {
        this.requirePermission('secrets')
        if (!this.dependencies.secrets) throw new ExtensionError('CAPABILITY_UNAVAILABLE')
        return this.dependencies.secrets.has(extensionId, String(params.key ?? ''))
      }
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
      case 'wechat.send.voice': {
        this.requirePermission('wechat.send.voice')
        if (!this.dependencies.sendVoice) throw new ExtensionError('SEND_NOT_SUPPORTED')
        return this.dependencies.sendVoice(
          extensionId,
          params as unknown as ExtensionSendVoiceRequest
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

export { killProcessTree, type ProcessTreeKillResult }

/** 真实子进程：`ELECTRON_RUN_AS_NODE` 让 Electron 二进制以 Node 模式运行。 */
export function forkExtensionHost(
  scriptPath: string
): (options: ExtensionHostSpawnOptions) => ExtensionHostChild {
  return (options) => {
    // 脱离应用安装目录作为 cwd，避免扩展及其孙进程在 Windows 更新时锁住安装目录。
    const cwd = existsSync(options.extensionDir) ? options.extensionDir : tmpdir()
    const child: ChildProcess = fork(scriptPath, [], {
      cwd,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      serialization: 'advanced',
      // POSIX 上建立独立进程组，停止时才能一次覆盖扩展派生的子进程。
      // Windows 用 taskkill /T，不需要（也不支持）detached。
      detached: process.platform !== 'win32',
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
      stderr: child.stderr,
      ...(child.pid ? { pid: child.pid } : {})
    }
  }
}
