import { app, BrowserWindow } from 'electron'
import { ChildProcess, execFile, spawn } from 'child_process'
import { randomBytes, timingSafeEqual } from 'crypto'
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
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

interface GroupReportIntent {
  group: string
  range: 'today' | 'yesterday' | '7days'
}

interface ContactChatIntent {
  contact: string
  limit: number
  summarize: boolean
}

interface GroupMemberChatIntent {
  group: string
  member: string
  range: 'today' | 'yesterday' | '7days'
  days: number
  goal: string
}

interface NaturalLanguageResult {
  command?: string
  reply?: string
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

class AgentHubService {
  private hubServer: Server | null = null
  private connectorChild: ChildProcess | null = null
  private loginChild: ChildProcess | null = null
  private stopping = false
  private healthTimer: NodeJS.Timeout | null = null
  private logs: AgentHubLogEntry[] = []
  private nextLogId = 1
  private readonly processedMessages = new Map<string, number>()
  private readonly inboundToken =
    process.env['AGENT_HUB_INBOUND_TOKEN'] || randomBytes(32).toString('hex')
  private status: AgentHubStatus = {
    hub: 'offline',
    connector: 'checking',
    dataApi: 'checking',
    updatedAt: Date.now()
  }

  async start(settings: AppSettings): Promise<boolean> {
    void settings
    this.stopping = false
    const hubStarted = await this.startHub()
    await this.initializeConnector()
    return hubStarted
  }

  getStatus(): AgentHubStatus {
    return { ...this.status }
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
      const response = await fetch(`http://${CONNECTOR_ADDR}/api/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: this.status.accountId,
          to,
          text: text || undefined,
          media_url: mediaUrl || undefined
        }),
        signal: AbortSignal.timeout(30_000)
      })
      const body = await response.text()
      if (response.ok) {
        this.addLog('system', 'info', 'API 页面发送测试成功')
        return { success: true, status: 'sent', message: '发送成功' }
      }
      const expired = /token|session|expired|unauthorized/i.test(body)
      return {
        success: false,
        status: expired ? 'token_expired' : 'send_failed',
        message: expired
          ? '微信登录凭证已失效，请重新扫码登录'
          : `发送失败：${body || response.status}`
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

    const reportIntent = this.matchGroupReportIntent(text)

    if (reportIntent) {
      if (messageId) this.processedMessages.set(messageId, Date.now())
      this.addLog(
        'agent-hub',
        'info',
        `匹配群聊总结：${reportIntent.group}（${reportIntent.range}）`
      )
      await this.sendConnector(inbound, '收到！正在生成群聊总结，请等待…').catch((error) => {
        this.addLog('agent-hub', 'warn', `等待提示发送失败：${this.errorMessage(error)}`)
      })
      void this.generateAndSendReport(inbound, reportIntent)
      return this.sendHubJson(response, 202, { status: 'generating' })
    }

    const groupMemberIntent = this.matchGroupMemberChatIntent(text)
    if (groupMemberIntent) {
      if (messageId) this.processedMessages.set(messageId, Date.now())
      void this.summarizeGroupMemberChat(inbound, groupMemberIntent)
      return this.sendHubJson(response, 202, { status: 'generating', mode: 'group-member-summary' })
    }

    const contactChatIntent = this.matchContactChatIntent(text)
    if (contactChatIntent) {
      if (messageId) this.processedMessages.set(messageId, Date.now())
      if (contactChatIntent.summarize) {
        void this.summarizeContactChat(inbound, contactChatIntent)
        return this.sendHubJson(response, 202, { status: 'generating', mode: 'contact-summary' })
      }
      await this.replyContactChat(inbound, contactChatIntent)
      return this.sendHubJson(response, 200, { status: 'ok' })
    }

    const recentChatLimit = this.matchRecentChatIntent(text)
    if (recentChatLimit === null && text.trim()) {
      if (messageId) this.processedMessages.set(messageId, Date.now())
      void this.handleNaturalLanguage(inbound, text)
      return this.sendHubJson(response, 202, {
        status: 'processing',
        mode: 'natural-language'
      })
    }
    if (recentChatLimit === null) {
      this.addLog('agent-hub', 'info', '消息已忽略：没有匹配到支持的意图')
      return this.sendHubJson(response, 202, { status: 'ignored', reason: 'no matching intent' })
    }
    if (!isReady()) return this.sendHubJson(response, 502, { error: 'upstream query failed' })
    const items = listRecentChat(recentChatLimit)
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
    this.sendHubJson(response, 200, { status: 'ok' })
  }

  private async handleNaturalLanguage(inbound: InboundMessage, text: string): Promise<void> {
    try {
      const result = await this.resolveNaturalLanguage(text)
      if (result.reply) {
        await this.sendConnector(inbound, this.formatAIReply(result.reply))
        this.addLog('agent-hub', 'info', '自然语言回复已发送')
        return
      }
      if (!result.command) {
        await this.sendConnector(inbound, '暂时没有理解你的意思，可以换一种说法再试。')
        return
      }

      this.addLog('agent-hub', 'info', `自然语言已理解为：${result.command}`)
      const reportIntent = this.matchGroupReportIntent(result.command)
      if (reportIntent) {
        await this.sendConnector(inbound, '收到！正在生成群聊总结，请等待…').catch(() => undefined)
        await this.generateAndSendReport(inbound, reportIntent)
        return
      }

      const groupMemberIntent = this.matchGroupMemberChatIntent(result.command)
      if (groupMemberIntent) {
        await this.summarizeGroupMemberChat(inbound, groupMemberIntent)
        return
      }

      const contactIntent = this.matchContactChatIntent(result.command)
      if (contactIntent) {
        if (contactIntent.summarize) await this.summarizeContactChat(inbound, contactIntent)
        else await this.replyContactChat(inbound, contactIntent)
        return
      }

      const recentLimit = this.matchRecentChatIntent(result.command)
      if (recentLimit !== null) {
        await this.replyRecentChats(inbound, recentLimit)
        return
      }
      await this.sendConnector(inbound, '暂时没有理解你的意思，可以换一种说法再试。')
    } catch (error) {
      this.addLog('agent-hub', 'error', `自然语言处理失败：${this.errorMessage(error)}`)
      await this.sendConnector(inbound, `处理失败：${this.errorMessage(error)}`).catch(
        () => undefined
      )
    }
  }

  private async replyRecentChats(inbound: InboundMessage, limit: number): Promise<void> {
    if (!isReady()) {
      await this.sendConnector(inbound, 'TraceMemo 本地数据库尚未连接，请连接后再试。')
      return
    }
    const items = listRecentChat(limit)
    const lines = items.map((item, index) => {
      const name = item.m_nsNickName.trim() || item.m_nsUsrName.trim()
      return `${index + 1}. ${name}（${item.type === 'group' ? '群聊' : '联系人'}）`
    })
    await this.sendConnector(
      inbound,
      lines.length ? `最近 ${items.length} 个会话：\n${lines.join('\n')}` : '暂时没有找到最近会话。'
    )
    this.addLog('agent-hub', 'info', `最近会话回复已发送（${items.length} 条）`)
  }

  private async resolveNaturalLanguage(text: string): Promise<NaturalLanguageResult> {
    const result = await agentAIProvider.chat([
      {
        role: 'system',
        content: `你是 TraceMemo 微信机器人的意图理解器。只能输出一行 JSON，不要 Markdown。
支持的工具：
1. recent：查看最近会话，参数 limit 为 1-20。
2. contact：查看我与某个联系人的最近聊天，参数 contact 和 limit。
3. report：生成某个群的群聊总结图片，参数 group 和 range（today、yesterday、7days）。
4. group_member：分析某个群里某位成员的发言，参数 group、member、range（today、yesterday、7days）、days（1-30）和 goal（保留用户希望总结、研究人物、提取观点等完整目标）。只要用户同时提到群聊和群成员，应优先使用 group_member，不能识别成 contact。
5. chat：不需要工具的普通对话，reply 用简洁中文直接回答。
输出格式：{"type":"recent|contact|report|group_member|chat","limit":5,"contact":"","group":"","member":"","range":"today","days":3,"goal":"","reply":""}
不要声称已经读取未调用的聊天记录，不要执行电脑控制、文件操作、付款或发送给其他联系人。`
      },
      { role: 'user', content: text.slice(0, 1000) }
    ])
    if (!result.success || !result.data) {
      this.addLog('agent-hub', 'warn', `自然语言理解不可用：${result.error || 'AI 未返回内容'}`)
      return {}
    }

    try {
      const json = result.data.match(/\{[\s\S]*\}/)?.[0]
      if (!json) return {}
      const parsed = JSON.parse(json) as Record<string, unknown>
      const limit = Math.max(1, Math.min(20, Number(parsed['limit']) || 5))
      if (parsed['type'] === 'recent') return { command: `最近${limit}条消息` }
      if (parsed['type'] === 'contact' && String(parsed['contact'] || '').trim()) {
        return { command: `我和${String(parsed['contact']).trim()}最近${limit}条聊了什么` }
      }
      if (parsed['type'] === 'report' && String(parsed['group'] || '').trim()) {
        const range =
          parsed['range'] === '7days'
            ? '最近7天'
            : parsed['range'] === 'yesterday'
              ? '昨天'
              : '今天'
        return { command: `生成${String(parsed['group']).trim()}${range}的群聊总结图片` }
      }
      if (
        parsed['type'] === 'group_member' &&
        String(parsed['group'] || '').trim() &&
        String(parsed['member'] || '').trim()
      ) {
        const range =
          parsed['range'] === 'yesterday'
            ? '昨天'
            : parsed['range'] === 'today'
              ? '今天'
              : '最近7天'
        const group = String(parsed['group'] || '')
          .trim()
          .replace(/(?:群聊|群)+$/g, '')
        const days = Math.max(1, Math.min(30, Number(parsed['days']) || 7))
        const goal = String(parsed['goal'] || '总结发言').trim()
        return {
          command: `看看${group}群里${String(parsed['member']).trim()}${range === '最近7天' ? `最近${days}天` : range}说了什么，${goal}`
        }
      }
      if (parsed['type'] === 'chat') {
        const reply = String(parsed['reply'] || '').trim()
        return reply ? { reply: reply.slice(0, 1500) } : {}
      }
    } catch (error) {
      this.addLog('agent-hub', 'warn', `自然语言结果解析失败：${this.errorMessage(error)}`)
    }
    return {}
  }

  private async replyContactChat(
    inbound: InboundMessage,
    intent: ContactChatIntent
  ): Promise<void> {
    if (!isReady()) {
      await this.sendConnector(inbound, 'TraceMemo 本地数据库尚未连接，请连接后再试。')
      return
    }

    const contact = resolveMd5(intent.contact)
    if (!contact || contact.type !== 'user') {
      this.addLog('agent-hub', 'info', `没有匹配到联系人：${intent.contact}`)
      await this.sendConnector(inbound, `没有找到联系人“${intent.contact}”。`)
      return
    }

    this.addLog(
      'agent-hub',
      'info',
      `匹配联系人聊天查询：${contact.m_nsNickName}（最近 ${intent.limit} 条）`
    )
    const messages = listMessages(contact.md5, undefined, undefined, { limit: intent.limit })
    const recent = messages.slice(-intent.limit)
    const lines = recent.map((message) => {
      const speaker = message.isSender ? '我' : contact.m_nsNickName
      const content = this.describeChatMessage(message.content, message.type)
      return `${speaker}：${content}`
    })
    const reply = lines.length
      ? `我和${contact.m_nsNickName}最近聊了这些：\n${lines.join('\n')}`
      : `暂时没有找到和${contact.m_nsNickName}的聊天记录。`
    await this.sendConnector(inbound, reply)
    this.addLog('agent-hub', 'info', `联系人聊天回复已发送（${recent.length} 条）`)
  }

  private async summarizeContactChat(
    inbound: InboundMessage,
    intent: ContactChatIntent
  ): Promise<void> {
    try {
      if (!isReady()) {
        await this.sendConnector(inbound, 'TraceMemo 本地数据库尚未连接，请连接后再试。')
        return
      }
      const contact = resolveMd5(intent.contact)
      if (!contact || contact.type !== 'user') {
        await this.sendConnector(inbound, `没有找到联系人“${intent.contact}”。`)
        return
      }

      await this.sendConnector(
        inbound,
        `收到！正在整理和${contact.m_nsNickName}的近期聊天，请等待…`
      )
      const endTime = Math.floor(Date.now() / 1000)
      const startTime = endTime - 7 * 24 * 60 * 60
      const messages = listMessages(contact.md5, startTime, endTime, { limit: 300 }).slice(-300)
      if (!messages.length) {
        await this.sendConnector(inbound, `最近 7 天没有找到和${contact.m_nsNickName}的聊天记录。`)
        return
      }

      const transcript = messages
        .map((message) => {
          const speaker = message.isSender ? '我' : contact.m_nsNickName
          return `[${message.datetime}] ${speaker}：${this.describeChatMessage(message.content, message.type)}`
        })
        .join('\n')
      const summary = await agentAIProvider.chat([
        {
          role: 'system',
          content:
            '你是私人聊天记录总结助手。仅根据提供的记录总结，不编造。按日期或主题整理关键进展、双方观点、决定、待办和未解决问题；忽略无意义表情，保留重要数字与事实。使用适合微信阅读的简洁中文。'
        },
        {
          role: 'user',
          content: `请总结我和“${contact.m_nsNickName}”最近 7 天聊了什么。\n\n聊天记录：\n${transcript}`
        }
      ])
      if (!summary.success || !summary.data?.trim()) {
        throw new Error(summary.error || 'AI 未返回总结')
      }
      await this.sendConnector(
        inbound,
        this.formatAIReply(
          `和${contact.m_nsNickName}最近聊天总结（近 7 天，共 ${messages.length} 条）：\n\n${summary.data.trim().slice(0, 3500)}`
        )
      )
      this.addLog('agent-hub', 'info', `联系人聊天总结已发送（${messages.length} 条）`)
    } catch (error) {
      this.addLog('agent-hub', 'error', `联系人聊天总结失败：${this.errorMessage(error)}`)
      await this.sendConnector(inbound, `聊天总结失败：${this.errorMessage(error)}`).catch(
        () => undefined
      )
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
    const response = await fetch(`http://${CONNECTOR_ADDR}/api/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account_id: inbound.account_id,
        to: inbound.from_user_id,
        text,
        media_url: mediaUrl
      }),
      signal: AbortSignal.timeout(mediaUrl ? 60_000 : 30_000)
    })
    if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`)
  }

  private matchRecentChatIntent(text: string): number | null {
    const normalized = text.replace(/\s+/g, '')
    if (!normalized.includes('最近') || !/(消息|会话|聊天)/.test(normalized)) return null
    const limit = Number(normalized.match(/\d{1,2}/)?.[0] || 5)
    return Math.max(1, Math.min(20, limit))
  }

  private matchContactChatIntent(text: string): ContactChatIntent | null {
    const normalized = text.replace(/\s+/g, '').replace(/[，。！？?：:]/g, '')
    if (!normalized.includes('最近') || !/(聊|消息|会话)/.test(normalized)) return null

    const patterns = [
      /(?:看一下|看看|查一下|查询)?我和(.+?)最近(?:\d{1,2}条)?(?:聊了什么|聊什么|的聊天|的消息|聊天|消息)/,
      /(?:看一下|看看|查一下|查询)?(?:我)?最近(?:\d{1,2}条)?和(.+?)(?:聊了什么|聊什么|的聊天|的消息|聊天|消息)/,
      /(?:看一下|看看|查一下|查询)?和(.+?)最近(?:\d{1,2}条)?(?:聊了什么|聊什么|的聊天|的消息|聊天|消息)/
    ]
    const contact = patterns
      .map((pattern) => normalized.match(pattern)?.[1]?.trim())
      .find((value): value is string => Boolean(value))
    if (!contact) return null

    const limit = Number(normalized.match(/最近(\d{1,2})条/)?.[1] || 10)
    const summarize = /(聊了什么|聊什么|说了什么|谈了什么|总结)/.test(normalized)
    return { contact, limit: Math.max(1, Math.min(20, limit)), summarize }
  }

  private matchGroupMemberChatIntent(text: string): GroupMemberChatIntent | null {
    const normalized = text.trim().replace(/[，。！？?：:]/g, '')
    const timePattern = '(今天|今日|昨天|昨日|最近\\d{1,2}天|近\\d{1,2}天|最近|近来|这几天)'
    const actionPattern = '(?:说了什么|聊了什么|发言|说过什么|都聊什么|都说什么|干了什么)'
    const patterns = [
      new RegExp(
        `(?:看一下|看看|看下|查一下|总结一下)?(.+?群(?:聊)?)[\\s，,]+(.+?)${timePattern}${actionPattern}`
      ),
      new RegExp(
        `(?:看一下|看看|看下|查一下|总结一下)?(.+?群(?:聊)?)(?:里|中的)(.+?)${timePattern}${actionPattern}`
      )
    ]
    for (const pattern of patterns) {
      const match = normalized.match(pattern)
      if (match?.[1]?.trim() && match[2]?.trim()) {
        const range = /昨天|昨日/.test(match[3] || '')
          ? 'yesterday'
          : /今天|今日/.test(match[3] || '')
            ? 'today'
            : '7days'
        const days = Math.max(1, Math.min(30, Number((match[3] || '').match(/\d{1,2}/)?.[0]) || 7))
        return {
          group: match[1].trim(),
          member: match[2].trim(),
          range,
          days,
          goal: normalized
        }
      }
    }
    return null
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

  private matchGroupReportIntent(text: string): GroupReportIntent | null {
    const normalized = text.trim()
    if (!normalized.includes('群') || !/(总结|日报|报告)/.test(normalized)) return null
    const range = /(7天|七天|一周)/.test(normalized)
      ? '7days'
      : /(昨天|昨日)/.test(normalized)
        ? 'yesterday'
        : 'today'
    const group = normalized
      .replace(
        /请|帮我|生成|做一份|做个|今天的|今日的|今天|今日|昨天的|昨日的|昨天|昨日|最近7天的|最近七天的|最近7天|最近七天|近7天的|近七天的|近7天|近七天|消息|聊天记录|聊天|群聊总结|群总结|群日报|群报告|总结|日报|报告|图片|长图/g,
        ''
      )
      .replace(/[，。！？?：:]/g, '')
      .trim()
      .replace(/成$/, '')
      .replace(/群$/, '')
      .trim()
    return group ? { group, range } : null
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
