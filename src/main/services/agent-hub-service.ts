import { app, BrowserWindow } from 'electron'
import { ChildProcess, execFile, spawn } from 'child_process'
import { randomBytes, timingSafeEqual } from 'crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { dirname, join } from 'path'
import { promisify } from 'util'
import type {
  AgentHubActionResult,
  AgentHubLogEntry,
  AgentHubLogLevel,
  AgentHubLogSource,
  AgentHubStatus
} from '../../shared/agent-hub'
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
import { isPackagedRuntime } from '../runtime-mode'
import {
  getGroupSnapshot,
  isReady,
  listContacts,
  listMessages,
  listRecentChat,
  resolveMd5
} from './chat-service'

const execFileAsync = promisify(execFile)
const HEALTH_INTERVAL_MS = 5_000
const HUB_ADDR = '127.0.0.1:5300'
const HUB_HOST = '127.0.0.1'
const HUB_PORT = 5300
const CONNECTOR_ADDR = '127.0.0.1:18011'
const MAX_LOG_ENTRIES = 800

interface InboundMessage {
  account_id?: string
  from_user_id?: string
  message_id?: string | number
  items?: Array<{ type?: number; text?: string }>
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

function resolveBundledBinary(
  resourceSegments: string[],
  executable: string,
  packaged = isPackagedRuntime(),
  platform = process.platform,
  arch = process.arch
): string {
  const relativeSegments = [...resourceSegments, `${platform}-${arch}`, executable]
  const packagedPath = join(process.resourcesPath, 'resources', ...relativeSegments)
  const developmentPath = join(app.getAppPath(), 'resources', ...relativeSegments)
  const candidates = packaged ? [packagedPath, developmentPath] : [developmentPath, packagedPath]
  return candidates.find((candidate) => existsSync(candidate)) || candidates[0]
}

export function resolveWechatConnectorBinaryPath(
  packaged = isPackagedRuntime(),
  platform = process.platform,
  arch = process.arch
): string {
  return resolveBundledBinary(
    ['connectors', 'wechat'],
    platform === 'win32' ? 'wechat-connector.exe' : 'wechat-connector',
    packaged,
    platform,
    arch
  )
}

export class AgentHubService {
  private hubServer: Server | null = null
  private connectorChild: ChildProcess | null = null
  private loginChild: ChildProcess | null = null
  private stopping = false
  private healthTimer: NodeJS.Timeout | null = null
  private logs: AgentHubLogEntry[] = []
  private nextLogId = 1
  private readonly processedMessages = new Map<string, number>()
  private notificationRecipient: AgentHubNotificationRecipient | null = null
  private notificationRecipientLoaded = false
  private readonly inboundToken =
    process.env['AGENT_HUB_INBOUND_TOKEN'] || randomBytes(32).toString('hex')
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
    const hubStarted = await this.startHub()
    await this.initializeConnector()
    return hubStarted
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
      const response = await this.postConnectorMessage({
        accountId,
        to,
        text,
        timeoutMs: 30_000
      })
      if (response.ok) return { success: true, status: 'sent', recipient: to }
      const expired = /token|session|expired|unauthorized/i.test(response.body)
      return {
        success: false,
        status: expired ? 'token_expired' : 'send_failed',
        recipient: to,
        error: expired
          ? 'Agent Hub 微信连接器登录凭证已失效'
          : `Agent Hub 通知发送失败：${response.body || response.status}`
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
      const response = await this.postConnectorMessage({
        accountId: this.status.accountId,
        to,
        text: text || undefined,
        mediaUrl: mediaUrl || undefined,
        timeoutMs: 30_000
      })
      if (response.ok) {
        this.addLog('system', 'info', 'API 页面发送测试成功')
        return { success: true, status: 'sent', message: '发送成功' }
      }
      const expired = /token|session|expired|unauthorized/i.test(response.body)
      return {
        success: false,
        status: expired ? 'token_expired' : 'send_failed',
        message: expired
          ? '微信登录凭证已失效，请重新扫码登录'
          : `发送失败：${response.body || response.status}`
      }
    } catch (error) {
      return {
        success: false,
        status: 'connector_offline',
        message: `微信连接器不可用：${error instanceof Error ? error.message : String(error)}`
      }
    }
  }

  async startLogin(): Promise<AgentHubActionResult> {
    if (this.loginChild && this.loginChild.exitCode === null) {
      return { success: true, status: this.getStatus() }
    }
    const executable = resolveWechatConnectorBinaryPath()
    if (!existsSync(executable)) {
      return this.fail(`微信连接器不存在：${executable}`)
    }

    this.stopConnector()
    this.patchStatus({ connector: 'starting', qrCodeDataUrl: undefined, error: undefined })
    const child = spawn(executable, ['login', '--json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.loginChild = child
    this.addLog('wechat-connector', 'info', '已启动扫码登录流程')
    let stdoutBuffer = ''
    let stderr = ''

    child.stdout?.on('data', (data: Buffer) => {
      stdoutBuffer += data.toString()
      const lines = stdoutBuffer.split(/\r?\n/)
      stdoutBuffer = lines.pop() || ''
      for (const line of lines) this.handleLoginEvent(line)
    })
    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
      this.addProcessOutput('wechat-connector', 'warn', data.toString())
    })
    child.once('error', (error) => {
      this.addLog('wechat-connector', 'error', `登录进程错误：${error.message}`)
      this.patchStatus({ connector: 'error', error: error.message })
    })
    child.once('exit', (code) => {
      if (this.loginChild === child) this.loginChild = null
      if (
        code !== 0 &&
        this.status.connector !== 'online' &&
        this.status.connector !== 'disconnected' &&
        !this.stopping
      ) {
        this.patchStatus({ connector: 'error', error: stderr.trim() || `登录进程退出：${code}` })
      }
    })
    return { success: true, status: this.getStatus() }
  }

  cancelLogin(): AgentHubActionResult {
    if (this.loginChild && this.loginChild.exitCode === null) this.loginChild.kill()
    this.loginChild = null
    this.patchStatus({ connector: 'disconnected', qrCodeDataUrl: undefined, error: undefined })
    return { success: true, status: this.getStatus() }
  }

  async reconnect(): Promise<AgentHubActionResult> {
    const accounts = await this.loadAccounts()
    if (accounts.length === 0) return this.startLogin()
    this.startConnector(accounts.at(-1)!)
    return { success: true, status: this.getStatus() }
  }

  disconnect(): AgentHubActionResult {
    this.stopConnector()
    this.patchStatus({ connector: 'disconnected', error: undefined })
    return { success: true, status: this.getStatus() }
  }

  stop(): void {
    this.stopping = true
    this.clearHealthCheck()
    if (this.loginChild && this.loginChild.exitCode === null) this.loginChild.kill()
    this.loginChild = null
    this.stopConnector()
    const hubServer = this.hubServer
    this.hubServer = null
    hubServer?.close()
    this.patchStatus({ hub: 'offline' })
  }

  private async startHub(): Promise<boolean> {
    if (this.hubServer) return true
    this.patchStatus({ hub: 'starting' })
    const server = createServer((request, response) => {
      void this.handleHubRequest(request, response).catch((error) => {
        this.addLog('agent-hub', 'error', `请求处理失败：${this.errorMessage(error)}`)
        this.sendHubJson(response, 500, { error: 'internal error' })
      })
    })
    this.hubServer = server
    return new Promise((resolve) => {
      const fail = (error: Error): void => {
        if (this.hubServer === server) this.hubServer = null
        this.patchStatus({ hub: 'error', error: error.message })
        this.addLog('agent-hub', 'error', `TypeScript 服务启动失败：${error.message}`)
        resolve(false)
      }
      server.once('error', fail)
      server.listen(HUB_PORT, HUB_HOST, () => {
        server.off('error', fail)
        server.on('error', (error) => {
          this.patchStatus({ hub: 'error', error: error.message })
          this.addLog('agent-hub', 'error', error.message)
        })
        this.patchStatus({ hub: 'online', error: undefined })
        this.addLog('system', 'info', `Agent Hub TypeScript 服务已启动（${HUB_ADDR}）`)
        this.scheduleHealthCheck()
        resolve(true)
      })
    })
  }

  private async handleHubRequest(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const url = new URL(request.url || '/', `http://${HUB_ADDR}`)
    if (request.method === 'GET' && url.pathname === '/health') {
      return this.sendHubJson(response, 200, {
        status: 'ok',
        service: 'agent-hub',
        runtime: 'typescript'
      })
    }
    if (request.method !== 'POST' || url.pathname !== '/v1/connectors/wechat/inbound') {
      return this.sendHubJson(response, 404, { error: 'not found' })
    }
    if (!this.authorized(request.headers.authorization)) {
      return this.sendHubJson(response, 401, { error: 'unauthorized' })
    }

    let inbound: InboundMessage
    try {
      inbound = JSON.parse(await this.readHubBody(request)) as InboundMessage
    } catch {
      return this.sendHubJson(response, 400, { error: 'invalid request' })
    }
    const from = String(inbound.from_user_id || '').trim()
    if (!from) return this.sendHubJson(response, 400, { error: 'from_user_id is required' })
    this.rememberNotificationRecipient(inbound.account_id, from)

    const messageId = String(inbound.message_id || '')
    this.cleanProcessedMessages()
    if (messageId && this.processedMessages.has(messageId)) {
      return this.sendHubJson(response, 200, { status: 'duplicate' })
    }
    const text = (inbound.items || [])
      .filter((item) => item.type === 1 && item.text?.trim())
      .map((item) => item.text!.trim())
      .join(' ')
    this.addLog('agent-hub', 'info', `收到微信消息 message_id=${messageId || 'unknown'}`)

    // 三路边界：明确产物 → Report / 成员分析 Action；会话列表 → 确定性能力；其余 → Query Agent。
    // 注意：这里**不再**先跑意图分类 LLM，查询类问题直接进入 Query Agent（避免双重 LLM 语义系统）。
    const route = resolveInboundRoute(text)

    if (route.kind === 'report_action') {
      if (messageId) this.processedMessages.set(messageId, Date.now())
      this.addLog(
        'agent-hub',
        'info',
        `匹配群聊总结：${route.intent.group}（${route.intent.range}）`
      )
      await this.sendConnector(inbound, '收到！正在生成群聊总结，请等待…').catch((error) => {
        this.addLog('agent-hub', 'warn', `等待提示发送失败：${this.errorMessage(error)}`)
      })
      void this.generateAndSendReport(inbound, route.intent)
      return this.sendHubJson(response, 202, { status: 'generating' })
    }

    if (route.kind === 'group_member_action') {
      if (messageId) this.processedMessages.set(messageId, Date.now())
      void this.summarizeGroupMemberChat(inbound, route.intent)
      return this.sendHubJson(response, 202, { status: 'generating', mode: 'group-member-summary' })
    }

    if (route.kind === 'recent_list') {
      if (!isReady()) return this.sendHubJson(response, 502, { error: 'upstream query failed' })
      const items = listRecentChat(route.limit)
      const lines = items.map((item, index) => {
        const name = item.m_nsNickName.trim() || item.m_nsUsrName.trim()
        return `${index + 1}. ${name}（${item.type === 'group' ? '群聊' : '联系人'}）`
      })
      const reply = lines.length
        ? `最近 ${items.length} 个会话：\n${lines.join('\n')}`
        : '暂时没有找到最近会话。'
      try {
        await this.sendConnector(inbound, reply)
      } catch (error) {
        this.addLog('agent-hub', 'error', `回复发送失败：${this.errorMessage(error)}`)
        return this.sendHubJson(response, 502, { error: 'reply delivery failed' })
      }
      if (messageId) this.processedMessages.set(messageId, Date.now())
      this.addLog('agent-hub', 'info', `最近会话回复已发送（${items.length} 条）`)
      return this.sendHubJson(response, 200, { status: 'ok' })
    }

    if (!text.trim()) {
      this.addLog('agent-hub', 'info', '消息已忽略：内容为空')
      return this.sendHubJson(response, 202, { status: 'ignored', reason: 'empty text' })
    }
    if (messageId) this.processedMessages.set(messageId, Date.now())
    void this.handleKnowledgeQuery(inbound, text)
    return this.sendHubJson(response, 202, { status: 'processing', mode: 'query-agent' })
  }

  /**
   * 查询类问题（"微信里发生了什么"、普通闲聊）统一走 Query Agent Runtime。
   * 失败时不回退 Report Action，只给用户明确文案。
   */
  private async handleKnowledgeQuery(inbound: InboundMessage, text: string): Promise<void> {
    const service = this.queryAgent
    if (!service) {
      this.addLog('agent-hub', 'error', '查询大脑尚未初始化')
      await this.sendConnector(inbound, QUERY_AGENT_UNAVAILABLE_TEXT).catch(() => undefined)
      return
    }
    try {
      const conversationKey = `${String(inbound.account_id || '')}::${String(inbound.from_user_id || '')}`
      const result = await service.ask(
        { requestId: `agent-hub-${Date.now()}-${this.nextLogId}`, text },
        conversationKey
      )
      await this.sendConnector(inbound, this.formatAIReply(queryAgentReplyText(result)))
      this.addLog('agent-hub', 'info', `查询回答已发送（${result.status}）`)
    } catch (error) {
      this.addLog('agent-hub', 'error', `查询处理失败：${this.errorMessage(error)}`)
      await this.sendConnector(inbound, QUERY_AGENT_UNAVAILABLE_TEXT).catch(() => undefined)
    }
  }

  private async summarizeGroupMemberChat(
    inbound: InboundMessage,
    intent: GroupMemberChatIntent
  ): Promise<void> {
    try {
      if (!isReady()) {
        await this.sendConnector(inbound, 'TraceMemo 本地数据库尚未连接，请连接后再试。')
        return
      }
      const group = this.resolveGroup(intent.group)
      if (!group) {
        await this.sendConnector(inbound, `没有找到群聊“${intent.group}”。`)
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
        await this.sendConnector(
          inbound,
          `没有在“${group.m_nsNickName}”找到成员“${intent.member}”。`
        )
        return
      }

      const displayName =
        member.groupNickname || member.wechatNickname || member.remark || member.nickname
      await this.sendConnector(
        inbound,
        `收到！正在整理${displayName}在“${group.m_nsNickName}”的近期发言，请等待…`
      )
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
        await this.sendConnector(
          inbound,
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
      await this.sendConnector(
        inbound,
        this.formatAIReply(
          `${displayName}在“${group.m_nsNickName}”的发言总结（共 ${messages.length} 条）：\n\n${summary.data.trim().slice(0, 3500)}`
        )
      )
      this.addLog('agent-hub', 'info', `群成员发言总结已发送（${messages.length} 条）`)
    } catch (error) {
      this.addLog('agent-hub', 'error', `群成员发言总结失败：${this.errorMessage(error)}`)
      await this.sendConnector(inbound, `群成员发言总结失败：${this.errorMessage(error)}`).catch(
        () => undefined
      )
    }
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
    inbound: InboundMessage,
    intent: GroupReportIntent
  ): Promise<void> {
    try {
      const result = await generateAgentGroupReport({ group: intent.group, range: intent.range })
      if (!result.success || !result.pngPath) throw new Error(result.error || '群聊总结生成失败')
      await this.sendConnector(
        inbound,
        `已生成${result.groupName || intent.group}的群聊总结（${result.messageCount || 0} 条消息），正在发送图片。`
      )
      await this.sendConnector(inbound, undefined, result.pngPath)
      this.addLog('agent-hub', 'info', `群聊总结图片已发送：${result.groupName || intent.group}`)
    } catch (error) {
      const message = this.errorMessage(error)
      this.addLog('agent-hub', 'error', `群聊总结生成失败：${message}`)
      await this.sendConnector(inbound, `群聊总结生成失败：${message}`).catch(() => undefined)
    }
  }

  private async sendConnector(
    inbound: InboundMessage,
    text?: string,
    mediaUrl?: string
  ): Promise<void> {
    const response = await this.postConnectorMessage({
      accountId: inbound.account_id || this.status.accountId,
      to: String(inbound.from_user_id || '').trim(),
      text,
      mediaUrl,
      timeoutMs: mediaUrl ? 60_000 : 30_000
    })
    if (!response.ok) throw new Error(response.body || `HTTP ${response.status}`)
  }

  private async postConnectorMessage(input: {
    accountId?: string
    to: string
    text?: string
    mediaUrl?: string
    timeoutMs: number
  }): Promise<{ ok: boolean; status: number; body: string }> {
    const response = await fetch(`http://${CONNECTOR_ADDR}/api/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account_id: input.accountId,
        to: input.to,
        text: input.text,
        media_url: input.mediaUrl
      }),
      signal: AbortSignal.timeout(input.timeoutMs)
    })
    return { ok: response.ok, status: response.status, body: await response.text() }
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

  private authorized(header: string | undefined): boolean {
    if (!header?.startsWith('Bearer ')) return false
    const expected = Buffer.from(this.inboundToken)
    const provided = Buffer.from(header.slice(7))
    return expected.length === provided.length && timingSafeEqual(expected, provided)
  }

  private readHubBody(request: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      request.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 1024 * 1024) {
          reject(new Error('request too large'))
          request.destroy()
          return
        }
        chunks.push(chunk)
      })
      request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      request.on('error', reject)
    })
  }

  private sendHubJson(response: ServerResponse, status: number, payload: unknown): void {
    if (response.writableEnded) return
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(payload))
  }

  private cleanProcessedMessages(): void {
    const cutoff = Date.now() - 10 * 60_000
    for (const [id, timestamp] of this.processedMessages) {
      if (timestamp < cutoff) this.processedMessages.delete(id)
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  private async initializeConnector(): Promise<void> {
    this.patchStatus({ connector: 'checking' })
    try {
      const accounts = await this.loadAccounts()
      if (accounts.length === 0) {
        this.patchStatus({ connector: 'disconnected' })
        return
      }
      this.startConnector(accounts.at(-1)!)
    } catch (error) {
      this.patchStatus({
        connector: 'error',
        error: error instanceof Error ? error.message : String(error)
      })
    }
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

  private async loadAccounts(): Promise<{ accountId: string; wechatUserId: string }[]> {
    const executable = resolveWechatConnectorBinaryPath()
    if (!existsSync(executable)) throw new Error(`微信连接器不存在：${executable}`)
    const { stdout } = await execFileAsync(executable, ['accounts', '--json'], {
      windowsHide: true,
      timeout: 10_000
    })
    const parsed = JSON.parse(stdout) as {
      accounts?: { account_id: string; wechat_user_id: string }[]
    }
    return (parsed.accounts || []).map((account) => ({
      accountId: account.account_id,
      wechatUserId: account.wechat_user_id
    }))
  }

  private startConnector(account: { accountId: string; wechatUserId: string }): void {
    if (this.connectorChild && this.connectorChild.exitCode === null) return
    const executable = resolveWechatConnectorBinaryPath()
    this.patchStatus({
      connector: 'starting',
      accountId: account.accountId,
      wechatUserId: account.wechatUserId,
      qrCodeDataUrl: undefined,
      error: undefined
    })
    const child = spawn(
      executable,
      ['start', '--foreground', '--api-addr', CONNECTOR_ADDR, '--account-id', account.accountId],
      {
        env: {
          ...process.env,
          WECHAT_CONNECTOR_INBOUND_WEBHOOK_URL: `http://${HUB_ADDR}/v1/connectors/wechat/inbound`,
          WECHAT_CONNECTOR_INBOUND_WEBHOOK_TOKEN: this.inboundToken,
          WECHAT_CONNECTOR_INBOUND_WEBHOOK_ONLY: 'true'
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      }
    )
    this.connectorChild = child
    this.addLog('system', 'info', `正在启动微信连接器（账号 ${account.accountId}）`)
    child.stdout?.on('data', (data: Buffer) => this.handleConnectorOutput('info', data.toString()))
    child.stderr?.on('data', (data: Buffer) => this.handleConnectorOutput('warn', data.toString()))
    child.once('spawn', () => {
      this.addLog('system', 'info', `微信连接器已启动（PID ${child.pid}）`)
      this.patchStatus({ connector: 'online' })
    })
    child.once('error', (error) => {
      this.addLog('wechat-connector', 'error', error.message)
      this.patchStatus({ connector: 'error', error: error.message })
    })
    child.once('exit', (code) => {
      if (this.connectorChild === child) this.connectorChild = null
      this.addLog('system', code === 0 ? 'info' : 'error', `微信连接器已退出（code=${code}）`)
      if (!this.stopping && this.status.connector !== 'disconnected') {
        this.patchStatus({ connector: 'error', error: `微信连接器退出：${code}` })
      }
    })
  }

  private stopConnector(): void {
    const child = this.connectorChild
    this.connectorChild = null
    if (child && child.exitCode === null) child.kill()
  }

  private handleLoginEvent(line: string): void {
    if (!line.trim()) return
    try {
      const event = JSON.parse(line) as {
        status: string
        qr_code_data_url?: string
        account_id?: string
        wechat_user_id?: string
      }
      switch (event.status) {
        case 'qrcode':
        case 'wait':
          this.patchStatus({
            connector: 'waiting_scan',
            qrCodeDataUrl: event.qr_code_data_url || this.status.qrCodeDataUrl
          })
          break
        case 'scaned':
          this.patchStatus({ connector: 'scanned' })
          break
        case 'confirmed':
          this.patchStatus({ connector: 'starting' })
          break
        case 'expired':
          this.patchStatus({ connector: 'error', error: '二维码已过期，请重新获取' })
          break
        case 'active': {
          const account = {
            accountId: event.account_id || '',
            wechatUserId: event.wechat_user_id || ''
          }
          this.patchStatus({ ...account, connector: 'starting', qrCodeDataUrl: undefined })
          this.startConnector(account)
          break
        }
      }
    } catch (error) {
      console.warn('[AgentHub] invalid login event:', line, error)
    }
  }

  private patchStatus(patch: Partial<AgentHubStatus>): void {
    this.status = { ...this.status, ...patch, updatedAt: Date.now() }
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('agent-hub:status', this.getStatus())
    }
  }

  private addProcessOutput(
    source: AgentHubLogSource,
    level: AgentHubLogLevel,
    output: string
  ): void {
    for (const line of output.split(/\r?\n/)) {
      if (line.trim()) this.addLog(source, level, line)
    }
  }

  private handleConnectorOutput(level: AgentHubLogLevel, output: string): void {
    this.addProcessOutput('wechat-connector', level, output)
    if (/session expired/i.test(output)) {
      this.addLog('system', 'error', '当前微信机器人登录已失效，需要重新扫码登录')
      this.patchStatus({ connector: 'error', error: '当前登录已失效，请重新扫码登录' })
      this.stopConnector()
    }
  }

  private addLog(source: AgentHubLogSource, level: AgentHubLogLevel, rawMessage: string): void {
    const message = this.redactLog(rawMessage).trim()
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
      appendFileSync(
        path,
        `${new Date(entry.timestamp).toISOString()} [${source}] [${level}] ${message}\n`,
        'utf8'
      )
    } catch {
      // Do not interrupt message handling because log persistence failed.
    }
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('agent-hub:log', entry)
    }
  }

  private redactLog(message: string): string {
    return message
      .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [已隐藏]')
      .replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/gi, 'data:image/[二维码已隐藏]')
      .replace(/(token[=:\s]+)[^\s,}]+/gi, '$1[已隐藏]')
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
