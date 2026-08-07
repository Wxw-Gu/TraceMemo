import http from 'http'
import { apiServer } from '../http-server'
import { apiTokenStore } from '../api-token-store'
import {
  LOCAL_API_ENDPOINTS,
  type LocalApiEndpointId,
  type LocalApiTestRequest,
  type LocalApiTestResponse
} from '../../shared/local-api-test'

const REQUEST_TIMEOUT_MS = 10_000
const GROUP_REPORT_TIMEOUT_MS = 180_000
const MAX_BODY_SIZE = 512 * 1024

function isEndpointId(value: unknown): value is LocalApiEndpointId {
  return typeof value === 'string' && value in LOCAL_API_ENDPOINTS
}

function requestHost(host: string): string {
  if (host === '0.0.0.0') return '127.0.0.1'
  if (host === '::') return '::1'
  return host
}

function invalidResponse(message: string): LocalApiTestResponse {
  return {
    ok: false,
    method: 'GET',
    path: '',
    url: '',
    durationMs: 0,
    responseSize: 0,
    errorCode: 'INVALID_REQUEST',
    error: message
  }
}

function parseBody(bodyText: string, contentType?: string): { json?: unknown; bodyText?: string } {
  if (contentType?.includes('application/json')) {
    try {
      return { json: JSON.parse(bodyText) }
    } catch {
      // Keep malformed responses readable to the tester.
    }
  }
  return { bodyText }
}

export function buildLocalApiCurlCommand(payload: unknown): {
  success: boolean
  command?: string
  error?: string
} {
  if (!payload || typeof payload !== 'object') return { success: false, error: '请求格式无效' }
  const { endpointId, query = {}, body = '' } = payload as Partial<LocalApiTestRequest>
  if (!isEndpointId(endpointId)) return { success: false, error: '不允许访问该 API 端点' }
  if (!query || typeof query !== 'object' || Array.isArray(query))
    return { success: false, error: '查询参数格式无效' }
  if (typeof body !== 'string' || Buffer.byteLength(body) > MAX_BODY_SIZE)
    return { success: false, error: '请求体格式无效' }

  const endpoint = LOCAL_API_ENDPOINTS[endpointId]
  const entries = Object.entries(query)
  if (
    entries.some(
      ([key, value]) => !endpoint.queryKeys.includes(key as never) || typeof value !== 'string'
    )
  ) {
    return { success: false, error: '查询参数不属于当前端点' }
  }
  const service = apiServer.getState()
  const targetHost = requestHost(service.host)
  const hostPart = targetHost.includes(':') ? `[${targetHost}]` : targetHost
  const url = new URL(endpoint.path, `http://${hostPart}:${service.port}`)
  entries.forEach(([key, value]) => {
    if (value.trim()) url.searchParams.set(key, value.trim())
  })
  const token = endpointId === 'health' ? null : apiTokenStore.getTokenForAuthentication()
  if (endpointId !== 'health' && !token) {
    return { success: false, error: 'API Token 安全存储不可用，请在 API Center 检查 Token 状态' }
  }
  const authHeader = token ? ` -H 'Authorization: Bearer ${token}'` : ''
  const command =
    endpoint.method === 'POST'
      ? `curl -X POST '${url.toString()}'${authHeader} -H 'Content-Type: application/json' -d '${body.replaceAll("'", "\\'")}'`
      : `curl '${url.toString()}'${authHeader}`
  return { success: true, command }
}

export async function testLocalApiRequest(payload: unknown): Promise<LocalApiTestResponse> {
  if (!payload || typeof payload !== 'object') return invalidResponse('请求格式无效')
  const { endpointId, query = {}, body = '' } = payload as Partial<LocalApiTestRequest>
  if (!isEndpointId(endpointId)) return invalidResponse('不允许访问该 API 端点')
  if (!query || typeof query !== 'object' || Array.isArray(query))
    return invalidResponse('查询参数格式无效')
  if (typeof body !== 'string' || Buffer.byteLength(body) > MAX_BODY_SIZE)
    return invalidResponse('请求体格式无效')

  const endpoint = LOCAL_API_ENDPOINTS[endpointId]
  const entries = Object.entries(query)
  if (
    entries.some(
      ([key, value]) => !endpoint.queryKeys.includes(key as never) || typeof value !== 'string'
    )
  ) {
    return invalidResponse('查询参数不属于当前端点')
  }

  const service = apiServer.getState()
  const targetHost = requestHost(service.host)
  const targetPort = service.port
  const hostPart = targetHost.includes(':') ? `[${targetHost}]` : targetHost
  const url = new URL(endpoint.path, `http://${hostPart}:${targetPort}`)
  entries.forEach(([key, value]) => {
    if (value.trim()) url.searchParams.set(key, value.trim())
  })

  if (!service.running) {
    return {
      ok: false,
      method: endpoint.method,
      path: endpoint.path,
      url: url.toString(),
      durationMs: 0,
      responseSize: 0,
      errorCode: 'API_NOT_RUNNING',
      error: '请先启动本地 API 服务'
    }
  }

  return new Promise((resolve) => {
    const startedAt = Date.now()
    let settled = false
    const finish = (result: LocalApiTestResponse): void => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const token = endpointId === 'health' ? null : apiTokenStore.getTokenForAuthentication()
    if (endpointId !== 'health' && !token) {
      return finish({
        ok: false,
        method: endpoint.method,
        path: endpoint.path,
        url: url.toString(),
        durationMs: Date.now() - startedAt,
        responseSize: 0,
        errorCode: 'TOKEN_UNAVAILABLE',
        error: 'API Token 安全存储不可用，请在 API Center 检查 Token 状态'
      })
    }
    const headers: Record<string, string> = {}
    if (endpoint.method === 'POST') headers['Content-Type'] = 'application/json'
    if (token) headers.Authorization = `Bearer ${token}`
    const request = http.request(
      url,
      {
        method: endpoint.method,
        headers
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          const bodyText = Buffer.concat(chunks).toString('utf-8')
          const contentType = Array.isArray(response.headers['content-type'])
            ? response.headers['content-type'][0]
            : response.headers['content-type']
          finish({
            ok: true,
            method: endpoint.method,
            path: endpoint.path,
            url: url.toString(),
            status: response.statusCode || 0,
            statusText: response.statusMessage || '',
            durationMs: Date.now() - startedAt,
            responseSize: Buffer.byteLength(bodyText),
            contentType,
            ...parseBody(bodyText, contentType)
          })
        })
      }
    )
    const timeoutMs =
      endpointId === 'agent-group-report' ? GROUP_REPORT_TIMEOUT_MS : REQUEST_TIMEOUT_MS
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('请求超时'))
      finish({
        ok: false,
        method: endpoint.method,
        path: endpoint.path,
        url: url.toString(),
        durationMs: Date.now() - startedAt,
        responseSize: 0,
        errorCode: 'TIMEOUT',
        error: `请求超时（${Math.round(timeoutMs / 1000)} 秒）`
      })
    })
    request.on('error', (error: NodeJS.ErrnoException) => {
      finish({
        ok: false,
        method: endpoint.method,
        path: endpoint.path,
        url: url.toString(),
        durationMs: Date.now() - startedAt,
        responseSize: 0,
        errorCode: error.code === 'ECONNREFUSED' ? 'CONNECTION_REFUSED' : 'UNKNOWN',
        error: error.message
      })
    })
    if (endpoint.method === 'POST') request.write(body)
    request.end()
  })
}
