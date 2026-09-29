import { classifyNetworkError, describeErrorChain, excerptBody, ILinkError } from './errors'
import {
  buildAuthorizedHeaders,
  buildBaseInfo,
  buildCommonHeaders,
  buildQrStatusHeaders,
  type ILinkHeaderOptions
} from './headers'
import {
  ILINK_CONFIG_TIMEOUT_MS,
  ILINK_DEFAULT_BASE_URL,
  ILINK_SEND_TIMEOUT_MS,
  type ILinkGetConfigResponse,
  type ILinkGetUpdatesResponse,
  type ILinkGetUploadUrlRequest,
  type ILinkGetUploadUrlResponse,
  type ILinkSendMessageRequest,
  type ILinkSendMessageResponse,
  type ILinkSendTypingResponse
} from './types'

export type FetchLike = typeof fetch

export interface ILinkClientOptions {
  baseUrl?: string
  botToken?: string
  fetchImpl?: FetchLike
  headers?: ILinkHeaderOptions
}

export interface ILinkRequestOptions {
  timeoutMs: number
  signal?: AbortSignal
  /** 是否在失败时把响应体拼进错误信息（默认只带 HTTP 状态码）。 */
  includeBody?: boolean
}

function withTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('ilink request timeout')), timeoutMs)
  const onAbort = (): void => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }
}

async function parseJson<T>(response: Response, context: string, includeBody: boolean): Promise<T> {
  const text = await response.text()
  if (!response.ok) {
    throw new ILinkError({
      kind: 'http',
      message: includeBody
        ? `${context}失败：HTTP ${response.status} ${excerptBody(text)}`
        : `${context}失败：HTTP ${response.status}`,
      httpStatus: response.status
    })
  }
  if (!text.trim()) return {} as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw new ILinkError({
      kind: 'protocol',
      message: `${context}失败：响应不是合法 JSON`,
      httpStatus: response.status
    })
  }
}

/**
 * iLink HTTP 客户端。
 *
 * 只负责传输层：网络失败 / 超时 / 非 2xx / JSON 解析失败会抛 ILinkError。
 * 业务层 ret / errcode 的判断交给调用方（长轮询需要区分 -14）。
 */
export class ILinkClient {
  private baseUrlValue: string
  private botTokenValue: string
  private readonly fetchImpl: FetchLike
  private readonly headerOptions: ILinkHeaderOptions

  constructor(options: ILinkClientOptions = {}) {
    this.baseUrlValue = (options.baseUrl || ILINK_DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.botTokenValue = options.botToken || ''
    this.fetchImpl = options.fetchImpl || globalThis.fetch
    this.headerOptions = options.headers || {}
  }

  get baseUrl(): string {
    return this.baseUrlValue
  }

  /** 登录返回 baseurl / redirect_host 后更新后续业务 API 节点。 */
  setBaseUrl(baseUrl: string): void {
    const normalized = String(baseUrl || '').trim()
    if (!normalized) return
    this.baseUrlValue = /^https?:\/\//.test(normalized)
      ? normalized.replace(/\/+$/, '')
      : `https://${normalized.replace(/\/+$/, '')}`
  }

  setBotToken(botToken: string): void {
    this.botTokenValue = botToken
  }

  get hasBotToken(): boolean {
    return Boolean(this.botTokenValue)
  }

  private async request(
    url: string,
    init: RequestInit,
    context: string,
    options: ILinkRequestOptions
  ): Promise<Response> {
    const { signal, cleanup } = withTimeout(options.signal, options.timeoutMs)
    try {
      return await this.fetchImpl(url, { ...init, signal })
    } catch (error) {
      const kind = classifyNetworkError(error)
      const aborted = options.signal?.aborted === true
      throw new ILinkError({
        kind: aborted ? 'aborted' : kind,
        // 带上完整错误链：顶层 fetch failed 没有信息量，原因在 cause 上。
        message: `${context}失败：${describeErrorChain(error)}`,
        cause: error
      })
    } finally {
      cleanup()
    }
  }

  /** 未鉴权 POST（获取二维码）。 */
  async postAnonymous<T>(
    path: string,
    body: unknown,
    context: string,
    options: ILinkRequestOptions
  ): Promise<T> {
    const response = await this.request(
      `${this.baseUrlValue}${path}`,
      {
        method: 'POST',
        headers: buildCommonHeaders(),
        body: JSON.stringify(body)
      },
      context,
      options
    )
    return parseJson<T>(response, context, options.includeBody === true)
  }

  /** 鉴权 POST（登录后的全部业务接口）。 */
  async post<T>(
    path: string,
    body: unknown,
    context: string,
    options: ILinkRequestOptions
  ): Promise<T> {
    const response = await this.request(
      `${this.baseUrlValue}${path}`,
      {
        method: 'POST',
        headers: buildAuthorizedHeaders(this.botTokenValue),
        body: JSON.stringify(body)
      },
      context,
      options
    )
    return parseJson<T>(response, context, options.includeBody === true)
  }

  /** 二维码状态轮询使用裸 URL（可能指向 redirect_host）。 */
  async getAnonymous<T>(url: string, context: string, options: ILinkRequestOptions): Promise<T> {
    const response = await this.request(
      url,
      { method: 'GET', headers: buildQrStatusHeaders() },
      context,
      options
    )
    return parseJson<T>(response, context, options.includeBody === true)
  }

  private baseInfo(): ReturnType<typeof buildBaseInfo> {
    return buildBaseInfo(this.headerOptions)
  }

  async getUpdates(
    getUpdatesBuf: string,
    options: ILinkRequestOptions
  ): Promise<ILinkGetUpdatesResponse> {
    return this.post<ILinkGetUpdatesResponse>(
      '/ilink/bot/getupdates',
      { get_updates_buf: getUpdatesBuf, base_info: this.baseInfo() },
      'getupdates',
      options
    )
  }

  async sendMessage(
    msg: ILinkSendMessageRequest['msg'],
    signal?: AbortSignal
  ): Promise<ILinkSendMessageResponse> {
    return this.post<ILinkSendMessageResponse>(
      '/ilink/bot/sendmessage',
      { msg, base_info: this.baseInfo() },
      'sendmessage',
      { timeoutMs: ILINK_SEND_TIMEOUT_MS, signal, includeBody: true }
    )
  }

  async getUploadUrl(
    request: Omit<ILinkGetUploadUrlRequest, 'base_info'>,
    signal?: AbortSignal
  ): Promise<ILinkGetUploadUrlResponse> {
    return this.post<ILinkGetUploadUrlResponse>(
      '/ilink/bot/getuploadurl',
      { ...request, base_info: this.baseInfo() },
      'getuploadurl',
      { timeoutMs: ILINK_SEND_TIMEOUT_MS, signal, includeBody: true }
    )
  }

  async getConfig(
    ilinkUserId: string,
    contextToken: string,
    signal?: AbortSignal
  ): Promise<ILinkGetConfigResponse> {
    return this.post<ILinkGetConfigResponse>(
      '/ilink/bot/getconfig',
      {
        ilink_user_id: ilinkUserId,
        ...(contextToken ? { context_token: contextToken } : {}),
        base_info: this.baseInfo()
      },
      'getconfig',
      { timeoutMs: ILINK_CONFIG_TIMEOUT_MS, signal }
    )
  }

  /**
   * sendtyping：status=1 开始输入、status=2 取消。
   * 只用于输入状态，**不是** sendmessage 的鉴权凭据。
   */
  async sendTyping(
    ilinkUserId: string,
    typingTicket: string,
    status: number,
    signal?: AbortSignal
  ): Promise<ILinkSendTypingResponse> {
    return this.post<ILinkSendTypingResponse>(
      '/ilink/bot/sendtyping',
      {
        ilink_user_id: ilinkUserId,
        typing_ticket: typingTicket,
        status,
        base_info: this.baseInfo()
      },
      'sendtyping',
      { timeoutMs: ILINK_CONFIG_TIMEOUT_MS, signal }
    )
  }

  /** 生命周期通知：notifystart / notifystop。失败只告警，不阻断消息循环。 */
  async notifyLifecycle(action: 'start' | 'stop', signal?: AbortSignal): Promise<void> {
    await this.post<{ ret?: number; errmsg?: string }>(
      `/ilink/bot/msg/notify${action}`,
      { base_info: this.baseInfo() },
      `notify${action}`,
      { timeoutMs: ILINK_CONFIG_TIMEOUT_MS, signal }
    )
  }
}
