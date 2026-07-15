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
import { isReady, listRecentChat } from './chat-service'

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

function resolveBundledBinary(
  resourceSegments: string[],
  executable: string,
  packaged = app.isPackaged,
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
  packaged = app.isPackaged,
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

    const limit = this.matchRecentChatIntent(text)
    if (limit === null) {
      this.addLog('agent-hub', 'info', '消息已忽略：没有匹配到支持的意图')
      return this.sendHubJson(response, 202, { status: 'ignored', reason: 'no matching intent' })
    }
    if (!isReady()) return this.sendHubJson(response, 502, { error: 'upstream query failed' })
    const items = listRecentChat(limit)
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
