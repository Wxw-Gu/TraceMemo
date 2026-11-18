import type { ExtensionEventEnvelope } from './events'
import type { ExtensionErrorPayload } from './errors'

/** 主进程 ↔ 扩展后台进程的私有协议；扩展进程只能发 `call` / `register-action` / `log` / `action-result`。 */
export const EXTENSION_HOST_PROTOCOL_VERSION = 1

export type ExtensionHostCallMethod =
  | 'storage.get'
  | 'storage.set'
  | 'storage.remove'
  | 'storage.list'
  | 'messages.query'
  | 'wechat.send.text'
  | 'wechat.send.image'
  | 'wechat.send.video'
  | 'wechat.send.voice'
  | 'ai.chat'
  | 'capabilities.get'
  | 'secrets.get'
  | 'secrets.set'
  | 'secrets.delete'
  | 'secrets.has'

export interface ExtensionHostReady {
  type: 'ready'
  version: number
}

export interface ExtensionHostActivate {
  type: 'activate'
  version: number
  extensionId: string
  extensionDir: string
  /** 扩展私有数据目录（`extensions-data/<id>`）；媒体文件应落在这里。 */
  dataDir: string
  apiVersion: string
  permissions: string[]
}

export interface ExtensionHostActivated {
  type: 'activated'
  version: number
  ok: boolean
  error?: ExtensionErrorPayload
}

export interface ExtensionHostShutdown {
  type: 'shutdown'
  version: number
}

export interface ExtensionHostCall {
  type: 'call'
  version: number
  callId: string
  method: ExtensionHostCallMethod
  params: Record<string, unknown>
}

export interface ExtensionHostCallResult {
  type: 'call-result'
  version: number
  callId: string
  ok: boolean
  result?: unknown
  error?: ExtensionErrorPayload
}

export interface ExtensionHostEvent {
  type: 'event'
  version: number
  envelope: ExtensionEventEnvelope
}

export interface ExtensionHostRegisterAction {
  type: 'register-action'
  version: number
  action: {
    id: string
    title: string
    description?: string
    /** 完整参数 Schema（未经校验的原始 JSON）。 */
    inputSchema?: unknown
    /** 兼容字段：旧宿主只认这个布尔值。新宿主用 `inputSchema`。 */
    hasInputSchema?: boolean
  }
}

export interface ExtensionHostInvokeAction {
  type: 'invoke-action'
  version: number
  requestId: string
  actionId: string
  input: Record<string, unknown>
  timeoutMs: number
}

export interface ExtensionHostActionResult {
  type: 'action-result'
  version: number
  requestId: string
  ok: boolean
  output?: ExtensionAutomationActionOutput
  error?: ExtensionErrorPayload
}

export interface ExtensionHostTestSend {
  type: 'test-send'
  version: number
  requestId: string
  params: Record<string, unknown>
}

export interface ExtensionHostTestResult {
  type: 'test-result'
  version: number
  requestId: string
  ok: boolean
  result?: unknown
  error?: ExtensionErrorPayload
}

export interface ExtensionHostLog {
  type: 'log'
  version: number
  level: 'info' | 'warn' | 'error'
  message: string
}

/** 扩展页面 → 同扩展后台的通用请求；宿主只做路由与限额：页面拿不到任意 Node 能力，后台必须显式注册处理器。 */
export interface ExtensionHostPageRequest {
  type: 'page-request'
  version: number
  requestId: string
  method: string
  params: Record<string, unknown>
  timeoutMs: number
}

export interface ExtensionHostPageResult {
  type: 'page-result'
  version: number
  requestId: string
  ok: boolean
  result?: unknown
  error?: { code: string; message: string }
}

export type ExtensionHostOutboundMessage =
  | ExtensionHostReady
  | ExtensionHostActivated
  | ExtensionHostCall
  | ExtensionHostRegisterAction
  | ExtensionHostLog
  | ExtensionHostActionResult
  | ExtensionHostTestResult
  | ExtensionHostPageResult

export type ExtensionHostInboundMessage =
  | ExtensionHostActivate
  | ExtensionHostShutdown
  | ExtensionHostCallResult
  | ExtensionHostEvent
  | ExtensionHostInvokeAction
  | ExtensionHostTestSend
  | ExtensionHostTestResult
  | ExtensionHostPageRequest

/** 自动化动作的返回值。 */
export interface ExtensionAutomationActionOutput {
  success: boolean
  output?: Record<string, unknown>
  reply?: {
    type: 'text'
    text: string
    /** 群聊里要 @ 的 wxid → 显示名；仅 `wechat.send.text` 被授予时生效。 */
    at?: Record<string, string>
  }
  /** 失败原因（用户可见的短句）。 */
  error?: string
}

export interface ExtensionMessagesQueryRequest {
  conversationId: string
  /** epoch **毫秒**。 */
  startTime?: number
  /** epoch **毫秒**。 */
  endTime?: number
  limit?: number
}

export interface ExtensionQueriedMessage {
  messageId: string
  conversationId: string
  senderId?: string
  senderName?: string
  isSelf: boolean
  type: string
  text?: string
  /** epoch 毫秒。 */
  timestamp: number
}

export interface ExtensionSendTextRequest {
  /** 群为 `xxx@chatroom`，私聊为 wxid。 */
  to: string
  text: string
  at?: Record<string, string>
  /** 扩展自定义去重键；相同键的重复请求会被 Gateway 审计短路。 */
  dedupeKey?: string
}

/** 图片发送；图片与视频是两条独立通道：视频必须显式用 `type: 'video'`， 由原生 Host 的 `/SendMsg` 以 video 类型提交。 */
export interface ExtensionSendImageRequest {
  to: string
  /** 绝对路径；必须位于扩展数据目录或系统临时目录。 */
  path: string
  dedupeKey?: string
}

export interface ExtensionSendVideoRequest {
  to: string
  /** 绝对路径；必须位于扩展数据目录或系统临时目录。 */
  path: string
  dedupeKey?: string
}

/** 语音发送。 */
export interface ExtensionSendVoiceRequest {
  to: string
  path?: string
  text?: string
  /** 可选音色 ID；省略时使用 TraceMemo 设置页当前选定的音色。 */
  voiceId?: string
  dedupeKey?: string
}

export interface ExtensionSendTextResult {
  actionId: string
  status: 'sent'
}
