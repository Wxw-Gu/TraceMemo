import { ILinkClient, type FetchLike } from './client'
import { ILinkPoller } from './poller'
import { normalizeInboundMessage } from './messages'
import { sendText, type SendTextResult } from './sender'
import {
  sendMediaFromPath,
  sendMediaFromSource,
  sendMediaFromUrl,
  type SendMediaOptions
} from './media'
import { runQrLogin, type QrEncoder } from './auth'
import { assertBusinessOk, ILinkError, describeError } from './errors'
import { TypingCoordinator, type TypingLease, type TypingBeginInput } from './typing'
import {
  findCredentials,
  loadAllCredentials,
  loadContextToken,
  loadCursor,
  normalizeAccountId,
  resolveAccountDirectory,
  saveContextToken,
  saveCursor,
  type HomeDirectoryResolver
} from './account-store'
import type {
  ILinkCredentials,
  WechatConnectorAccount,
  WechatConnectorPhase,
  WechatInboundMessage,
  WechatLoginEvent
} from './types'

export type ConnectorLogLevel = 'info' | 'warn' | 'error'

export interface WechatConnectorHost {
  onLog?: (level: ConnectorLogLevel, message: string) => void
  /** 一批入站消息；全部成功 resolve 后才推进游标。 */
  onMessages?: (messages: WechatInboundMessage[]) => Promise<void>
  onPhaseChange?: (phase: WechatConnectorPhase, error?: string) => void
  onLoginEvent?: (event: WechatLoginEvent) => void
}

export interface WechatConnectorServiceOptions {
  home?: HomeDirectoryResolver
  fetchImpl?: FetchLike
  qrEncoder?: QrEncoder
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
  botAgent?: string
  /** 「正在输入」心跳间隔；默认 5 秒（测试可缩短）。 */
  typingKeepaliveMs?: number
  /** typing_ticket 缓存有效期。 */
  typingTicketTtlMs?: number
  /** 定时器注入点，便于测试确定性触发 keepalive。 */
  typingSchedule?: (tick: () => void, intervalMs: number) => () => void
  /** 便于测试注入更短的长轮询超时/退避。 */
  pollOverrides?: {
    normalFailureDelayMs?: number
    repeatedFailureDelayMs?: number
    defaultTimeoutMs?: number
  }
}

export interface ConnectorSendTextInput {
  to: string
  text: string
  accountId?: string
  contextToken?: string
  signal?: AbortSignal
}

/**
 * TraceMemo 的微信 iLink 连接器，直接跑在 Electron main process 内。
 *
 * inbound 通过 onMessages 回调交给 Agent Hub，outbound 通过 sendText / sendMedia 直接调用；
 * 不依赖子进程，也不开本地 HTTP 端口。
 */
export class WechatConnectorService {
  private readonly options: WechatConnectorServiceOptions
  private readonly typing: TypingCoordinator
  private host: WechatConnectorHost = {}
  private phase: WechatConnectorPhase = 'stopped'
  private activeAccountId?: string
  private client: ILinkClient | null = null
  private pollerAbort: AbortController | null = null
  private pollerPromise: Promise<void> | null = null
  private loginAbort: AbortController | null = null
  private loginPromise: Promise<void> | null = null
  private pendingVerifyCode: ((code: string | undefined) => void) | null = null

  constructor(options: WechatConnectorServiceOptions = {}) {
    this.options = options
    this.typing = new TypingCoordinator({
      // 取票与下发都绑定"当前账号"的 client，切账号后自然走新 client。
      fetchTicket: async ({ ilinkUserId, contextToken }) => {
        const client = this.client
        if (!client) return undefined
        const response = await client.getConfig(ilinkUserId, contextToken ?? '')
        assertBusinessOk(response, 'getconfig')
        return response.typing_ticket
      },
      sendTyping: async ({ ilinkUserId, ticket, status }) => {
        const client = this.client
        if (!client) return false
        const response = await client.sendTyping(ilinkUserId, ticket, status)
        return Number(response.ret ?? 0) === 0 && Number(response.errcode ?? 0) === 0
      },
      log: (level, message) => this.log(level, message),
      ...(options.now ? { now: options.now } : {}),
      ...(options.typingKeepaliveMs !== undefined
        ? { keepaliveMs: options.typingKeepaliveMs }
        : {}),
      ...(options.typingTicketTtlMs !== undefined
        ? { ticketTtlMs: options.typingTicketTtlMs }
        : {}),
      ...(options.typingSchedule ? { schedule: options.typingSchedule } : {})
    })
  }

  /**
   * 开始「正在输入」。永不抛异常：拿不到 ticket 或服务端失败时返回空实现，
   * 调用方照常执行业务，但**仍然要**在 finally 里 stop（幂等且安全）。
   */
  beginTyping(input: TypingBeginInput): Promise<TypingLease> {
    return this.typing.begin({
      ...input,
      ...(input.accountId ? {} : this.activeAccountId ? { accountId: this.activeAccountId } : {})
    })
  }

  setHost(host: WechatConnectorHost): void {
    this.host = host
  }

  getPhase(): WechatConnectorPhase {
    return this.phase
  }

  getActiveAccountId(): string | undefined {
    return this.activeAccountId
  }

  isRunning(): boolean {
    return this.phase === 'polling'
  }

  listAccounts(): WechatConnectorAccount[] {
    return loadAllCredentials(this.options.home).map((credentials) => ({
      accountId: credentials.ilink_bot_id,
      wechatUserId: credentials.ilink_user_id
    }))
  }

  /** 主动发送时取该会话最近一次有效的 context_token。 */
  resolveContextToken(accountId: string | undefined, toUserId: string): string | undefined {
    const normalized = normalizeAccountId(accountId || this.activeAccountId || '')
    if (!normalized) return undefined
    return loadContextToken(normalized, toUserId, this.options.home)
  }

  /** 当前账号凭据所在目录（凭据 / 游标 / 会话令牌同目录）。 */
  getAccountDirectory(accountId: string): { directory: string; legacy: boolean } {
    return resolveAccountDirectory(normalizeAccountId(accountId), this.options.home)
  }

  /* ------------------------------ 登录 ------------------------------ */

  /**
   * 启动扫码登录。立即返回，进度通过 onLoginEvent 上报。
   * 重复调用会先取消进行中的登录。
   */
  startLogin(): void {
    if (this.loginPromise) return
    const controller = new AbortController()
    this.loginAbort = controller
    this.loginPromise = this.runLogin(controller).finally(() => {
      if (this.loginAbort === controller) this.loginAbort = null
      this.loginPromise = null
    })
  }

  isLoginInProgress(): boolean {
    return this.loginPromise !== null
  }

  cancelLogin(): void {
    this.pendingVerifyCode?.(undefined)
    this.pendingVerifyCode = null
    this.loginAbort?.abort()
    this.loginAbort = null
  }

  /** 手机端要求数字配对码时由宿主回填。 */
  submitVerifyCode(code: string): void {
    const resolver = this.pendingVerifyCode
    this.pendingVerifyCode = null
    resolver?.(code)
  }

  private async runLogin(controller: AbortController): Promise<void> {
    this.setPhase('starting')
    try {
      await runQrLogin({
        ...(this.options.home ? { home: this.options.home } : {}),
        ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
        ...(this.options.qrEncoder ? { qrEncoder: this.options.qrEncoder } : {}),
        ...(this.options.now ? { now: this.options.now } : {}),
        ...(this.options.sleep ? { sleep: this.options.sleep } : {}),
        signal: controller.signal,
        onEvent: (event) => this.host.onLoginEvent?.(event),
        verifyCodeProvider: () =>
          new Promise<string | undefined>((resolve) => {
            this.pendingVerifyCode = resolve
          })
      })
      this.log('info', '扫码登录成功')
      // 登录成功后的连接由宿主在收到 active 事件后调用 start()。
      this.setPhase('stopped')
    } catch (error) {
      if (error instanceof ILinkError && error.kind === 'aborted') {
        this.log('info', '扫码登录已取消')
        this.setPhase('stopped')
        return
      }
      const message = describeError(error)
      this.log('error', `扫码登录失败：${message}`)
      this.setPhase('error', message)
    }
  }

  /* --------------------------- 连接与轮询 --------------------------- */

  /** 启动某个账号的长轮询。重复调用会先停止当前账号。 */
  async start(accountId: string): Promise<void> {
    await this.stop()
    const credentials = findCredentials(normalizeAccountId(accountId), this.options.home)
    if (!credentials) {
      throw new ILinkError({ kind: 'protocol', message: `未找到账号 ${accountId} 的登录凭据` })
    }

    const normalizedId = normalizeAccountId(credentials.ilink_bot_id)
    const client = new ILinkClient({
      baseUrl: credentials.baseurl,
      botToken: credentials.bot_token,
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
      ...(this.options.botAgent ? { headers: { botAgent: this.options.botAgent } } : {})
    })
    this.client = client
    this.activeAccountId = normalizedId
    // 账号或 token 变了：旧 ticket 一律作废。
    this.typing.invalidateTickets()
    this.setPhase('starting')

    // 生命周期通知是尽力而为：失败只告警，绝不阻断消息循环。
    await this.notifyLifecycle('start')

    const controller = new AbortController()
    this.pollerAbort = controller
    const poller = new ILinkPoller({
      fetchUpdates: (getUpdatesBuf, timeoutMs) =>
        client.getUpdates(getUpdatesBuf, { timeoutMs, signal: controller.signal }),
      onMessages: async (messages) => {
        this.rememberContextTokens(normalizedId, messages)
        await this.host.onMessages?.(messages)
      },
      normalize: (raw) => normalizeInboundMessage(normalizedId, raw),
      loadCursor: () => loadCursor(normalizedId, this.options.home),
      saveCursor: (getUpdatesBuf) => saveCursor(normalizedId, getUpdatesBuf, this.options.home),
      signal: controller.signal,
      log: (level, message) => this.log(level, message),
      onStaleToken: (message) => {
        // 凭证已失效：缓存的 typing_ticket 不再可用。
        this.typing.invalidateTickets()
        this.setPhase('stale_token', message)
      },
      ...(this.options.now ? { now: this.options.now } : {}),
      ...(this.options.sleep ? { sleep: this.options.sleep } : {}),
      ...(this.options.pollOverrides?.normalFailureDelayMs !== undefined
        ? { normalFailureDelayMs: this.options.pollOverrides.normalFailureDelayMs }
        : {}),
      ...(this.options.pollOverrides?.repeatedFailureDelayMs !== undefined
        ? { repeatedFailureDelayMs: this.options.pollOverrides.repeatedFailureDelayMs }
        : {}),
      ...(this.options.pollOverrides?.defaultTimeoutMs !== undefined
        ? { defaultTimeoutMs: this.options.pollOverrides.defaultTimeoutMs }
        : {})
    })

    const pollPromise = poller
      .run()
      .catch((error) => {
        if (controller.signal.aborted) return
        const message = describeError(error)
        this.log('error', `长轮询异常退出：${message}`)
        this.setPhase('error', message)
      })
      .finally(() => {
        if (this.pollerAbort === controller) {
          this.pollerAbort = null
          this.pollerPromise = null
        }
      })
    this.pollerPromise = pollPromise

    if (this.phase !== 'stale_token' && this.phase !== 'error') this.setPhase('polling')
    this.log('info', `微信连接器已启动（账号 ${normalizedId}）`)
  }

  async stop(): Promise<void> {
    // 先收掉输入状态，避免连接器停了微信端还显示"对方正在输入"。
    this.typing.clear()
    const controller = this.pollerAbort
    const running = this.pollerPromise
    this.pollerAbort = null
    if (controller && !controller.signal.aborted) controller.abort()
    if (running) await running.catch(() => undefined)
    if (this.client) {
      // 用独立短超时发送停止通知，避免被长轮询的取消信号一起取消。
      await this.notifyLifecycle('stop')
    }
    this.client = null
    this.activeAccountId = undefined
    if (this.phase !== 'error') this.setPhase('stopped')
  }

  private async notifyLifecycle(action: 'start' | 'stop'): Promise<void> {
    const client = this.client
    if (!client || !client.hasBotToken) return
    try {
      await client.notifyLifecycle(action)
    } catch (error) {
      this.log('warn', `notify${action} 未成功（不影响消息循环）：${describeError(error)}`)
    }
  }

  private rememberContextTokens(accountId: string, messages: WechatInboundMessage[]): void {
    for (const message of messages) {
      if (!message.contextToken) continue
      try {
        saveContextToken(
          accountId,
          message.fromUserId,
          message.contextToken,
          this.options.home,
          this.options.now
        )
      } catch (error) {
        this.log('warn', `会话上下文令牌保存失败：${describeError(error)}`)
      }
    }
  }

  /* ------------------------------ 发送 ------------------------------ */

  /**
   * 主动发送时的 context_token 解析：
   * 显式传入优先，其次按「账号 + 用户」取最近一次有效值。
   */
  resolveOutgoingContextToken(input: {
    accountId?: string
    to: string
    contextToken?: string
  }): string | undefined {
    const explicit = String(input.contextToken ?? '').trim()
    if (explicit) return explicit
    return this.resolveContextToken(input.accountId, input.to)
  }

  private requireClient(accountId?: string): ILinkClient {
    if (this.phase === 'stale_token') {
      throw new ILinkError({
        kind: 'stale_token',
        message: '微信登录凭证已失效，请重新扫码登录'
      })
    }
    if (!this.client) {
      throw new ILinkError({ kind: 'protocol', message: '微信连接器尚未启动' })
    }
    if (accountId) {
      const normalized = normalizeAccountId(accountId)
      if (this.activeAccountId && normalized !== this.activeAccountId) {
        throw new ILinkError({
          kind: 'protocol',
          message: `账号 ${accountId} 当前未连接`
        })
      }
    }
    if (!this.client.hasBotToken) {
      throw new ILinkError({ kind: 'stale_token', message: '微信登录凭证不可用' })
    }
    return this.client
  }

  async sendText(input: ConnectorSendTextInput): Promise<SendTextResult> {
    const client = this.requireClient(input.accountId)
    const contextToken = this.resolveOutgoingContextToken({
      ...(input.accountId ? { accountId: input.accountId } : {}),
      to: input.to,
      ...(input.contextToken ? { contextToken: input.contextToken } : {})
    })
    return sendText(client, {
      to: input.to,
      text: input.text,
      ...(contextToken ? { contextToken } : {}),
      ...(input.signal ? { signal: input.signal } : {})
    })
  }

  async sendMedia(
    input: Omit<SendMediaOptions, 'fetchImpl'> & { accountId?: string }
  ): Promise<{ clientId: string; itemType: number }> {
    const client = this.requireClient(input.accountId)
    const contextToken = this.resolveOutgoingContextToken({
      ...(input.accountId ? { accountId: input.accountId } : {}),
      to: input.to,
      ...(input.contextToken ? { contextToken: input.contextToken } : {})
    })
    return sendMediaFromSource(client, {
      to: input.to,
      source: input.source,
      mediaKind: 'file',
      ...(contextToken ? { contextToken } : {}),
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
      ...(input.signal ? { signal: input.signal } : {})
    })
  }

  async sendMediaPath(input: {
    accountId?: string
    to: string
    filePath: string
    contextToken?: string
    signal?: AbortSignal
  }): Promise<{ clientId: string; itemType: number }> {
    const client = this.requireClient(input.accountId)
    const contextToken = this.resolveOutgoingContextToken({
      ...(input.accountId ? { accountId: input.accountId } : {}),
      to: input.to,
      ...(input.contextToken ? { contextToken: input.contextToken } : {})
    })
    return sendMediaFromPath(client, {
      to: input.to,
      filePath: input.filePath,
      ...(contextToken ? { contextToken } : {}),
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
      ...(input.signal ? { signal: input.signal } : {})
    })
  }

  async sendMediaUrl(input: {
    accountId?: string
    to: string
    mediaUrl: string
    contextToken?: string
    signal?: AbortSignal
  }): Promise<{ clientId: string; itemType: number }> {
    const client = this.requireClient(input.accountId)
    const contextToken = this.resolveOutgoingContextToken({
      ...(input.accountId ? { accountId: input.accountId } : {}),
      to: input.to,
      ...(input.contextToken ? { contextToken: input.contextToken } : {})
    })
    return sendMediaFromUrl(client, {
      to: input.to,
      mediaUrl: input.mediaUrl,
      ...(contextToken ? { contextToken } : {}),
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
      ...(input.signal ? { signal: input.signal } : {})
    })
  }

  /** 会话凭据（含 bot_token）只读暴露给需要的内部调用方；不用于日志。 */
  getCredentials(accountId?: string): ILinkCredentials | undefined {
    const id = normalizeAccountId(accountId || this.activeAccountId || '')
    if (!id) return undefined
    return findCredentials(id, this.options.home)
  }

  private setPhase(phase: WechatConnectorPhase, error?: string): void {
    this.phase = phase
    this.host.onPhaseChange?.(phase, error)
  }

  private log(level: ConnectorLogLevel, message: string): void {
    this.host.onLog?.(level, message)
  }
}

export { ILinkClient } from './client'
export { ILinkPoller } from './poller'
export * from './types'
export { normalizeInboundMessage, extractInboundText } from './messages'
export { markdownToPlainText, extractMarkdownImageUrls } from './markdown'
export { ILinkError, describeError, isILinkError } from './errors'
export {
  loadAllCredentials,
  normalizeAccountId,
  saveCredentials,
  accountsDirectory,
  legacyAccountsDirectory,
  loadCursor,
  saveCursor,
  loadContextToken,
  saveContextToken
} from './account-store'
export { sendText, createClientId } from './sender'
export { runQrLogin } from './auth'
