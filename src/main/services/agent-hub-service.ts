import { app, BrowserWindow } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type {
  AgentHubActionResult,
  AgentHubLogEntry,
  AgentHubLogLevel,
  AgentHubLogSource,
  AgentHubStatus,
  WechatConnectorStatus
} from '../../shared/agent-hub'
import type { WechatSendErrorCode, WechatSendResult } from '../../shared/wechat-send'
import type { AppSettings } from './settings-store'
import { generateAgentGroupReport } from './agent-group-report-service'
import { AIProviderService } from './ai-provider-service'
import { QueryAgentService } from './query-agent-service'
import { AskWechatService } from './ask-wechat-service'
import {
  QUERY_AGENT_UNAVAILABLE_TEXT,
  queryAgentReplyText,
  resolveInboundRoute,
  type GroupMemberChatIntent,
  type GroupReportIntent
} from './agent-hub-routing'
import {
  getGroupSnapshot,
  isReady,
  listContacts,
  listMessages,
  listRecentChat,
  resolveMd5
} from './chat-service'
import { redactSecrets } from './log-redaction'
import type {
  AgentHubConversation as AgentHubConversationRecord,
  AgentHubConversationMessage,
  AgentHubConversationSummary,
  AgentHubMessageKind
} from '../../shared/agent-hub-conversation'
import { AgentHubConversationStore } from './agent-hub-conversation-store'
import { buildSendPreview } from '../../shared/wechat-send'
import { wechatSendGateway } from './wechat-send-gateway'
import { WechatInboundInbox, type WechatInboundInboxEntry } from './wechat-inbound-inbox'
import { extractInboundText } from './wechat-ilink/messages'
import { extractMarkdownImageUrls } from './wechat-ilink/markdown'
import type {
  WechatConnectorAccount,
  WechatConnectorPhase,
  WechatInboundItem,
  WechatInboundMessage,
  WechatLoginEvent
} from './wechat-ilink/types'

const HEALTH_INTERVAL_MS = 5_000
const MAX_LOG_ENTRIES = 800
const HANDLED_MESSAGE_TTL_MS = 10 * 60_000
const INBOUND_RETRY_DELAY_MS = 2_000
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])

/** 连接器对 Agent Hub 暴露的最小接口；测试可注入等价实现。 */
export interface AgentHubWechatConnectorPort {
  setHost(host: {
    onLog?: (level: 'info' | 'warn' | 'error', message: string) => void
    onMessages?: (messages: WechatInboundMessage[]) => Promise<void>
    onPhaseChange?: (phase: WechatConnectorPhase, error?: string) => void
    onLoginEvent?: (event: WechatLoginEvent) => void
  }): void
  listAccounts(): WechatConnectorAccount[]
  startLogin(): void
  cancelLogin(): void
  submitVerifyCode(code: string): void
  isLoginInProgress(): boolean
  start(accountId: string): Promise<void>
  stop(): Promise<void>
  getPhase(): WechatConnectorPhase
  getActiveAccountId(): string | undefined
  resolveContextToken(accountId: string | undefined, toUserId: string): string | undefined
  /** 开始微信原生「正在输入」；返回的 lease 必须 stop，且 stop 永不抛异常。 */
  beginTyping(input: {
    accountId?: string
    to: string
    contextToken?: string
  }): Promise<{ stop(): Promise<void> }>
  sendText(input: {
    to: string
    text: string
    accountId?: string
    contextToken?: string
  }): Promise<unknown>
  sendMediaPath(input: {
    to: string
    filePath: string
    accountId?: string
    contextToken?: string
  }): Promise<unknown>
  sendMediaUrl(input: {
    to: string
    mediaUrl: string
    accountId?: string
    contextToken?: string
  }): Promise<unknown>
}

export interface AgentHubSendPort {
  send(input: unknown): Promise<WechatSendResult>
}

export interface AgentHubServiceOptions {
  /** 便于测试注入独立收件箱。 */
  inbox?: WechatInboundInbox
  /** 便于测试注入独立对话记录存储。 */
  conversationStore?: AgentHubConversationStore
  /** 入站处理失败后的重试间隔。 */
  inboundRetryDelayMs?: number
}

/** 一次会话的寻址信息：发给谁、用哪个账号、回哪个会话线程。 */
interface AgentHubTarget {
  accountId?: string
  to: string
  contextToken?: string
}

interface AgentHubNotificationRecipient {
  accountId?: string
  userId: string
  updatedAt: number
}

export interface AgentHubNotificationResult {
  success: boolean
  status: 'sent' | 'recipient_unavailable' | 'connector_offline' | 'token_expired' | 'send_failed'
  recipient?: string
  error?: string
}

const agentAIProvider = new AIProviderService()

/** 把入站 item 列表压成一条可展示记录的类型与文本。 */
function describeInboundContent(items: WechatInboundItem[]): {
  kind: AgentHubMessageKind
  text: string
} {
  const text = extractInboundText(items)
  if (text) return { kind: 'text', text }
  const firstTyped = items.find((item) => item.type !== 1)
  switch (firstTyped?.type) {
    case 2:
      return { kind: 'image', text: '' }
    case 3:
      return { kind: 'voice', text: '' }
    case 4:
      return { kind: 'file', text: '' }
    case 5:
      return { kind: 'video', text: '' }
    default:
      return { kind: 'system', text: '' }
  }
}

/** 没有连接器 / typing 不可用时的空实现：调用方无需写分支。 */
const NOOP_TYPING_LEASE = { stop: async (): Promise<void> => undefined }

class AgentHubDeliveryError extends Error {
  readonly errorCode?: WechatSendErrorCode

  constructor(message: string, errorCode?: WechatSendErrorCode) {
    super(message)
    this.name = 'AgentHubDeliveryError'
    if (errorCode) this.errorCode = errorCode
  }
}

/**
 * Agent Hub。
 *
 * 入站消息由 WechatConnectorService 在进程内直接回调，出站统一走 WechatSendGateway，
 * 不经过任何本地 HTTP 桥。Query Agent / 群日报 / 成员分析 / 最近聊天 / 通知接收者
 * 等业务逻辑与 transport 无关。
 */
export class AgentHubService {
  private connector: AgentHubWechatConnectorPort | null = null
  private sendGateway: AgentHubSendPort = wechatSendGateway
  private inbox: WechatInboundInbox
  private readonly conversationStore: AgentHubConversationStore
  private pumping = false
  private stopping = false
  private readonly inboundRetryDelayMs: number
  private healthTimer: NodeJS.Timeout | null = null
  private logs: AgentHubLogEntry[] = []
  private nextLogId = 1
  private readonly recentlyHandled = new Map<string, number>()
  private notificationRecipient: AgentHubNotificationRecipient | null = null
  private notificationRecipientLoaded = false
  private status: AgentHubStatus = {
    hub: 'offline',
    connector: 'checking',
    dataApi: 'checking',
    updatedAt: Date.now()
  }

  /**
   * 查询大脑。由主进程注入**同一个** QueryAgentRuntime 实例（桌面问问微信也用它），
   * Agent Hub 只负责把微信问题送进去、把回答发回去。
   */
  private queryAgent: AskWechatService | null = null

  constructor(options: AgentHubServiceOptions = {}) {
    this.inbox =
      options.inbox ?? new WechatInboundInbox({ filePath: () => this.inboundInboxPath() })
    this.inboundRetryDelayMs = options.inboundRetryDelayMs ?? INBOUND_RETRY_DELAY_MS
    this.conversationStore =
      options.conversationStore ??
      new AgentHubConversationStore({ filePath: () => this.conversationStorePath() })
  }

  /* ------------------------------------------------------------------ */
  /* 对话记录（收发回看）                                                */
  /* ------------------------------------------------------------------ */

  listConversations(): AgentHubConversationSummary[] {
    return this.conversationStore.listSummaries()
  }

  getConversation(userId: string): AgentHubConversationRecord | null {
    return this.conversationStore.get(userId)
  }

  clearConversations(): void {
    this.conversationStore.clear()
    this.broadcastConversationCleared()
  }

  /** 注入微信 iLink 连接器（生产为 WechatConnectorService）。 */
  setWechatConnector(connector: AgentHubWechatConnectorPort): void {
    this.connector = connector
    connector.setHost({
      onLog: (level, message) => this.addLog('wechat-connector', level, message),
      onMessages: (messages) => this.handleInboundMessages(messages),
      onPhaseChange: (phase, error) => this.applyConnectorPhase(phase, error),
      onLoginEvent: (event) => this.handleLoginEvent(event)
    })
  }

  /** 注入统一发送入口；默认使用进程级 WechatSendGateway。 */
  setSendGateway(gateway: AgentHubSendPort): void {
    this.sendGateway = gateway
  }

  /**
   * 注入生产 Query Agent Runtime（桌面与微信机器人共用同一实现，避免第二套 Query 语义）。
   */
  setQueryAgentService(runtime: QueryAgentService): void {
    this.queryAgent = new AskWechatService(runtime, {
      entry: 'agent-hub',
      // Agent Hub 没有 Legacy AI Search 通道：查询失败时给出明确文案，绝不误触 Report Action。
      log: (record) =>
        this.addLog('agent-hub', record.level === 'info' ? 'info' : record.level, record.message)
    })
  }

  async start(settings: AppSettings): Promise<boolean> {
    void settings
    this.stopping = false
    this.loadNotificationRecipient()

    // Hub 现在是主进程内的服务，不再有本地 HTTP 监听端口。
    this.patchStatus({ hub: 'starting' })
    this.patchStatus({ hub: 'online', error: undefined })
    this.addLog('system', 'info', 'Agent Hub 已在主进程内启动（不再使用本地 HTTP 桥）')
    this.scheduleHealthCheck()

    await this.initializeConnector()
    this.resumePendingInbound()
    return true
  }

  getStatus(): AgentHubStatus {
    return { ...this.status }
  }

  /** The last user who sent an inbound message to this Agent Hub bot. */
  getNotificationRecipient(): string | undefined {
    this.loadNotificationRecipient()
    return this.notificationRecipient?.userId
  }

  async sendNotification(input: {
    to?: string
    text: string
  }): Promise<AgentHubNotificationResult> {
    const to = String(input.to || this.getNotificationRecipient() || '').trim()
    const text = String(input.text || '').trim()
    if (!to || !text) {
      return {
        success: false,
        status: 'recipient_unavailable',
        error: 'Agent Hub 尚未记录可靠的通知接收者'
      }
    }
    const accountId = this.notificationRecipient?.accountId || this.status.accountId
    try {
      const result = await this.deliver({ accountId, to, text })
      if (result.success) return { success: true, status: 'sent', recipient: to }
      return {
        success: false,
        status: this.mapDeliveryStatus(result),
        recipient: to,
        error: result.error || `Agent Hub 通知发送失败（${result.error_code || 'SEND_FAILED'}）`
      }
    } catch (error) {
      return {
        success: false,
        status: 'connector_offline',
        recipient: to,
        error: `Agent Hub 微信连接器不可用：${this.errorMessage(error)}`
      }
    }
  }

  getLogs(): AgentHubLogEntry[] {
    return [...this.logs]
  }

  clearLogs(): void {
    this.logs = []
    try {
      writeFileSync(this.logFilePath(), '', 'utf8')
    } catch {
      // The live log remains usable when the persistent file cannot be cleared.
    }
    this.addLog('system', 'info', '运行日志已清空')
  }

  async testSend(input: { to?: string; text?: string; mediaUrl?: string }): Promise<{
    success: boolean
    status: 'sent' | 'token_expired' | 'connector_offline' | 'invalid_request' | 'send_failed'
    message: string
  }> {
    const to = String(input.to || this.status.wechatUserId || '').trim()
    const text = String(input.text || '').trim()
    const mediaUrl = String(input.mediaUrl || '').trim()
    if (!to || (!text && !mediaUrl)) {
      return {
        success: false,
        status: 'invalid_request',
        message: '请填写接收者以及文字或图片路径'
      }
    }
    try {
      const result = await this.deliver({
        accountId: this.status.accountId,
        to,
        ...(text ? { text } : {}),
        ...(mediaUrl ? { mediaUrl } : {})
      })
      if (result.success) {
        this.addLog('system', 'info', 'API 页面发送测试成功')
        return { success: true, status: 'sent', message: '发送成功' }
      }
      return {
        success: false,
        status:
          result.error_code === 'STALE_TOKEN'
            ? 'token_expired'
            : result.error_code === 'TRANSPORT_UNAVAILABLE'
              ? 'connector_offline'
              : result.error_code === 'INVALID_REQUEST'
                ? 'invalid_request'
                : 'send_failed',
        message:
          result.error_code === 'STALE_TOKEN'
            ? '微信登录凭证已失效，请重新扫码登录'
            : `发送失败：${result.error || result.error_code || 'SEND_FAILED'}`
      }
    } catch (error) {
      return {
        success: false,
        status: 'connector_offline',
        message: `微信连接器不可用：${this.errorMessage(error)}`
      }
    }
  }

  async startLogin(): Promise<AgentHubActionResult> {
    const connector = this.connector
    if (!connector) return this.fail('微信连接器未初始化')
    if (connector.isLoginInProgress()) return { success: true, status: this.getStatus() }
    void this.stopConnector()
    this.patchStatus({ connector: 'starting', qrCodeDataUrl: undefined, error: undefined })
    this.addLog('wechat-connector', 'info', '已启动扫码登录流程')
    connector.startLogin()
    return { success: true, status: this.getStatus() }
  }

  cancelLogin(): AgentHubActionResult {
    this.connector?.cancelLogin()
    this.patchStatus({ connector: 'disconnected', qrCodeDataUrl: undefined, error: undefined })
    return { success: true, status: this.getStatus() }
  }

  /** 手机端要求数字配对码时由 UI 回填。 */
  submitLoginVerifyCode(code: string): AgentHubActionResult {
    this.connector?.submitVerifyCode(String(code || '').trim())
    return { success: true, status: this.getStatus() }
  }

  async reconnect(): Promise<AgentHubActionResult> {
    const connector = this.connector
    if (!connector) return this.fail('微信连接器未初始化')
    const accounts = this.listConnectorAccounts()
    if (accounts.length === 0) return this.startLogin()
    try {
      await connector.start(accounts[accounts.length - 1].accountId)
    } catch (error) {
      return this.fail(`重新连接失败：${this.errorMessage(error)}`)
    }
    return { success: true, status: this.getStatus() }
  }

  disconnect(): AgentHubActionResult {
    void this.stopConnector()
    this.patchStatus({ connector: 'disconnected', error: undefined })
    return { success: true, status: this.getStatus() }
  }

  stop(): void {
    this.stopping = true
    this.clearHealthCheck()
    void this.connector?.stop()
    this.patchStatus({ hub: 'offline' })
  }

  /* ------------------------------------------------------------------ */
  /* 连接器生命周期                                                      */
  /* ------------------------------------------------------------------ */

  private async initializeConnector(): Promise<void> {
    this.patchStatus({ connector: 'checking' })
    const connector = this.connector
    if (!connector) {
      this.patchStatus({ connector: 'error', error: '微信连接器未初始化' })
      return
    }
    try {
      const accounts = this.listConnectorAccounts()
      if (accounts.length === 0) {
        this.patchStatus({ connector: 'disconnected', qrCodeDataUrl: undefined })
        return
      }
      const account = accounts[accounts.length - 1]
      await connector.start(account.accountId)
      this.patchStatus({
        accountId: account.accountId,
        wechatUserId: account.wechatUserId,
        qrCodeDataUrl: undefined,
        error: undefined
      })
    } catch (error) {
      this.patchStatus({ connector: 'error', error: this.errorMessage(error) })
      this.addLog('wechat-connector', 'error', `微信连接器启动失败：${this.errorMessage(error)}`)
    }
  }

  private async stopConnector(): Promise<void> {
    try {
      await this.connector?.stop()
    } catch (error) {
      this.addLog('wechat-connector', 'warn', `停止微信连接器失败：${this.errorMessage(error)}`)
    }
  }

  private listConnectorAccounts(): WechatConnectorAccount[] {
    try {
      return this.connector?.listAccounts() ?? []
    } catch (error) {
      this.addLog('wechat-connector', 'error', `读取微信账号失败：${this.errorMessage(error)}`)
      return []
    }
  }

  private applyConnectorPhase(phase: WechatConnectorPhase, error?: string): void {
    const mapped: WechatConnectorStatus =
      phase === 'polling'
        ? 'online'
        : phase === 'stopped'
          ? 'disconnected'
          : phase === 'starting'
            ? 'starting'
            : 'error'
    this.patchStatus({
      connector: mapped,
      ...(mapped === 'online' ? { accountId: this.connector?.getActiveAccountId() } : {}),
      ...(mapped === 'error' ? { error: error || '微信连接器异常' } : { error: undefined })
    })
    if (phase === 'stale_token') {
      this.addLog('system', 'error', error || '当前微信机器人登录已失效，需要重新扫码登录')
    }
  }

  private handleLoginEvent(event: WechatLoginEvent): void {
    switch (event.status) {
      case 'qrcode':
        this.patchStatus({
          connector: 'waiting_scan',
          qrCodeDataUrl: event.qrCodeDataUrl,
          error: undefined
        })
        break
      case 'wait':
        this.patchStatus({
          connector: 'waiting_scan',
          qrCodeDataUrl: this.status.qrCodeDataUrl
        })
        break
      case 'scaned':
        this.patchStatus({ connector: 'scanned' })
        break
      case 'confirmed':
        this.patchStatus({ connector: 'starting' })
        break
      case 'need_verifycode':
        this.addLog('wechat-connector', 'warn', '微信要求输入数字配对码才能完成登录')
        this.patchStatus({ connector: 'scanned' })
        break
      case 'verify_code_blocked':
        this.addLog('wechat-connector', 'warn', '配对码多次错误，正在刷新二维码')
        break
      case 'expired':
        this.addLog('wechat-connector', 'warn', '二维码已过期，正在自动刷新')
        break
      case 'active': {
        const account = { accountId: event.accountId, wechatUserId: event.wechatUserId }
        this.patchStatus({ ...account, connector: 'starting', qrCodeDataUrl: undefined })
        this.addLog('wechat-connector', 'info', `微信账号已登录：${event.accountId}`)
        void this.connector?.start(event.accountId).catch((error) => {
          this.patchStatus({ connector: 'error', error: this.errorMessage(error) })
        })
        break
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* 入站：持久化接收 → 异步处理                                         */
  /* ------------------------------------------------------------------ */

  /**
   * 长轮询回调。**只有这里成功返回，游标才允许推进**，
   * 因此本方法只做"落盘接收"，不等待 AI 处理完成。
   */
  async handleInboundMessages(messages: WechatInboundMessage[]): Promise<void> {
    if (messages.length === 0) return
    this.cleanRecentlyHandled()
    const fresh = messages.filter((message) => !this.isRecentlyHandled(message))
    if (fresh.length === 0) return
    const accepted = this.inbox.accept(fresh)
    for (const entry of accepted) {
      this.rememberNotificationRecipient(entry.accountId, entry.fromUserId)
      this.recordInboundConversation(entry)
    }
    if (accepted.length > 0) {
      this.addLog('agent-hub', 'info', `已接收 ${accepted.length} 条微信消息`)
      this.startPump()
    }
  }

  /** 启动时补处理上次退出留下的消息。 */
  private resumePendingInbound(): void {
    const pending = this.inbox.pending()
    if (pending.length === 0) return
    this.addLog('system', 'warn', `发现 ${pending.length} 条上次未处理完的微信消息，正在补处理`)
    this.startPump()
  }

  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      for (;;) {
        if (this.stopping) return
        const entry = this.inbox.pending()[0]
        if (!entry) return
        try {
          await this.processInboxEntry(entry)
          this.inbox.complete(entry.key)
          this.markHandled(entry)
        } catch (error) {
          const { attempts, abandoned } = this.safeRecordFailure(entry.key)
          if (abandoned) {
            this.addLog(
              'agent-hub',
              'error',
              `消息处理连续失败 ${attempts} 次，已停止重试（message_id=${entry.messageId || 'unknown'}）：${this.errorMessage(error)}`
            )
            continue
          }
          this.addLog(
            'agent-hub',
            'warn',
            `消息处理失败（第 ${attempts} 次），稍后重试：${this.errorMessage(error)}`
          )
          await new Promise((resolve) => setTimeout(resolve, this.inboundRetryDelayMs))
        }
      }
    } finally {
      this.pumping = false
    }
  }

  /** 后台补处理：任何异常都必须收敛，不能变成未捕获的 promise rejection。 */
  private startPump(): void {
    void this.pump().catch((error) => {
      this.addLog('agent-hub', 'error', `入站消息队列异常：${this.errorMessage(error)}`)
    })
  }

  private safeRecordFailure(key: string): { attempts: number; abandoned: boolean } {
    try {
      return this.inbox.recordFailure(key)
    } catch (error) {
      this.addLog('agent-hub', 'error', `收件箱落盘失败：${this.errorMessage(error)}`)
      // 落盘失败时保守处理：不重复消费同一条消息，避免活锁。
      return { attempts: 0, abandoned: true }
    }
  }

  private async processInboxEntry(entry: WechatInboundInboxEntry): Promise<void> {
    const conversation: AgentHubTarget = {
      ...(entry.accountId ? { accountId: entry.accountId } : {}),
      to: entry.fromUserId,
      ...(entry.contextToken ? { contextToken: entry.contextToken } : {})
    }
    const text = extractInboundText(entry.items)
    this.addLog('agent-hub', 'info', `收到微信消息 message_id=${entry.messageId || 'unknown'}`)

    // 三路边界：明确产物 → Report / 成员分析 Action；会话列表 → 确定性能力；其余 → Query Agent。
    // 注意：这里**不再**先跑意图分类 LLM，查询类问题直接进入 Query Agent（避免双重 LLM 语义系统）。
    const route = resolveInboundRoute(text)

    if (route.kind === 'report_action') {
      this.addLog(
        'agent-hub',
        'info',
        `匹配群聊总结：${route.intent.group}（${route.intent.range}）`
      )
      await this.sendToConversation(conversation, '收到！正在生成群聊总结，请等待…').catch(
        (error) => {
          this.addLog('agent-hub', 'warn', `等待提示发送失败：${this.errorMessage(error)}`)
        }
      )
      void this.generateAndSendReport(conversation, route.intent)
      return
    }

    if (route.kind === 'group_member_action') {
      void this.summarizeGroupMemberChat(conversation, route.intent)
      return
    }

    if (route.kind === 'recent_list') {
      if (!isReady()) throw new Error('上游查询失败：本地数据库尚未连接')
      const items = listRecentChat(route.limit)
      const lines = items.map((item, index) => {
        const name = item.m_nsNickName.trim() || item.m_nsUsrName.trim()
        return `${index + 1}. ${name}（${item.type === 'group' ? '群聊' : '联系人'}）`
      })
      const reply = lines.length
        ? `最近 ${items.length} 个会话：\n${lines.join('\n')}`
        : '暂时没有找到最近会话。'
      await this.sendToConversation(conversation, reply)
      this.addLog('agent-hub', 'info', `最近会话回复已发送（${items.length} 条）`)
      return
    }

    if (!text.trim()) {
      this.addLog('agent-hub', 'info', '消息已忽略：内容为空')
      return
    }

    await this.handleKnowledgeQuery(conversation, text)
  }

  /**
   * 查询类问题（"微信里发生了什么"、普通闲聊）统一走 Query Agent Runtime。
   * 失败时不回退 Report Action，只给用户明确文案。
   */
  private async handleKnowledgeQuery(conversation: AgentHubTarget, text: string): Promise<void> {
    const service = this.queryAgent
    if (!service) {
      this.addLog('agent-hub', 'error', '查询大脑尚未初始化')
      await this.sendToConversation(conversation, QUERY_AGENT_UNAVAILABLE_TEXT)
      return
    }
    // 普通查询不发"收到"：直接用原生"正在输入"表达"在处理"。
    const typing = await this.beginTypingFor(conversation)
    try {
      const conversationKey = `${conversation.accountId || ''}::${conversation.to}`
      const result = await service.ask(
        { requestId: `agent-hub-${Date.now()}-${this.nextLogId}`, text },
        conversationKey
      )
      await this.sendToConversation(conversation, this.formatAIReply(queryAgentReplyText(result)))
      this.addLog('agent-hub', 'info', `查询回答已发送（${result.status}）`)
    } catch (error) {
      this.addLog('agent-hub', 'error', `查询处理失败：${this.errorMessage(error)}`)
      await this.sendToConversation(conversation, QUERY_AGENT_UNAVAILABLE_TEXT)
    } finally {
      // 无论成功、Provider 异常、发送失败还是超时，都必须收掉输入状态。
      await typing.stop()
    }
  }

  private async summarizeGroupMemberChat(
    conversation: AgentHubTarget,
    intent: GroupMemberChatIntent
  ): Promise<void> {
    try {
      if (!isReady()) {
        await this.sendToConversation(conversation, 'TraceMemo 本地数据库尚未连接，请连接后再试。')
        return
      }
      const group = this.resolveGroup(intent.group)
      if (!group) {
        await this.sendToConversation(conversation, `没有找到群聊“${intent.group}”。`)
        return
      }
      const snapshot = getGroupSnapshot(group.md5)
      const memberQuery = intent.member.trim().toLowerCase()
      const member = snapshot?.members.find((item) =>
        [item.groupNickname, item.wechatNickname, item.remark, item.nickname, item.wxid].some(
          (name) =>
            String(name || '')
              .trim()
              .toLowerCase() === memberQuery
        )
      )
      if (!member) {
        await this.sendToConversation(
          conversation,
          `没有在“${group.m_nsNickName}”找到成员“${intent.member}”。`
        )
        return
      }

      const displayName =
        member.groupNickname || member.wechatNickname || member.remark || member.nickname
      await this.sendToConversation(
        conversation,
        `收到！正在整理${displayName}在“${group.m_nsNickName}”的近期发言，请等待…`
      )
      // 长任务：确认语之后叠加原生"正在输入"，直到结果发出。
      const typing = await this.beginTypingFor(conversation)
      try {
        await this.summarizeGroupMemberChatBody(conversation, intent, group, member, displayName)
      } finally {
        await typing.stop()
      }
    } catch (error) {
      this.addLog('agent-hub', 'error', `群成员发言总结失败：${this.errorMessage(error)}`)
      await this.sendToConversation(
        conversation,
        `群成员发言总结失败：${this.errorMessage(error)}`
      ).catch(() => undefined)
    }
  }

  /** 群成员分析的实际计算与发送；由 summarizeGroupMemberChat 包在 typing 会话里。 */
  private async summarizeGroupMemberChatBody(
    conversation: AgentHubTarget,
    intent: GroupMemberChatIntent,
    group: NonNullable<ReturnType<AgentHubService['resolveGroup']>>,
    member: NonNullable<ReturnType<typeof getGroupSnapshot>>['members'][number],
    displayName: string
  ): Promise<void> {
    const now = new Date()
    const todayStart = Math.floor(
      new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000
    )
    const startTime =
      intent.range === 'today'
        ? todayStart
        : intent.range === 'yesterday'
          ? todayStart - 24 * 60 * 60
          : Math.floor(Date.now() / 1000) - intent.days * 24 * 60 * 60
    const endTime = intent.range === 'yesterday' ? todayStart - 1 : Math.floor(Date.now() / 1000)
    const aliases = new Set(
      [member.groupNickname, member.wechatNickname, member.remark, member.nickname]
        .map((name) =>
          String(name || '')
            .trim()
            .toLowerCase()
        )
        .filter(Boolean)
    )
    const messages = listMessages(group.md5, startTime, endTime, { limit: 10_000 })
      .filter(
        (message) =>
          String(message.senderId || '').trim() === member.wxid ||
          aliases.has(
            String(message.name || '')
              .trim()
              .toLowerCase()
          )
      )
      .slice(-1000)
    if (!messages.length) {
      await this.sendToConversation(
        conversation,
        `所选时间范围没有找到${displayName}在“${group.m_nsNickName}”的发言。`
      )
      return
    }

    const transcript = messages
      .map(
        (message) =>
          `[${message.datetime}] ${this.describeChatMessage(message.content, message.type)}`
      )
      .join('\n')
    const summary = await agentAIProvider.chat([
      {
        role: 'system',
        content:
          '你是擅长分析微信群聊的助手。严格依据提供的发言完成用户的原始要求，输出结构和侧重点由内容决定，不套固定模板。可以归纳人物特征、兴趣、表达习惯和群内角色，但必须区分事实与推测，为推测说明依据和不确定性，不得编造。使用适合微信阅读的中文。'
      },
      {
        role: 'user',
        content: `用户原始要求：${intent.goal}\n分析对象：“${displayName}”在群聊“${group.m_nsNickName}”中的发言。\n时间范围：${intent.range === 'today' ? '今天' : intent.range === 'yesterday' ? '昨天' : `最近 ${intent.days} 天`}。\n共提供 ${messages.length} 条发言。\n\n发言记录：\n${transcript}`
      }
    ])
    if (!summary.success || !summary.data?.trim()) {
      throw new Error(summary.error || 'AI 未返回总结')
    }
    await this.sendToConversation(
      conversation,
      this.formatAIReply(
        `${displayName}在“${group.m_nsNickName}”的发言总结（共 ${messages.length} 条）：\n\n${summary.data.trim().slice(0, 3500)}`
      )
    )
    this.addLog('agent-hub', 'info', `群成员发言总结已发送（${messages.length} 条）`)
  }

  private describeChatMessage(content: string, type: string): string {
    const normalized = String(content || '')
      .replace(/\s+/g, ' ')
      .trim()
    if (normalized) return normalized.length > 100 ? `${normalized.slice(0, 100)}…` : normalized
    const label = String(type || '消息').replace(/^普通文本$/, '消息')
    return `[${label}]`
  }

  private formatAIReply(content: string): string {
    return content
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]*•[ \t]*/g, '\n• ')
      .replace(/[ \t]+(?=\d+[.、][ \t])/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }

  private async generateAndSendReport(
    conversation: AgentHubTarget,
    intent: GroupReportIntent
  ): Promise<void> {
    // 日报是长任务：确认语已由路由层发出，这里叠加原生"正在输入"直到图片发完。
    const typing = await this.beginTypingFor(conversation)
    try {
      const result = await generateAgentGroupReport({ group: intent.group, range: intent.range })
      if (!result.success || !result.pngPath) throw new Error(result.error || '群聊总结生成失败')
      await this.sendToConversation(
        conversation,
        `已生成${result.groupName || intent.group}的群聊总结（${result.messageCount || 0} 条消息），正在发送图片。`
      )
      await this.sendToConversation(conversation, undefined, result.pngPath)
      this.addLog('agent-hub', 'info', `群聊总结图片已发送：${result.groupName || intent.group}`)
    } catch (error) {
      const message = this.errorMessage(error)
      this.addLog('agent-hub', 'error', `群聊总结生成失败：${message}`)
      await this.sendToConversation(conversation, `群聊总结生成失败：${message}`).catch(
        () => undefined
      )
    } finally {
      // 生成失败、图片发送失败、超时……都必须收掉"正在输入"。
      await typing.stop()
    }
  }

  /* ------------------------------------------------------------------ */
  /* 出站：统一走 WechatSendGateway                                      */
  /* ------------------------------------------------------------------ */

  /**
   * 开始「正在输入」。typing 是**非致命**能力：任何失败都退化成空实现，
   * 业务照常执行，调用方只需要在 finally 里 stop。
   */
  private async beginTypingFor(conversation: AgentHubTarget): Promise<{ stop(): Promise<void> }> {
    const connector = this.connector
    if (!connector) return NOOP_TYPING_LEASE
    try {
      return await connector.beginTyping({
        ...(conversation.accountId ? { accountId: conversation.accountId } : {}),
        to: conversation.to,
        ...(conversation.contextToken ? { contextToken: conversation.contextToken } : {})
      })
    } catch (error) {
      this.addLog('agent-hub', 'warn', `开启输入状态失败：${this.errorMessage(error)}`)
      return NOOP_TYPING_LEASE
    }
  }

  /**
   * 发送一条或多条消息到会话。
   *
   * `context_token` 来自入站消息，必须原样回传才能落到同一个会话线程；
   * 主动发送（例如定时日报）则回退到该会话最近一次有效 token。
   */
  private async sendToConversation(
    conversation: AgentHubTarget,
    text?: string,
    mediaUrl?: string
  ): Promise<void> {
    const result = await this.deliver({
      accountId: conversation.accountId,
      to: conversation.to,
      ...(conversation.contextToken ? { contextToken: conversation.contextToken } : {}),
      ...(text ? { text } : {}),
      ...(mediaUrl ? { mediaUrl } : {})
    })
    if (!result.success) {
      throw new AgentHubDeliveryError(
        result.error || `微信发送失败（${result.error_code || 'SEND_FAILED'}）`,
        result.error_code
      )
    }
  }

  /**
   * 统一投递：文本 + 文本内嵌的 Markdown 图片 + 显式媒体。
   * 每一步都经过 WechatSendGateway，因此每一步都有 Send Log。
   */
  private async deliver(input: {
    accountId?: string
    to: string
    text?: string
    mediaUrl?: string
    contextToken?: string
  }): Promise<WechatSendResult> {
    const contextToken = this.resolveOutgoingContextToken(input)
    const base = {
      ...(input.accountId ? { account_id: input.accountId } : {}),
      to: input.to,
      transport: 'ilink' as const,
      ...(contextToken ? { context_token: contextToken } : {})
    }

    let lastResult: WechatSendResult | undefined
    const text = String(input.text || '').trim()
    if (text) {
      lastResult = await this.sendOne({
        base,
        to: input.to,
        ...(input.accountId ? { accountId: input.accountId } : {}),
        type: 'text',
        msg: text
      })
      if (!lastResult.success) return lastResult

      // 文本里内嵌的图片补发为独立图片消息；单张失败不影响已发送的文本。
      for (const imageUrl of extractMarkdownImageUrls(text)) {
        const mediaResult = await this.sendOne({
          base,
          to: input.to,
          ...(input.accountId ? { accountId: input.accountId } : {}),
          type: 'image',
          msg: imageUrl
        })
        if (!mediaResult.success) {
          this.addLog(
            'agent-hub',
            'warn',
            `内嵌图片补发失败：${mediaResult.error_code || 'SEND_FAILED'}`
          )
        }
      }
    }

    const mediaUrl = String(input.mediaUrl || '').trim()
    if (mediaUrl) {
      const mediaResult = await this.sendOne({
        base,
        to: input.to,
        ...(input.accountId ? { accountId: input.accountId } : {}),
        type: this.isImageSource(mediaUrl) ? 'image' : 'file',
        msg: mediaUrl
      })
      if (!mediaResult.success) return mediaResult
      lastResult = mediaResult
    }

    if (!lastResult) {
      return {
        request_id: this.newRequestId(),
        success: false,
        status: 'failed',
        transport: 'ilink',
        duration_ms: 0,
        error_code: 'INVALID_REQUEST',
        error: '没有可发送的内容'
      }
    }
    return lastResult
  }

  /**
   * 单次发送：统一经过 WechatSendGateway，并在同一处写入对话记录。
   * 成功与失败都记账，失败带错误码，因此 UI 里能看出"这条没发出去"。
   */
  private async sendOne(input: {
    base: Record<string, unknown>
    to: string
    accountId?: string
    type: 'text' | 'image' | 'file'
    msg: string
  }): Promise<WechatSendResult> {
    const result = await this.sendGateway.send({
      request_id: this.newRequestId(),
      ...input.base,
      type: input.type,
      msg: input.msg
    })
    this.recordOutboundConversation({
      to: input.to,
      ...(input.accountId ? { accountId: input.accountId } : {}),
      type: input.type,
      msg: input.msg,
      success: result.success,
      ...(result.error_code ? { errorCode: result.error_code } : {})
    })
    return result
  }

  private isImageSource(source: string): boolean {
    const withoutQuery = source.split('?')[0].split('#')[0]
    const dotIndex = withoutQuery.lastIndexOf('.')
    if (dotIndex < 0) return false
    return IMAGE_EXTENSIONS.has(withoutQuery.slice(dotIndex).toLowerCase())
  }

  /** 显式 token 优先，其次取该会话最近一次有效 token（用于主动发送）。 */
  private resolveOutgoingContextToken(input: {
    accountId?: string
    to: string
    contextToken?: string
  }): string | undefined {
    const explicit = String(input.contextToken || '').trim()
    if (explicit) return explicit
    try {
      return this.connector?.resolveContextToken(input.accountId, input.to)
    } catch {
      return undefined
    }
  }

  private newRequestId(): string {
    return `agent-hub-${Date.now()}-${this.nextLogId++}`
  }

  private mapDeliveryStatus(
    result: WechatSendResult
  ): 'connector_offline' | 'token_expired' | 'send_failed' {
    if (result.error_code === 'TRANSPORT_UNAVAILABLE') return 'connector_offline'
    if (result.error_code === 'STALE_TOKEN') return 'token_expired'
    return 'send_failed'
  }

  /* ------------------------------------------------------------------ */
  /* 去重与日志                                                          */
  /* ------------------------------------------------------------------ */

  private handledKeyFor(message: WechatInboundMessage): string {
    return `${message.accountId}::${message.messageId}`
  }

  private isRecentlyHandled(message: WechatInboundMessage): boolean {
    if (!message.messageId) return false
    return this.recentlyHandled.has(this.handledKeyFor(message))
  }

  private markHandled(entry: WechatInboundInboxEntry): void {
    if (!entry.messageId) return
    this.recentlyHandled.set(`${entry.accountId}::${entry.messageId}`, Date.now())
  }

  private cleanRecentlyHandled(): void {
    const cutoff = Date.now() - HANDLED_MESSAGE_TTL_MS
    for (const [key, timestamp] of this.recentlyHandled) {
      if (timestamp < cutoff) this.recentlyHandled.delete(key)
    }
  }

  private resolveGroup(query: string): ReturnType<typeof resolveMd5> {
    const normalize = (value: string): string =>
      value
        .trim()
        .toLowerCase()
        .replace(/[\s，,。！？?：:、“”'‘’]/g, '')
        .replace(/(?:群聊|群)+$/g, '')
    const target = normalize(query)
    if (!target) return null

    const groups = listContacts().filter((contact) => contact.type === 'group')
    return (
      groups.find((contact) => normalize(contact.m_nsNickName) === target) ||
      groups.find((contact) => {
        const name = normalize(contact.m_nsNickName)
        return name.includes(target) || target.includes(name)
      }) ||
      null
    )
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  private loadNotificationRecipient(): void {
    if (this.notificationRecipientLoaded) return
    this.notificationRecipientLoaded = true
    try {
      const stored = JSON.parse(readFileSync(this.notificationRecipientPath(), 'utf8')) as {
        accountId?: unknown
        userId?: unknown
        updatedAt?: unknown
      }
      const userId = String(stored.userId || '').trim()
      if (userId) {
        this.notificationRecipient = {
          userId,
          accountId: String(stored.accountId || '').trim() || undefined,
          updatedAt: Number(stored.updatedAt) || Date.now()
        }
      }
    } catch {
      this.notificationRecipient = null
    }
  }

  private rememberNotificationRecipient(accountId: string | undefined, userId: string): void {
    const normalizedUserId = String(userId || '').trim()
    if (!normalizedUserId) return
    const recipient: AgentHubNotificationRecipient = {
      userId: normalizedUserId,
      accountId: String(accountId || this.status.accountId || '').trim() || undefined,
      updatedAt: Date.now()
    }
    this.notificationRecipient = recipient
    this.notificationRecipientLoaded = true
    try {
      const filePath = this.notificationRecipientPath()
      mkdirSync(dirname(filePath), { recursive: true })
      writeFileSync(filePath, JSON.stringify(recipient, null, 2), 'utf8')
    } catch (error) {
      this.addLog('agent-hub', 'warn', `通知接收者保存失败：${this.errorMessage(error)}`)
    }
  }

  private notificationRecipientPath(): string {
    return join(app.getPath('userData'), 'agent-hub', 'notification-recipient.json')
  }

  private inboundInboxPath(): string {
    return join(app.getPath('userData'), 'agent-hub', 'inbound-inbox.json')
  }

  /**
   * 对话记录文件。含完整收发正文，因此固定 0600，且永不写入日志。
   */
  private conversationStorePath(): string {
    return join(app.getPath('userData'), 'agent-hub', 'conversations.json')
  }

  /** 入站消息：落盘接收成功后立刻记入对话记录（即使后续处理失败，也确实收到过）。 */
  private recordInboundConversation(entry: WechatInboundInboxEntry): void {
    const { kind, text } = describeInboundContent(entry.items)
    const result = this.conversationStore.append({
      userId: entry.fromUserId,
      ...(entry.accountId ? { accountId: entry.accountId } : {}),
      direction: 'in',
      kind,
      text,
      ...(entry.messageId ? { messageId: entry.messageId } : {}),
      createdAt: entry.receivedAt
    })
    if (result) this.pushConversation(result.summary, result.message)
  }

  /** 出站消息：无论成功失败都记，失败会带错误码，便于在 UI 里对账。 */
  private recordOutboundConversation(input: {
    to: string
    accountId?: string
    type: 'text' | 'image' | 'voice' | 'file'
    msg: string
    success: boolean
    errorCode?: string
  }): void {
    const result = this.conversationStore.append({
      userId: input.to,
      ...(input.accountId ? { accountId: input.accountId } : {}),
      direction: 'out',
      kind: input.type === 'voice' ? 'voice' : input.type,
      text: input.type === 'text' ? input.msg : buildSendPreview(input.msg, input.type),
      status: input.success ? 'sent' : 'failed',
      ...(input.success ? {} : { errorCode: input.errorCode || 'SEND_FAILED' })
    })
    if (result) this.pushConversation(result.summary, result.message)
  }

  private pushConversation(
    summary: AgentHubConversationSummary,
    message: AgentHubConversationMessage
  ): void {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('agent-hub:conversation', { summary, message })
    }
  }

  private broadcastConversationCleared(): void {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('agent-hub:conversationsCleared')
    }
  }

  private patchStatus(patch: Partial<AgentHubStatus>): void {
    this.status = { ...this.status, ...patch, updatedAt: Date.now() }
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('agent-hub:status', this.getStatus())
    }
  }

  private addLog(source: AgentHubLogSource, level: AgentHubLogLevel, rawMessage: string): void {
    const message = redactSecrets(rawMessage).trim()
    if (!message) return
    const entry: AgentHubLogEntry = {
      id: this.nextLogId++,
      timestamp: Date.now(),
      source,
      level,
      message
    }
    this.logs.push(entry)
    if (this.logs.length > MAX_LOG_ENTRIES) this.logs.splice(0, this.logs.length - MAX_LOG_ENTRIES)
    try {
      const path = this.logFilePath()
      mkdirSync(dirname(path), { recursive: true })
      const line = `${new Date(entry.timestamp).toISOString()} [${source}] [${level}] ${message}\n`
      writeFileSync(path, line, { encoding: 'utf8', flag: 'a' })
      // 日志采用追加写入，避免每次记日志都重写整份文件。
    } catch {
      // Do not interrupt message handling because log persistence failed.
    }
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('agent-hub:log', entry)
    }
  }

  private logFilePath(): string {
    return join(app.getPath('logs'), 'agent-hub.log')
  }

  private fail(error: string): AgentHubActionResult {
    this.patchStatus({ connector: 'error', error })
    return { success: false, status: this.getStatus(), error }
  }

  private scheduleHealthCheck(): void {
    this.clearHealthCheck()
    this.healthTimer = setInterval(() => this.checkDataApi(), HEALTH_INTERVAL_MS)
    this.checkDataApi()
  }

  private checkDataApi(): void {
    const ready = isReady()
    this.patchStatus({ dataApi: 'online', databaseReady: ready })
  }

  private clearHealthCheck(): void {
    if (this.healthTimer) clearInterval(this.healthTimer)
    this.healthTimer = null
  }
}

export const agentHubService = new AgentHubService()
