import type { ScheduledReportExecutionStage } from './scheduled-report'

export const SCHEDULED_REPORT_ERROR_CODES = [
  'AI_CONTEXT_LIMIT',
  'AI_QUOTA_EXCEEDED',
  'AI_AUTH_INVALID',
  'AI_PROVIDER_UNAVAILABLE',
  'AI_TIMEOUT',
  'DATABASE_UNAVAILABLE',
  'CHAT_NOT_FOUND',
  'NO_MESSAGES',
  'REPORT_GENERATION_FAILED',
  'REPORT_HISTORY_SAVE_FAILED',
  'WECHAT_SEND_UNAVAILABLE',
  'WECHAT_SEND_FAILED',
  'WECHAT_AUTH_EXPIRED',
  'UNKNOWN'
] as const

export type ScheduledReportErrorCode = (typeof SCHEDULED_REPORT_ERROR_CODES)[number]
export type ScheduledReportErrorSeverity = 'info' | 'warning' | 'error'

export interface ScheduledReportErrorDetails {
  code: ScheduledReportErrorCode
  stage: ScheduledReportExecutionStage
  severity: ScheduledReportErrorSeverity
  technicalMessage: string
  userTitle: string
  userMessage: string
  suggestedAction: string
  retryable: boolean
}

export interface ScheduledReportErrorInput {
  error?: unknown
  code?: unknown
  status?: unknown
  type?: unknown
  stage?: ScheduledReportExecutionStage
}

const knownCodes = new Set<string>(SCHEDULED_REPORT_ERROR_CODES)

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined

const safeString = (value: unknown): string => {
  if (value instanceof Error) return value.message
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

const redact = (value: string): string =>
  value
    .replace(/sk-[a-z0-9_-]+/gi, '***')
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [已隐藏]')
    .slice(0, 1_000)

const legacyCode = (value: string): ScheduledReportErrorCode | undefined => {
  const match = value.match(/^([a-z_]+):/i)?.[1]
  switch (match) {
    case 'wechat_not_ready':
      return 'WECHAT_SEND_UNAVAILABLE'
    case 'wechat_send_failed':
      return 'WECHAT_SEND_FAILED'
    case 'report_generation_failed':
      return 'REPORT_GENERATION_FAILED'
    case 'report_history_save_failed':
      return 'REPORT_HISTORY_SAVE_FAILED'
    default:
      return undefined
  }
}

const stageForCode = (code: ScheduledReportErrorCode): ScheduledReportExecutionStage => {
  if (code.startsWith('AI_')) return 'ai'
  if (code === 'DATABASE_UNAVAILABLE' || code === 'CHAT_NOT_FOUND' || code === 'NO_MESSAGES') {
    return 'data'
  }
  if (code === 'REPORT_HISTORY_SAVE_FAILED') return 'persist'
  if (code.startsWith('WECHAT_')) return 'send'
  return 'report'
}

const messagesFor = (
  code: ScheduledReportErrorCode
): Omit<ScheduledReportErrorDetails, 'code' | 'stage' | 'technicalMessage'> => {
  switch (code) {
    case 'AI_CONTEXT_LIMIT':
      return {
        severity: 'error',
        userTitle: '日报生成失败',
        userMessage: '今天的聊天内容较多，超过当前 AI 模型一次可以处理的内容长度。',
        suggestedAction: '可以缩短日报范围，或更换支持更长上下文的模型。',
        retryable: true
      }
    case 'AI_QUOTA_EXCEEDED':
      return {
        severity: 'error',
        userTitle: '日报生成失败',
        userMessage: '当前 AI 服务额度不足，因此暂时无法生成日报。',
        suggestedAction: '请检查 AI Provider 的账户额度，或切换其他可用模型。',
        retryable: true
      }
    case 'AI_AUTH_INVALID':
      return {
        severity: 'error',
        userTitle: 'AI 服务不可用',
        userMessage: '当前 AI 服务的认证信息无效。',
        suggestedAction: '请检查 API Key 或重新配置模型。',
        retryable: true
      }
    case 'AI_PROVIDER_UNAVAILABLE':
      return {
        severity: 'error',
        userTitle: 'AI 服务暂时不可用',
        userMessage: 'AI 服务暂时无法响应，本次日报没有生成。',
        suggestedAction: '稍后重新执行。',
        retryable: true
      }
    case 'AI_TIMEOUT':
      return {
        severity: 'error',
        userTitle: '日报生成超时',
        userMessage: 'AI 服务在限定时间内没有完成响应，本次日报没有生成。',
        suggestedAction: '稍后重新执行，或适当增加日报生成超时时间。',
        retryable: true
      }
    case 'DATABASE_UNAVAILABLE':
      return {
        severity: 'error',
        userTitle: '日报生成失败',
        userMessage: 'TraceMemo 当前无法读取微信数据库，本次日报没有生成。',
        suggestedAction: '请连接微信数据后重新执行。',
        retryable: true
      }
    case 'CHAT_NOT_FOUND':
      return {
        severity: 'error',
        userTitle: '日报生成失败',
        userMessage: '没有找到任务配置的目标群聊。',
        suggestedAction: '请检查群聊配置后重新执行。',
        retryable: false
      }
    case 'NO_MESSAGES':
      return {
        severity: 'warning',
        userTitle: '没有可生成的日报',
        userMessage: '所选时间范围内没有可总结的聊天消息。',
        suggestedAction: '可以扩大日报范围，或稍后重新执行。',
        retryable: true
      }
    case 'REPORT_HISTORY_SAVE_FAILED':
      return {
        severity: 'error',
        userTitle: '日报保存失败',
        userMessage: '日报已经生成，但保存到日报历史时失败。',
        suggestedAction: '请检查磁盘空间和文件权限后重新执行。',
        retryable: true
      }
    case 'WECHAT_SEND_UNAVAILABLE':
      return {
        severity: 'warning',
        userTitle: '日报已生成，但未发送',
        userMessage: '日报已经生成并保存，但当前个人微信发送能力不可用。',
        suggestedAction: '恢复微信消息能力后，可以直接重新发送这份日报。',
        retryable: true
      }
    case 'WECHAT_AUTH_EXPIRED':
      return {
        severity: 'warning',
        userTitle: '日报已生成，微信登录已失效',
        userMessage: '日报已经生成并保存，但个人微信登录凭证已失效。',
        suggestedAction: '重新登录微信后，可以直接重新发送这份日报。',
        retryable: true
      }
    case 'WECHAT_SEND_FAILED':
      return {
        severity: 'warning',
        userTitle: '日报已生成，发送失败',
        userMessage: '日报已经生成并保存，但发送到微信时失败。',
        suggestedAction: '检查微信连接后重新发送。',
        retryable: true
      }
    case 'REPORT_GENERATION_FAILED':
      return {
        severity: 'error',
        userTitle: '日报生成失败',
        userMessage: '日报生成过程中发生异常，本次日报没有生成。',
        suggestedAction: '稍后重新执行；如果持续失败，请检查模型配置。',
        retryable: true
      }
    case 'UNKNOWN':
      return {
        severity: 'error',
        userTitle: '定时日报执行失败',
        userMessage: '本次定时日报执行失败。',
        suggestedAction: '查看详情并稍后重新执行。',
        retryable: true
      }
  }
}

const inferCode = (
  message: string,
  stage: ScheduledReportExecutionStage,
  input: ScheduledReportErrorInput
): ScheduledReportErrorCode => {
  const explicit = safeString(input.code).trim().toUpperCase()
  if (knownCodes.has(explicit)) return explicit as ScheduledReportErrorCode
  const legacy = legacyCode(message)
  if (legacy) return legacy
  const status = Number(input.status)
  const type = safeString(input.type).toLowerCase()
  const lower = message.toLowerCase()

  if (
    /context.{0,30}(length|limit|window)|maximum.{0,20}(context|token)|too many tokens|prompt.{0,20}long|input.{0,20}token|上下文|超出.*长度|token.*超限/.test(
      lower
    )
  )
    return 'AI_CONTEXT_LIMIT'
  if (
    /quota|insufficient[_ -]?quota|billing|credit|额度|余额|付费|rate.?limit|too many requests/.test(
      lower
    ) ||
    status === 402
  )
    return 'AI_QUOTA_EXCEEDED'
  if (
    status === 401 ||
    status === 403 ||
    /invalid api key|incorrect api key|authentication|unauthorized|api key.*invalid|认证信息|密钥无效/.test(
      lower
    )
  )
    return stage === 'send' ? 'WECHAT_AUTH_EXPIRED' : 'AI_AUTH_INVALID'
  if (/timeout|timed out|etimedout|超时/.test(lower)) {
    return stage === 'send' ? 'WECHAT_SEND_FAILED' : 'AI_TIMEOUT'
  }
  if (/database|db unavailable|数据库|数据库未|wcdb/.test(lower)) return 'DATABASE_UNAVAILABLE'
  if (/no messages|没有.*消息|没有可总结|消息为空/.test(lower)) return 'NO_MESSAGES'
  if (/chat.*not found|group.*not found|没有找到群|未找到群|不是群聊/.test(lower))
    return 'CHAT_NOT_FOUND'
  if (stage === 'persist' || /history|日报历史|保存.*日报/.test(lower))
    return 'REPORT_HISTORY_SAVE_FAILED'
  if (stage === 'send' || /wechat|微信|connector|发送/.test(lower)) return 'WECHAT_SEND_FAILED'
  if (
    stage === 'ai' &&
    (status >= 500 || /fetch failed|econnrefused|enotfound|network|unavailable|service/.test(lower))
  )
    return 'AI_PROVIDER_UNAVAILABLE'
  if (stage === 'ai') return 'REPORT_GENERATION_FAILED'
  if (type.includes('provider') || status >= 500) return 'AI_PROVIDER_UNAVAILABLE'
  return 'UNKNOWN'
}

export function normalizeScheduledReportError(
  input: unknown,
  fallbackStage: ScheduledReportExecutionStage = 'report'
): ScheduledReportErrorDetails {
  const record = asRecord(input)
  const source = (record && 'error' in record ? record.error : input) as unknown
  const sourceRecord = asRecord(source)
  const message = safeString(
    sourceRecord?.message || sourceRecord?.error || sourceRecord?.detail || source
  )
  const details: ScheduledReportErrorInput = {
    error: source,
    code: record?.code || sourceRecord?.code,
    status: record?.status || sourceRecord?.status,
    type: record?.type || sourceRecord?.type,
    stage: (record?.stage || fallbackStage) as ScheduledReportExecutionStage
  }
  const stage = details.stage || fallbackStage
  const code = inferCode(message, stage, details)
  const copy = messagesFor(code)
  return {
    code,
    stage: code === 'UNKNOWN' ? stage : stageForCode(code),
    technicalMessage: redact(message || '未知错误'),
    ...copy
  }
}

export function legacyScheduledReportError(
  code: ScheduledReportErrorCode,
  message: string
): string {
  const prefix: Record<ScheduledReportErrorCode, string> = {
    AI_CONTEXT_LIMIT: 'report_generation_failed',
    AI_QUOTA_EXCEEDED: 'report_generation_failed',
    AI_AUTH_INVALID: 'report_generation_failed',
    AI_PROVIDER_UNAVAILABLE: 'report_generation_failed',
    AI_TIMEOUT: 'report_generation_failed',
    DATABASE_UNAVAILABLE: 'report_generation_failed',
    CHAT_NOT_FOUND: 'report_generation_failed',
    NO_MESSAGES: 'report_generation_failed',
    REPORT_GENERATION_FAILED: 'report_generation_failed',
    REPORT_HISTORY_SAVE_FAILED: 'report_history_save_failed',
    WECHAT_SEND_UNAVAILABLE: 'wechat_not_ready',
    WECHAT_SEND_FAILED: 'wechat_send_failed',
    WECHAT_AUTH_EXPIRED: 'wechat_send_failed',
    UNKNOWN: 'scheduled_report_failed'
  }
  return `${prefix[code]}:${message}`
}
