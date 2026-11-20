import type { AgentTaskReply, AgentTaskReplyRole } from '../../shared/agent-task'
import {
  AgentTaskProvider,
  AgentTaskProviderError,
  type AgentTaskProviderRequestOptions
} from './agent-task-provider'
import type { WorkBuddyCredentials } from './agent-task-config'

/**
 * WorkBuddy Local Assistant 适配器。
 *
 * 契约来源（未在本仓库实测的部分会在下方逐条标注）：
 * - `GET  /openapi/v2/localassistant`          → `data.online`
 * - `POST /openapi/v2/localassistant/message`  → `data.message_id`
 * - `GET  /openapi/v2/localassistant/message?message_id=...` → 增量回复
 * - `POST /openapi/v2/token`                   → refresh
 *
 * **未实测**：
 * 1. assistant 回复是否一定出现在 `message_id` 之后、是否保证只出现一次；
 * 2. 真实账号下 refresh_token 是否轮换；
 * 3. `content[]` 里除 `text` 之外的实际片段类型。
 * 因此第一版把「看到任意一条 assistant 回复」当作任务完成，而不是猜更细的状态机。
 *
 * **安全边界**：
 * - 凭证只从构造参数来（由 `loadWorkBuddyCredentials()` 读环境变量），本文件零硬编码；
 * - 错误信息里只放 HTTP 状态与业务 `code`，不回显请求头或 token。
 */

const LOCAL_ASSISTANT_PATH = '/openapi/v2/localassistant'
const LOCAL_ASSISTANT_MESSAGE_PATH = '/openapi/v2/localassistant/message'
const TOKEN_PATH = '/openapi/v2/token'
/** 提前 60 秒刷新，避免边界上刚好过期。 */
const TOKEN_EXPIRY_SKEW_MS = 60_000

interface WorkBuddyEnvelope<T> {
  code?: number
  msg?: string
  request_id?: string
  data?: T
}

export interface WorkBuddyProviderOptions {
  baseUrl: string
  timeoutMs: number
  credentials: WorkBuddyCredentials
  fetchImpl?: typeof fetch
  now?: () => number
}

export class WorkBuddyAccessTokenSource {
  private cached: { token: string; expiresAt: number } | null = null
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number

  constructor(private readonly options: WorkBuddyProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
  }

  /** 丢弃缓存。收到 401 时由 provider 调用，下一次会强制 refresh。 */
  invalidate(): void {
    this.cached = null
  }

  async getAccessToken(forceRefresh = false): Promise<string> {
    const credentials = this.options.credentials

    if (!forceRefresh && this.cached && this.now() < this.cached.expiresAt) {
      return this.cached.token
    }

    if (!forceRefresh && credentials.accessToken) {
      // 静态 token 没有过期信息：先用，遇到 401 再走 refresh。
      this.cached = { token: credentials.accessToken, expiresAt: Number.POSITIVE_INFINITY }
      return credentials.accessToken
    }

    if (credentials.refreshToken && credentials.clientId && credentials.clientSecret) {
      const token = await this.refresh(credentials)
      this.cached = {
        token: token.accessToken,
        expiresAt: this.now() + Math.max(60, token.expiresIn) * 1000 - TOKEN_EXPIRY_SKEW_MS
      }
      return token.accessToken
    }

    if (credentials.accessToken) {
      throw new AgentTaskProviderError(
        'auth_expired',
        'WorkBuddy access_token 已失效，且没有配置 refresh_token',
        false,
        401
      )
    }
    throw new AgentTaskProviderError('auth_missing', '未配置 WorkBuddy 访问凭证', false)
  }

  private async refresh(
    credentials: WorkBuddyCredentials
  ): Promise<{ accessToken: string; expiresIn: number }> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: String(credentials.refreshToken),
      client_id: String(credentials.clientId),
      client_secret: String(credentials.clientSecret)
    })

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs)
    let response: Response
    try {
      response = await this.fetchImpl(`${this.options.baseUrl}${TOKEN_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: controller.signal
      })
    } catch (error) {
      throw classifyTokenFailure(error)
    } finally {
      clearTimeout(timer)
    }

    const envelope = await readEnvelope(response)
    if (!response.ok || (typeof envelope.code === 'number' && envelope.code !== 0)) {
      throw new AgentTaskProviderError(
        'auth_expired',
        `WorkBuddy 凭证刷新失败（HTTP ${response.status}${envelope.msg ? `：${envelope.msg}` : ''}）`,
        false,
        response.status
      )
    }

    const data = envelope.data as { access_token?: unknown; expires_in?: unknown } | undefined
    if (!data || typeof data.access_token !== 'string' || !data.access_token) {
      throw new AgentTaskProviderError('invalid_response', 'WorkBuddy 刷新响应缺少 access_token')
    }
    return {
      accessToken: data.access_token,
      expiresIn: typeof data.expires_in === 'number' ? data.expires_in : 3600
    }
  }
}

export class WorkBuddyAgentTaskProvider implements AgentTaskProvider {
  readonly id = 'workbuddy'
  private readonly tokenSource: WorkBuddyAccessTokenSource
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: WorkBuddyProviderOptions) {
    this.tokenSource = new WorkBuddyAccessTokenSource(options)
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async checkOnline(options: AgentTaskProviderRequestOptions = {}): Promise<boolean> {
    const data = await this.request<{ online?: unknown }>(
      'GET',
      LOCAL_ASSISTANT_PATH,
      undefined,
      options
    )
    return data?.online === true
  }

  async submitTask(
    input: { content: string },
    options: AgentTaskProviderRequestOptions = {}
  ): Promise<{ messageId: string }> {
    const data = await this.request<{ message_id?: unknown }>(
      'POST',
      `${LOCAL_ASSISTANT_PATH}/message`,
      { content: input.content, msg_type: 'text' },
      options
    )
    if (!data || typeof data.message_id !== 'string' || !data.message_id) {
      throw new AgentTaskProviderError('invalid_response', 'WorkBuddy 投递响应缺少 message_id')
    }
    return { messageId: data.message_id }
  }

  async fetchReplies(
    afterMessageId: string,
    options: AgentTaskProviderRequestOptions & { limit?: number } = {}
  ): Promise<AgentTaskReply[]> {
    const query = new URLSearchParams({
      message_id: afterMessageId,
      limit: String(Math.max(1, Math.min(options.limit ?? 20, 100)))
    })
    const data = await this.request<unknown>(
      'GET',
      `${LOCAL_ASSISTANT_MESSAGE_PATH}?${query.toString()}`,
      undefined,
      options
    )
    return parseReplies(data)
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown | undefined,
    options: AgentTaskProviderRequestOptions,
    retried = false
  ): Promise<T> {
    const token = await this.tokenSource.getAccessToken(retried)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs)
    const signal = options.signal
      ? AbortSignal.any([controller.signal, options.signal])
      : controller.signal

    let response: Response
    try {
      response = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal
      })
    } catch (error) {
      throw classifyRequestFailure(error, options.signal)
    } finally {
      clearTimeout(timer)
    }

    if (response.status === 401) {
      if (!retried) {
        this.tokenSource.invalidate()
        return this.request<T>(method, path, body, options, true)
      }
      throw new AgentTaskProviderError('auth_expired', 'WorkBuddy 鉴权失败（HTTP 401）', false, 401)
    }
    if (response.status === 403) {
      throw new AgentTaskProviderError(
        'auth_expired',
        'WorkBuddy 授权不足（HTTP 403，检查 scope）',
        false,
        403
      )
    }

    const envelope = await readEnvelope(response)
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500
      throw new AgentTaskProviderError(
        'http_error',
        `WorkBuddy 请求失败（HTTP ${response.status}${envelope.msg ? `：${envelope.msg}` : ''}）`,
        retryable,
        response.status
      )
    }
    if (typeof envelope.code === 'number' && envelope.code !== 0) {
      throw new AgentTaskProviderError(
        'http_error',
        `WorkBuddy 业务错误（code=${envelope.code}${envelope.msg ? `：${envelope.msg}` : ''}）`
      )
    }
    return envelope.data as T
  }
}

async function readEnvelope(response: Response): Promise<WorkBuddyEnvelope<unknown>> {
  let text = ''
  try {
    text = await response.text()
  } catch {
    return {}
  }
  if (!text) return {}
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as WorkBuddyEnvelope<unknown>
    }
  } catch {
    // 非 JSON 响应：保留 HTTP 状态，交给调用方按 invalid_response 处理。
  }
  return {}
}

function classifyTokenFailure(error: unknown): AgentTaskProviderError {
  if (error instanceof Error && error.name === 'AbortError') {
    return new AgentTaskProviderError('timeout', 'WorkBuddy 凭证刷新超时', true)
  }
  return new AgentTaskProviderError(
    'http_error',
    `WorkBuddy 凭证刷新请求失败：${error instanceof Error ? error.message : String(error)}`,
    true
  )
}

function classifyRequestFailure(
  error: unknown,
  externalSignal?: AbortSignal
): AgentTaskProviderError {
  if (error instanceof Error && error.name === 'AbortError') {
    if (externalSignal?.aborted) {
      return new AgentTaskProviderError('internal', 'WorkBuddy 请求已取消')
    }
    return new AgentTaskProviderError('timeout', 'WorkBuddy 请求超时', true)
  }
  return new AgentTaskProviderError(
    'http_error',
    `WorkBuddy 请求失败：${error instanceof Error ? error.message : String(error)}`,
    true
  )
}

function roleOf(value: unknown): AgentTaskReplyRole {
  if (value === 'assistant') return 'assistant'
  if (value === 'user') return 'user'
  return 'other'
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(part)
      continue
    }
    if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
      parts.push((part as { text: string }).text)
    }
  }
  return parts.join('\n').trim()
}

/**
 * 解析 `messages[]`。
 *
 * 兼容 `data.messages` 与 `data` 直接是数组两种形态（契约文档只写了前者，
 * 但历史接口在分页/增量下出现过裸数组，这里不做假设性拒绝）。
 */
export function parseReplies(data: unknown): AgentTaskReply[] {
  const list = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray((data as { messages?: unknown }).messages)
      ? (data as { messages: unknown[] }).messages
      : []

  const replies: AgentTaskReply[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const messageId =
      typeof record.message_id === 'string'
        ? record.message_id
        : typeof record.messageId === 'string'
          ? record.messageId
          : ''
    if (!messageId) continue
    replies.push({
      messageId,
      role: roleOf(record.role),
      text: extractText(record.content),
      ...(typeof record.created_at === 'string' ? { createdAt: record.created_at } : {})
    })
  }
  return replies
}
