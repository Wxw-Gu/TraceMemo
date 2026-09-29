import { ILINK_STALE_TOKEN_CODE } from './types'

export type ILinkErrorKind =
  /** DNS / TCP / TLS 等网络层失败 */
  | 'network'
  /** 客户端主动超时（长轮询正常控制流） */
  | 'timeout'
  /** 非 2xx HTTP 响应 */
  | 'http'
  /** 响应体不是合法 JSON，或业务 ret/errcode 非 0 */
  | 'protocol'
  /** bot token 失效（ret/errcode = -14），必须重新登录 */
  | 'stale_token'
  /** 调用方主动取消 */
  | 'aborted'

const MAX_BODY_EXCERPT = 400

export interface ILinkErrorOptions {
  kind: ILinkErrorKind
  message: string
  httpStatus?: number
  ret?: number
  errcode?: number
  errmsg?: string
  cause?: unknown
}

/**
 * iLink 统一错误类型。
 *
 * 刻意不携带请求头 / token：错误对象可能被上层原样写入日志，
 * 因此只暴露可安全打印的字段。
 */
export class ILinkError extends Error {
  readonly kind: ILinkErrorKind
  readonly httpStatus?: number
  readonly ret?: number
  readonly errcode?: number
  readonly errmsg?: string
  override readonly cause?: unknown

  constructor(options: ILinkErrorOptions) {
    super(options.message)
    this.name = 'ILinkError'
    this.kind = options.kind
    if (options.httpStatus !== undefined) this.httpStatus = options.httpStatus
    if (options.ret !== undefined) this.ret = options.ret
    if (options.errcode !== undefined) this.errcode = options.errcode
    if (options.errmsg !== undefined) this.errmsg = options.errmsg
    if (options.cause !== undefined) this.cause = options.cause
  }

  get isStaleToken(): boolean {
    return (
      this.kind === 'stale_token' ||
      this.ret === ILINK_STALE_TOKEN_CODE ||
      this.errcode === ILINK_STALE_TOKEN_CODE
    )
  }
}

export function isILinkError(error: unknown): error is ILinkError {
  return error instanceof ILinkError
}

/**
 * 把 undici / Node 的错误链压平成可诊断文本。
 *
 * fetch 层失败时顶层只有一句没有信息量的 `fetch failed`，真正的原因
 * （ENOTFOUND / ECONNREFUSED / TLS 握手失败 / socket 超时）在 `error.cause` 链上。
 * 日志里必须能看到它，否则线上只能看到"连不上"却不知道为什么。
 */
export function describeErrorChain(error: unknown, maxDepth = 4): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < maxDepth && current; depth += 1) {
    const candidate = current as {
      name?: unknown
      code?: unknown
      message?: unknown
      cause?: unknown
    }
    const fragments = [candidate.name, candidate.code, candidate.message]
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean)
    parts.push(fragments.join(' ') || String(current))
    current = candidate.cause
  }
  return parts.join(' <- ')
}

/** 沿错误链取第一个有值的 errno 风格 code。 */
function firstErrorCode(error: unknown, maxDepth = 4): string {
  let current: unknown = error
  for (let depth = 0; depth < maxDepth && current; depth += 1) {
    const code = (current as { code?: unknown } | null)?.code
    if (typeof code === 'string' && code.trim()) return code.trim()
    current = (current as { cause?: unknown } | null)?.cause
  }
  return ''
}

/** 网络层错误分类；用于决定退避策略。 */
export function classifyNetworkError(error: unknown): ILinkErrorKind {
  const code = firstErrorCode(error)
  const combined = `${code} ${describeErrorChain(error)}`.toUpperCase()

  if (/ABORT|CANCEL/.test(combined)) return 'aborted'
  if (
    /TIMEOUT|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT/.test(
      combined
    )
  ) {
    return 'timeout'
  }
  return 'network'
}

/** 截断响应体，避免把大段 HTML / 二进制写进日志。 */
export function excerptBody(body: string): string {
  const normalized = String(body ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return normalized.length > MAX_BODY_EXCERPT
    ? `${normalized.slice(0, MAX_BODY_EXCERPT)}…`
    : normalized
}

/** 把任意 error 压成可安全记录的字符串。 */
export function describeError(error: unknown): string {
  if (!isILinkError(error) && error instanceof Error) return describeErrorChain(error)
  if (!isILinkError(error) && !(error instanceof Error)) return String(error)
  if (isILinkError(error)) {
    const parts = [error.message]
    if (error.httpStatus !== undefined) parts.push(`http=${error.httpStatus}`)
    if (error.ret !== undefined) parts.push(`ret=${error.ret}`)
    if (error.errcode !== undefined) parts.push(`errcode=${error.errcode}`)
    if (error.errmsg) parts.push(`errmsg=${error.errmsg}`)
    return parts.join(' | ')
  }
  return error instanceof Error ? error.message : String(error)
}

/**
 * 协议层业务错误断言：ret / errcode 非 0 即失败。
 * HTTP 200 不能单独证明调用成功。
 */
export function assertBusinessOk(
  response: { ret?: number; errcode?: number; errmsg?: string },
  context: string
): void {
  const ret = Number(response.ret ?? 0)
  const errcode = Number(response.errcode ?? 0)
  if (ret === 0 && errcode === 0) return
  const stale = ret === ILINK_STALE_TOKEN_CODE || errcode === ILINK_STALE_TOKEN_CODE
  throw new ILinkError({
    kind: stale ? 'stale_token' : 'protocol',
    message: stale
      ? `${context}失败：微信登录凭证已失效`
      : `${context}失败：ret=${ret} errcode=${errcode}${response.errmsg ? ` errmsg=${response.errmsg}` : ''}`,
    ret,
    errcode,
    ...(response.errmsg ? { errmsg: response.errmsg } : {})
  })
}
