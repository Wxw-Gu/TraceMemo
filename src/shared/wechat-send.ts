/**
 * TraceMemo 统一微信发送模型。
 *
 * 上层业务只说"发什么给谁"，不关心底下是 iLink 还是注入式个人微信。
 * 这个文件刻意不引入任何 Electron / Node 专属对象，将来换宿主（例如 Tauri）
 * 只需要替换 transport 实现，业务层与协议类型都不用动。
 */

export type WechatSendTransport = 'personal' | 'ilink'

export type WechatSendType = 'text' | 'image' | 'voice' | 'file'

/**
 * 统一发送请求。
 *
 * - `msg` 是消息主体：text 时就是文本；image / voice / file 时是本地路径或 URL。
 * - `context_token` 是 iLink 会话上下文，只在回复对应会话时传递。
 * - `transport` 缺省时按 `context_token` 推断（有 token 即 iLink 会话）。
 */
export interface WechatSendRequest {
  request_id: string
  account_id?: string
  to: string
  type: WechatSendType
  msg: string
  context_token?: string
  transport?: WechatSendTransport
  /** 个人微信需要区分群聊 / 联系人。 */
  is_group?: boolean
  /** 传输层附加元数据（例如语音的 fromId / durationMs），不参与审计摘要。 */
  metadata?: Record<string, unknown>
}

export type WechatSendStatus = 'sent' | 'failed' | 'blocked'

export type WechatSendErrorCode =
  | 'INVALID_REQUEST'
  | 'UNSUPPORTED_TYPE'
  | 'TRANSPORT_UNAVAILABLE'
  | 'STALE_TOKEN'
  | 'SEND_FAILED'
  | 'UNKNOWN'

export interface WechatSendResult {
  request_id: string
  success: boolean
  status: WechatSendStatus
  transport: WechatSendTransport
  duration_ms: number
  error_code?: WechatSendErrorCode
  error?: string
}

/** Send Log 条目：可追溯，但不复制完整聊天内容。 */
export interface WechatSendLogEntry {
  request_id: string
  timestamp: number
  transport: WechatSendTransport
  account_id?: string
  to: string
  type: WechatSendType
  /** 截断后的内容预览（本地文件只记录文件名）。 */
  msg_preview?: string
  /** 对 msg 原文计算的 sha256。 */
  msg_hash?: string
  status: WechatSendStatus
  duration_ms?: number
  error_code?: WechatSendErrorCode
}

export const MAX_SEND_PREVIEW_LENGTH = 200

const SUPPORTED_TYPES: ReadonlySet<string> = new Set(['text', 'image', 'voice', 'file'])

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 生成 Send Log 用的内容预览。
 * 本地路径只保留文件名，避免把用户目录结构写进日志。
 */
export function buildSendPreview(msg: string, type: WechatSendType): string {
  const raw = String(msg ?? '')
  let preview = raw
  if (type !== 'text') {
    preview = filenameOf(raw)
  }
  const normalized = preview.replace(/\s+/g, ' ').trim()
  return normalized.length > MAX_SEND_PREVIEW_LENGTH
    ? normalized.slice(0, MAX_SEND_PREVIEW_LENGTH)
    : normalized
}

function filenameOf(value: string): string {
  const withoutQuery = value.split('?')[0].split('#')[0]
  const segments = withoutQuery.split(/[/\\]/)
  return segments[segments.length - 1] || withoutQuery
}

export interface NormalizeSendRequestOptions {
  /** 缺省 request_id 生成器；便于测试注入确定性值。 */
  createRequestId?: () => string
}

/**
 * 校验并规范化发送请求。
 * 返回 null 表示请求不合法，调用方应当以 INVALID_REQUEST 记账，而不是静默丢弃。
 */
export function normalizeWechatSendRequest(
  value: unknown,
  options: NormalizeSendRequestOptions = {}
): WechatSendRequest | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Partial<WechatSendRequest> & Record<string, unknown>

  const to = asTrimmedString(input.to)
  if (!to) return null

  const type = asTrimmedString(input.type) as WechatSendType
  if (!SUPPORTED_TYPES.has(type)) return null

  const msg = typeof input.msg === 'string' ? input.msg.trim() : ''
  // 文本必须非空；媒体允许空 msg 但会被适配器拒绝，这里提前挡掉以免产生空发送。
  if (!msg) return null

  const requestId = asTrimmedString(input.request_id) || options.createRequestId?.() || ''
  if (!requestId) return null

  const transport = asTrimmedString(input.transport)
  const contextToken = asTrimmedString(input.context_token)
  const accountId = asTrimmedString(input.account_id)

  const normalized: WechatSendRequest = {
    request_id: requestId,
    to,
    type,
    msg,
    ...(accountId ? { account_id: accountId } : {}),
    ...(contextToken ? { context_token: contextToken } : {}),
    ...(transport === 'ilink' || transport === 'personal' ? { transport } : {}),
    ...(typeof input.is_group === 'boolean' ? { is_group: input.is_group } : {}),
    ...(input.metadata && typeof input.metadata === 'object'
      ? { metadata: input.metadata as Record<string, unknown> }
      : {})
  }
  return normalized
}

/**
 * 传输通道解析规则：
 * 1. 显式声明优先；
 * 2. 带 context_token 说明是 iLink 会话，走 iLink；
 * 3. 其余走个人微信注入通道。
 */
export function resolveSendTransport(request: {
  transport?: WechatSendTransport
  context_token?: string
}): WechatSendTransport {
  if (request.transport) return request.transport
  return request.context_token ? 'ilink' : 'personal'
}
