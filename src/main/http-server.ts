import crypto from 'crypto'
import http, { IncomingMessage, ServerResponse, Server } from 'http'
import {
  isReady,
  listContacts,
  listMessages,
  getGroupSnapshot,
  listRecentChat,
  resolveMd5
} from './services/chat-service'
import { exportGroupReport } from './group-report-service'
import { GroupReportExportRequest } from '../shared/group-report'
import { generateAgentGroupReport } from './services/agent-group-report-service'
import { scheduledReportService } from './services/scheduled-report-service'
import { personalWechatCapabilityService } from './services/personal-wechat-capability-service'
import {
  ScheduledReportApiError,
  ScheduledReportApiService,
  type ScheduledReportApiDependencies
} from './services/scheduled-report-api-service'
import type {
  ScheduledReportApiCreateRequest,
  ScheduledReportApiUpdateRequest
} from '../shared/scheduled-report-api'
import { agentHubService } from './services/agent-hub-service'
import { safeError, safeLog, safeWarn } from './safe-log'
import { apiTokenStore } from './api-token-store'
import { HttpMediaError, readImageMedia, type HttpImageResult } from './http-media-service'

export const DEFAULT_HTTP_HOST = '127.0.0.1'
export const DEFAULT_HTTP_PORT = 6131

export interface HttpServerHandle {
  host: string
  port: number
  close(): Promise<void>
}

interface RouteContext {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  body?: unknown
}

export interface HttpServerOptions {
  tokenProvider?: () => string | null
  mediaProvider?: (messageId: string) => Promise<HttpImageResult>
  scheduledReportService?: ScheduledReportApiDependencies['service']
  scheduledReportCapabilityProvider?: ScheduledReportApiDependencies['getCapability']
  scheduledReportContactsProvider?: ScheduledReportApiDependencies['listContacts']
  scheduledReportDatabaseReadyProvider?: ScheduledReportApiDependencies['isDatabaseReady']
  scheduledReportPlatform?: NodeJS.Platform
}

type RouteHandler = (ctx: RouteContext) => void | Promise<void>

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

function isAllowedCorsOrigin(origin: string): boolean {
  if (!/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(origin)) return false
  try {
    const parsed = new URL(origin)
    if (parsed.protocol !== 'http:') return false
    if (parsed.username || parsed.password) return false
    return ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname.toLowerCase())
  } catch {
    return false
  }
}

function applyCorsHeaders(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin
  if (!origin) return true
  if (!isAllowedCorsOrigin(origin)) return false
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  return true
}

function isAuthorized(req: IncomingMessage, expectedToken: string | null): boolean {
  const header = req.headers.authorization
  const match = typeof header === 'string' ? /^Bearer ([A-Za-z0-9_-]+)$/.exec(header) : null
  if (!match || !expectedToken) return false
  const actualDigest = crypto.createHash('sha256').update(match[1], 'utf8').digest()
  const expectedDigest = crypto.createHash('sha256').update(expectedToken, 'utf8').digest()
  return crypto.timingSafeEqual(actualDigest, expectedDigest)
}

function sendUnauthorized(res: ServerResponse): void {
  sendJson(res, 401, {
    error: 'unauthorized',
    message: 'Valid API token required'
  })
}

function sendError(res: ServerResponse, status: number, message: string, extra?: unknown): void {
  sendJson(res, status, { error: message, status, ...(extra ? { details: extra } : {}) })
}

function sendBinary(res: ServerResponse, status: number, result: HttpImageResult): void {
  res.writeHead(status, {
    'Content-Type': result.mimeType,
    'Content-Length': result.buffer.length,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff'
  })
  res.end(result.buffer)
}

function sanitizeChatlogMessage(message: Record<string, unknown>): Record<string, unknown> {
  const contentData = message.contentData
  if (!contentData || typeof contentData !== 'object' || !('aeskey' in contentData)) {
    return message
  }
  const safeContentData = { ...(contentData as Record<string, unknown>) }
  delete safeContentData.aeskey
  return { ...message, contentData: safeContentData }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

function rangeToSec(input: string, endOfUnit = false): number | null {
  const m = input.match(/^(\d{4})-(\d{2})-(\d{2})(?:\/(\d{2}):(\d{2}))?$/)
  if (!m) return null
  const [, y, mo, d, hStr, miStr] = m
  const hasTime = hStr !== undefined

  let hh: number, mi: number, ss: number, ms: number
  if (hasTime) {
    hh = Number(hStr)
    mi = Number(miStr)
    ss = endOfUnit ? 59 : 0
    ms = endOfUnit ? 999 : 0
  } else if (endOfUnit) {
    hh = 23
    mi = 59
    ss = 59
    ms = 999
  } else {
    hh = 0
    mi = 0
    ss = 0
    ms = 0
  }

  const date = new Date(Number(y), Number(mo) - 1, Number(d), hh, mi, ss, ms)
  return Math.floor(date.getTime() / 1000)
}

function parseTimeRange(value: string | null): { startTime?: number; endTime?: number } {
  if (!value) return {}
  const trimmed = value.trim()
  if (!trimmed) return {}

  if (/^\d{10,13}$/.test(trimmed)) {
    const n = Number(trimmed)
    if (!Number.isFinite(n)) return {}
    return { startTime: n > 1e12 ? Math.floor(n / 1000) : Math.floor(n) }
  }

  if (trimmed.includes('~')) {
    const [a, b] = trimmed.split('~').map((s) => s.trim())
    const start = rangeToSec(a, false)
    const end = rangeToSec(b, true)
    return {
      startTime: start ?? undefined,
      endTime: end ?? undefined
    }
  }

  const start = rangeToSec(trimmed, false)
  const end = rangeToSec(trimmed, true)
  return {
    startTime: start ?? undefined,
    endTime: end ?? undefined
  }
}

function parseNumeric(value: string | null, fallback: number): number {
  if (!value) return fallback
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

const routes: Record<string, RouteHandler> = {
  '/api/v1/health': ({ res }) => {
    sendJson(res, 200, {
      ok: true,
      ready: isReady(),
      service: 'TraceMemo Reader',
      version: '1.0.0',
      timestamp: new Date().toISOString()
    })
  },

  '/api/v1/current_time': ({ res }) => {
    const now = new Date()
    sendJson(res, 200, {
      time: now.toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      timestamp: Math.floor(now.getTime() / 1000),
      localDate: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
        now.getDate()
      ).padStart(2, '0')}`
    })
  },

  '/api/v1/contact': ({ res, url }) => {
    if (!isReady()) return sendError(res, 503, 'TraceMemo 数据库未初始化')
    const filter = url.searchParams.get('filter') || undefined
    const type = url.searchParams.get('type') || undefined
    let contacts = listContacts(filter)
    if (type === 'user' || type === 'group') {
      contacts = contacts.filter((c) => c.type === type)
    }
    sendJson(res, 200, { count: contacts.length, contacts })
  },

  '/api/v1/chatroom': ({ res, url }) => {
    if (!isReady()) return sendError(res, 503, 'TraceMemo 数据库未初始化')
    const keyword = url.searchParams.get('keyword') || ''
    let groups = listContacts().filter((c) => c.type === 'group')
    if (keyword) {
      const lower = keyword.toLowerCase()
      groups = groups.filter(
        (c) =>
          c.m_nsNickName.toLowerCase().includes(lower) ||
          c.m_nsUsrName.toLowerCase().includes(lower)
      )
    }
    sendJson(res, 200, { count: groups.length, chatrooms: groups })
  },

  '/api/v1/recent_chat': ({ res, url }) => {
    if (!isReady()) return sendError(res, 503, 'TraceMemo 数据库未初始化')
    const limit = parseNumeric(url.searchParams.get('limit'), 50)
    const items = listRecentChat(limit)
    sendJson(res, 200, { count: items.length, items })
  },

  '/api/v1/chatlog': ({ res, url }) => {
    if (!isReady()) return sendError(res, 503, 'TraceMemo 数据库未初始化')
    const talker = url.searchParams.get('talker')
    if (!talker) return sendError(res, 400, '缺少必要参数 talker')

    const resolved = resolveMd5(talker)
    if (!resolved) return sendError(res, 404, `未找到会话: ${talker}`)

    const timeParam = url.searchParams.get('time')
    const startParam = url.searchParams.get('startTime')
    const endParam = url.searchParams.get('endTime')

    let startTime: number | undefined
    let endTime: number | undefined
    if (timeParam) {
      const range = parseTimeRange(timeParam)
      startTime = range.startTime
      endTime = range.endTime
    } else {
      if (startParam) {
        const r = parseTimeRange(startParam)
        startTime = r.startTime
      }
      if (endParam) {
        const r = parseTimeRange(endParam)
        endTime = r.endTime
      }
    }

    const messages = listMessages(resolved.md5, startTime, endTime)
    sendJson(res, 200, {
      contact: resolved,
      query: { talker, time: timeParam, startTime, endTime },
      count: messages.length,
      messages: messages.map((message) =>
        sanitizeChatlogMessage(message as unknown as Record<string, unknown>)
      )
    })
  },

  '/api/v1/group_snapshot': ({ res, url }) => {
    if (!isReady()) return sendError(res, 503, 'TraceMemo 数据库未初始化')
    const md5 = url.searchParams.get('md5')
    if (!md5) return sendError(res, 400, '缺少必要参数 md5')
    const snapshot = getGroupSnapshot(md5)
    if (!snapshot) return sendError(res, 404, `未找到群聊: ${md5}`)
    sendJson(res, 200, snapshot)
  },

  '/api/v1/resolve': ({ res, url }) => {
    if (!isReady()) return sendError(res, 503, 'TraceMemo 数据库未初始化')
    const q = url.searchParams.get('q')
    if (!q) return sendError(res, 400, '缺少必要参数 q')
    const contact = resolveMd5(q)
    if (!contact) return sendError(res, 404, `未匹配到联系人: ${q}`)
    sendJson(res, 200, contact)
  },

  '/api/v1/report': async ({ req, res, body }) => {
    if (req.method !== 'POST') return sendError(res, 405, '需要 POST 请求')
    if (!isReady()) return sendError(res, 503, 'TraceMemo 数据库未初始化')
    if (typeof body !== 'string' || !body.trim()) {
      return sendError(res, 400, '请求体为空,需 POST GroupReportExportRequest JSON')
    }
    let request: GroupReportExportRequest
    try {
      request = JSON.parse(body) as GroupReportExportRequest
    } catch (error) {
      return sendError(
        res,
        400,
        '请求体 JSON 解析失败',
        error instanceof Error ? error.message : String(error)
      )
    }
    if (!request?.report || !request?.metadata) {
      return sendError(res, 400, '请求体需包含 report 和 metadata 字段')
    }
    const result = await exportGroupReport(request)
    sendJson(res, result.success ? 200 : 500, result)
  },

  '/api/v1/agent/group-report': async ({ req, res, body }) => {
    if (req.method !== 'POST') return sendError(res, 405, '需要 POST 请求')
    if (!isReady()) return sendError(res, 503, 'TraceMemo 数据库未初始化')
    let request: { group?: string; range?: 'today' | 'yesterday' | '7days' }
    try {
      request = JSON.parse(typeof body === 'string' ? body : '{}')
    } catch {
      return sendError(res, 400, '请求体 JSON 解析失败')
    }
    const result = await generateAgentGroupReport({
      group: request.group || '',
      range: request.range
    })
    sendJson(res, result.success ? 200 : 400, result)
  },

  '/api/v1/agent/status': ({ res }) => {
    const status = agentHubService.getStatus()
    sendJson(res, 200, {
      ok: status.hub === 'online' && status.connector === 'online',
      hub: status.hub,
      connector: status.connector,
      dataApi: status.dataApi,
      databaseReady: status.databaseReady,
      accountId: status.accountId
    })
  },

  '/api/v1/agent/send': async ({ req, res, body }) => {
    if (req.method !== 'POST') return sendError(res, 405, '需要 POST 请求')
    let request: { to?: string; text?: string; media_url?: string }
    try {
      request = JSON.parse(typeof body === 'string' ? body : '{}')
    } catch {
      return sendError(res, 400, '请求体 JSON 解析失败')
    }
    const result = await agentHubService.testSend({
      to: request.to,
      text: request.text,
      mediaUrl: request.media_url
    })
    sendJson(res, result.success ? 200 : result.status === 'token_expired' ? 401 : 503, result)
  }
}

const SCHEDULED_REPORTS_ROUTE = '/api/v1/scheduled-reports'
const WECHAT_SEND_CAPABILITY_ROUTE = '/api/v1/wechat-personal/send-capability'

function parseJsonBody(body: unknown): unknown {
  if (typeof body !== 'string' || !body.trim()) {
    throw new ScheduledReportApiError(400, 'invalid_request', '请求体不能为空')
  }
  try {
    return JSON.parse(body)
  } catch {
    throw new ScheduledReportApiError(400, 'invalid_request', '请求体 JSON 解析失败')
  }
}

function sendScheduledError(res: ServerResponse, error: unknown): void {
  if (error instanceof ScheduledReportApiError) {
    sendJson(res, error.status, {
      error: error.code,
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {})
    })
    return
  }
  safeError('[HttpServer] scheduled report request failed:', error)
  sendJson(res, 500, {
    error: 'internal_error',
    message: '定时日报 API 执行失败'
  })
}

function createScheduledReportApi(options: HttpServerOptions): ScheduledReportApiService {
  return new ScheduledReportApiService({
    service: options.scheduledReportService || scheduledReportService,
    getCapability:
      options.scheduledReportCapabilityProvider ||
      (() => personalWechatCapabilityService.getPersonalWechatSendCapability()),
    listContacts: options.scheduledReportContactsProvider || listContacts,
    isDatabaseReady: options.scheduledReportDatabaseReadyProvider || isReady,
    platform: options.scheduledReportPlatform
  })
}

function createScheduledReportRoute(
  pathname: string,
  api: ScheduledReportApiService
): RouteHandler | undefined {
  if (pathname === WECHAT_SEND_CAPABILITY_ROUTE) {
    return async ({ req, res }) => {
      if (req.method !== 'GET') return sendError(res, 405, '需要 GET 请求')
      try {
        sendJson(res, 200, { capability: await api.getCapability() })
      } catch (error) {
        sendScheduledError(res, error)
      }
    }
  }

  if (pathname === SCHEDULED_REPORTS_ROUTE) {
    return async ({ req, res, body }) => {
      try {
        if (req.method === 'GET') {
          const tasks = await api.list()
          sendJson(res, 200, { count: tasks.length, tasks })
          return
        }
        if (req.method !== 'POST') {
          sendError(res, 405, '需要 GET 或 POST 请求')
          return
        }
        const task = await api.create(parseJsonBody(body) as ScheduledReportApiCreateRequest)
        sendJson(res, 201, { created: true, task })
      } catch (error) {
        sendScheduledError(res, error)
      }
    }
  }

  const prefix = `${SCHEDULED_REPORTS_ROUTE}/`
  if (!pathname.startsWith(prefix)) return undefined
  const segments = pathname.slice(prefix.length).split('/').filter(Boolean)
  if (!segments.length || segments.length > 2) return undefined
  let taskId: string
  try {
    taskId = decodeURIComponent(segments[0])
  } catch {
    return undefined
  }
  const action = segments[1]

  return async ({ req, res, body }) => {
    try {
      if (!action && req.method === 'GET') {
        sendJson(res, 200, { task: await api.get(taskId) })
        return
      }
      if (!action && req.method === 'PATCH') {
        const task = await api.update(
          taskId,
          parseJsonBody(body) as ScheduledReportApiUpdateRequest
        )
        sendJson(res, 200, { updated: true, task })
        return
      }
      if (!action && req.method === 'DELETE') {
        sendJson(res, 200, { deleted: true, ...(await api.delete(taskId)) })
        return
      }
      if (action === 'enable' && req.method === 'POST') {
        sendJson(res, 200, { updated: true, task: await api.setEnabled(taskId, true) })
        return
      }
      if (action === 'disable' && req.method === 'POST') {
        sendJson(res, 200, { updated: true, task: await api.setEnabled(taskId, false) })
        return
      }
      if (action === 'run' && req.method === 'POST') {
        const execution = await api.run(taskId)
        sendJson(res, 200, { success: execution.status === 'success', execution })
        return
      }
      if (action === 'executions' && req.method === 'GET') {
        const executions = await api.executions(taskId)
        sendJson(res, 200, { count: executions.length, executions })
        return
      }
      sendError(res, 405, '请求方法或定时日报操作不受支持')
    } catch (error) {
      sendScheduledError(res, error)
    }
  }
}

const MEDIA_ROUTE_PREFIX = '/api/v1/media/'

function createMediaRoute(
  mediaProvider: (messageId: string) => Promise<HttpImageResult>
): RouteHandler {
  return async ({ req, res, url }) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendError(res, 405, '需要 GET 请求')
    }
    const encodedMessageId = url.pathname.slice(MEDIA_ROUTE_PREFIX.length)
    let messageId: string
    try {
      messageId = decodeURIComponent(encodedMessageId)
    } catch {
      return sendError(res, 422, 'messageId 格式无效')
    }
    if (!messageId || messageId.includes('/') || messageId.includes('\\')) {
      return sendError(res, 422, 'messageId 格式无效')
    }
    try {
      const result = await mediaProvider(messageId)
      if (req.method === 'HEAD') {
        res.writeHead(200, {
          'Content-Type': result.mimeType,
          'Content-Length': result.buffer.length,
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff'
        })
        res.end()
        return
      }
      sendBinary(res, 200, result)
    } catch (error) {
      if (error instanceof HttpMediaError) {
        const status =
          error.code === 'NOT_READY'
            ? 503
            : error.code === 'NOT_IMAGE'
              ? 422
              : error.code === 'NOT_FOUND'
                ? 404
                : 500
        return sendError(res, status, error.message)
      }
      safeError('[HttpServer] media request failed:', error)
      return sendError(res, 500, '图片读取失败')
    }
  }
}

export function startHttpServer(
  host: string = DEFAULT_HTTP_HOST,
  port: number = DEFAULT_HTTP_PORT,
  options: HttpServerOptions = {}
): Promise<HttpServerHandle> {
  const tokenProvider = options.tokenProvider || (() => apiTokenStore.getTokenForAuthentication())
  const mediaProvider = options.mediaProvider || readImageMedia
  const scheduledReportApi = createScheduledReportApi(options)
  return new Promise((resolve, reject) => {
    const server: Server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url || '/', `http://${host}:${port}`)
        if (!applyCorsHeaders(req, res)) {
          return sendError(res, 403, 'Origin 不允许访问本地 API')
        }
        if (req.method === 'OPTIONS') {
          res.writeHead(204)
          return res.end()
        }
        const handler =
          routes[url.pathname] ||
          createScheduledReportRoute(url.pathname, scheduledReportApi) ||
          (url.pathname.startsWith(MEDIA_ROUTE_PREFIX)
            ? createMediaRoute(mediaProvider)
            : undefined)
        if (!handler) {
          return sendError(res, 404, `端点不存在: ${url.pathname}`)
        }
        if (url.pathname !== '/api/v1/health' && !isAuthorized(req, tokenProvider())) {
          return sendUnauthorized(res)
        }
        let body: string | undefined
        if (req.method && req.method !== 'GET' && req.method !== 'HEAD') {
          body = await readBody(req)
        }
        const ctx: RouteContext = { req, res, url, body }
        await handler(ctx)
      } catch (error) {
        safeError('[HttpServer] 请求处理失败:', error)
        if (!res.headersSent) {
          sendError(res, 500, error instanceof Error ? error.message : String(error))
        }
      }
    })

    server.once('error', (error: NodeJS.ErrnoException) => {
      const message =
        error.code === 'EADDRINUSE'
          ? `端口 ${port} 已被占用,请关闭占用进程或在设置中更换端口`
          : error.message
      reject(Object.assign(error, { friendlyMessage: message }))
    })
    server.listen(port, host, () => {
      server.off('error', () => undefined)
      const actualPort = (server.address() as { port: number } | null)?.port ?? port
      safeLog(`[HttpServer] Listening on http://${host}:${actualPort}`)
      resolve({
        host,
        port: actualPort,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res())
          })
      })
    })
  })
}

export interface ApiServerState {
  running: boolean
  host: string
  port: number
  error?: string
}

let singleton: HttpServerHandle | null = null
let singletonState: ApiServerState = {
  running: false,
  host: DEFAULT_HTTP_HOST,
  port: DEFAULT_HTTP_PORT
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export const apiServer = {
  isRunning(): boolean {
    return singleton !== null
  },

  getState(): ApiServerState {
    return { ...singletonState }
  },

  async start(
    host: string = DEFAULT_HTTP_HOST,
    port: number = DEFAULT_HTTP_PORT
  ): Promise<ApiServerState> {
    if (singleton) {
      return this.getState()
    }

    const token = apiTokenStore.ensureToken()
    if (!token.success) {
      singletonState = {
        running: false,
        host,
        port,
        error: token.error || 'API Token 安全存储不可用'
      }
      return { ...singletonState }
    }

    const maxAttempts = 4
    let lastError: (NodeJS.ErrnoException & { friendlyMessage?: string }) | null = null
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        singleton = await startHttpServer(host, port, {
          tokenProvider: () => apiTokenStore.getTokenForAuthentication()
        })
        singletonState = {
          running: true,
          host: singleton.host,
          port: singleton.port
        }
        safeLog(`[ApiServer] started on http://${singleton.host}:${singleton.port}`)
        return { ...singletonState }
      } catch (error) {
        lastError = error as NodeJS.ErrnoException & { friendlyMessage?: string }
        if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || attempt === maxAttempts) break
        // Brief wait to let the OS release the port (TIME_WAIT / concurrent dev session).
        await sleep(400 * attempt)
      }
    }

    const message =
      lastError?.friendlyMessage ||
      (lastError instanceof Error ? lastError.message : String(lastError)) ||
      'API 启动失败'
    singletonState = {
      running: false,
      host,
      port,
      error: message
    }
    safeError('[ApiServer] start failed:', message)
    return { ...singletonState }
  },

  async stop(): Promise<ApiServerState> {
    if (!singleton) {
      return this.getState()
    }
    try {
      await singleton.close()
    } catch (error) {
      safeWarn('[ApiServer] close failed:', error)
    }
    singleton = null
    singletonState = { ...singletonState, running: false }
    safeLog('[ApiServer] stopped')
    return { ...singletonState }
  }
}
