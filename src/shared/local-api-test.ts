export const LOCAL_API_ENDPOINTS = {
  health: { method: 'GET', path: '/api/v1/health', queryKeys: [] },
  'current-time': { method: 'GET', path: '/api/v1/current_time', queryKeys: [] },
  contact: { method: 'GET', path: '/api/v1/contact', queryKeys: ['filter', 'type'] },
  chatroom: { method: 'GET', path: '/api/v1/chatroom', queryKeys: ['keyword'] },
  'recent-chat': { method: 'GET', path: '/api/v1/recent_chat', queryKeys: ['limit'] },
  chatlog: {
    method: 'GET',
    path: '/api/v1/chatlog',
    queryKeys: ['talker', 'time', 'startTime', 'endTime']
  },
  'group-snapshot': { method: 'GET', path: '/api/v1/group_snapshot', queryKeys: ['md5'] },
  resolve: { method: 'GET', path: '/api/v1/resolve', queryKeys: ['q'] },
  'wechat-send-capability': {
    method: 'GET',
    path: '/api/v1/wechat-personal/send-capability',
    queryKeys: []
  },
  'scheduled-reports': {
    method: 'GET',
    path: '/api/v1/scheduled-reports',
    queryKeys: []
  },
  report: { method: 'POST', path: '/api/v1/report', queryKeys: [] },
  'agent-status': { method: 'GET', path: '/api/v1/agent/status', queryKeys: [] },
  'agent-group-report': { method: 'POST', path: '/api/v1/agent/group-report', queryKeys: [] },
  'agent-send': { method: 'POST', path: '/api/v1/agent/send', queryKeys: [] }
} as const

export type LocalApiEndpointId = keyof typeof LOCAL_API_ENDPOINTS
export type LocalApiMethod = (typeof LOCAL_API_ENDPOINTS)[LocalApiEndpointId]['method']

export interface LocalApiTestRequest {
  endpointId: LocalApiEndpointId
  query?: Record<string, string>
  body?: string
}

export interface LocalApiTestResponse {
  ok: boolean
  method: LocalApiMethod
  path: string
  url: string
  status?: number
  statusText?: string
  durationMs: number
  responseSize: number
  contentType?: string
  json?: unknown
  bodyText?: string
  errorCode?:
    | 'API_NOT_RUNNING'
    | 'TOKEN_UNAVAILABLE'
    | 'CONNECTION_REFUSED'
    | 'TIMEOUT'
    | 'INVALID_REQUEST'
    | 'UNKNOWN'
  error?: string
}

export interface LocalApiCurlCopyResult {
  success: boolean
  error?: string
}
