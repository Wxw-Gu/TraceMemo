import type { AIChatToolCall, AIChatToolDefinition } from './ai-provider-service'
import { LOCAL_QUERY_TOOL_DEFINITIONS, type QueryTemporalBasisKind } from '../../shared/local-query-api'

const MAX_TOOL_CALLS = 5
const FORBIDDEN_INPUT_KEYS = new Set(['apiKey', 'authorization', 'token', 'databasePath', 'sql', 'wxid', 'md5'])
// 每个工具在“首次执行但结果为 0”之后允许的额外重试次数上限。
const ZERO_RESULT_RETRY_LIMIT = 1
// absolute 时间契约：LLM 只能给带时区的 ISO-8601 字符串，Host 负责换算成 Local Query API 的 epoch seconds。
const ISO_ABSOLUTE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/
// sanity 窗口：聊天记录不可能早于 2000 年，也不允许查询明显属于未来的区间。
const ABSOLUTE_MIN_MS = Date.UTC(2000, 0, 1)
const ABSOLUTE_MAX_FUTURE_MS = 366 * 24 * 60 * 60 * 1000
const ISO_ABSOLUTE_HINT = '带时区偏移的 ISO-8601，例如 2026-08-01T00:00:00+08:00 或 2026-07-31T16:00:00Z'

interface ToolSchema {
  type?: string
  description?: string
  required?: string[]
  additionalProperties?: boolean
  properties?: Record<string, ToolSchema>
  items?: ToolSchema
  enum?: unknown[]
  minLength?: number
  minimum?: number
  maximum?: number
  minItems?: number
  maxItems?: number
}

export interface ToolArgumentValidationError {
  status: 'invalid_tool_arguments'
  field: string
  constraint: string
  expected?: unknown
  actual?: unknown
  [key: string]: unknown
}

export interface QueryAgentProvider {
  getRuntimeConfig(): { configured: boolean; providerName: string; model: string; modelName: string }
  chatWithTools(
    messages: Array<Record<string, unknown>>,
    tools: AIChatToolDefinition[]
  ): Promise<{
    success: boolean
    data?: string
    toolCalls?: AIChatToolCall[]
    usage?: { input?: number; output?: number; total?: number; estimated?: boolean }
    error?: string
    /** 以下为诊断字段（additive，不参与业务语义） */
    elapsedMs?: number
    errorStatus?: number
    errorCode?: string
    errorType?: string
    errorContentType?: string
    timedOut?: boolean
    htmlInsteadOfJson?: boolean
  }>
}

export interface QueryAgentToolResult {
  status: string
  [key: string]: unknown
}

export interface QueryAgentTraceItem {
  toolName: string
  input: Record<string, unknown>
  durationMs: number
  status: string
  resultCount?: number
  evidenceCount?: number
  /** LLM 声明的 temporalBasis。Host 消费它决定 policy，但不会传给 Local Query API。 */
  temporalBasis?: { kind: QueryTemporalBasisKind; sourceText?: string }
  /** Host 自动执行的扩大查询（当前仅 temporalBasis.kind=recall_hint + 有界范围 + 0 结果）。 */
  autoFallback?: {
    reason: 'soft_temporal_hint_zero_result'
    timeRange: Record<string, unknown>
    status: string
    durationMs: number
    resultCount?: number
    evidenceCount?: number
  }
}

export interface QueryAgentModelCallDiagnostic {
  index: number
  elapsedMs: number
  status?: number
  contentType?: string
  timedOut?: boolean
  htmlInsteadOfJson?: boolean
  errorCode?: string
  errorType?: string
  error?: string
}

export interface QueryAgentPocResult {
  question: string
  provider: string
  model: string
  modelCallCount: number
  toolCallCount: number
  firstModelMs?: number
  toolTotalMs: number
  finalModelMs?: number
  totalMs: number
  /** 每次模型调用的耗时（含失败的那次），按调用顺序；additive 诊断字段 */
  modelDurationsMs: number[]
  /** 每次模型调用的请求级诊断；additive 诊断字段 */
  modelDiagnostics: QueryAgentModelCallDiagnostic[]
  traces: QueryAgentTraceItem[]
  answer?: string
  error?: string
}

export type QueryAgentToolExecutor = (
  name: string,
  input: Record<string, unknown>
) => Promise<QueryAgentToolResult>

const SYSTEM_PROMPT = `你是 TraceMemo 的本地聊天查询助手，只能使用提供的四个 Query Tool 获取事实，最终回答只基于 Tool Result。

规划原则：
- 先判断问题需要哪种证据，再调用最少的 Tool。每次收到 Tool Result 后都判断“当前 Evidence 是否已经足以给出有边界的回答”；足够就立即回答，不为追求绝对完整继续调查。
- query_messages 是精确事实查询，适用于能用联系人、时间、方向、消息类型、顺序等结构条件表达的问题。earliest/latest 等时间边界也是结构条件，必须使用 order 与 limit 精确查询，不能使用抽样 overview。每次调用都必须如实声明 temporalBasis。结果已经回答问题时，不要追加 conversation_overview。
- 需要绝对时间范围时，startTime/endTime 必须使用带时区偏移的 ISO-8601 字符串（例如 2026-08-01T00:00:00+08:00 或 2026-07-31T16:00:00Z）。不要传 epoch 数字，也不要传没有时区的裸本地时间。
- search_messages 是关键词检索，适用于结构条件无法确定答案的问题。queries 的每一项都是一次独立的字面检索：一项只放一个简短关键词，不要把多个近义词或整句话塞进同一项。首次最多 4 项。检索到 Evidence 后直接判断；只有本次完全没有 Evidence 时，才允许再检索一次，且每一项都必须与上一次实质不同。
- conversation_overview 只用于真正需要理解一个时间范围内整体聊了什么、主要话题或整体互动的 broad summary。它返回 temporal coverage sample，不代表完整聊天，也不是检索不足时的默认 fallback。
- message_context 只用于已经找到一条有价值 Evidence、但单条内容缺少前后语境而无法判断真实含义的情况。不要把它当作默认确认步骤；上下文足够后立即回答。
- 普通聊天查询不是 exhaustive investigation。经过合理的检索或可选 context 仍不足以形成强结论时，直接说明证据范围和不确定性，不要循环调用 search、overview、context。

事实边界：不得编造未返回的消息、猜测联系人、修改 resolvedTimeRange，或把 partial/unknown 当作 complete。coverage complete 且结果为 0 时，可以说明当前可读取的完整范围没有找到；coverage partial/unknown 且结果为 0 时，必须说明无法确认绝对不存在。不要把 sampled Evidence 当作完整聊天，也不要把 source message count 和 selected evidence count 混为一谈。
缺少必要信息时用自然语言澄清；超出工具能力时说明不能可靠完成，并给出当前工具可以执行的替代方向。`

function toolDefinitions(): AIChatToolDefinition[] {
  return LOCAL_QUERY_TOOL_DEFINITIONS.map((tool) => ({
    type: 'function' as const,
    function: { name: tool.name, description: tool.description, parameters: tool.parameters }
  }))
}

function toolDefinition(name: string): AIChatToolDefinition[] {
  return toolDefinitions().filter((tool) => tool.function.name === name)
}

function sanitizeInput(input: Record<string, unknown>): Record<string, unknown> {
  const sanitizeValue = (value: unknown): unknown => {
    if (typeof value === 'string') return value.length > 240 ? `${value.slice(0, 240)}...` : value
    if (Array.isArray(value)) return value.slice(0, 8).map(sanitizeValue)
    if (value && typeof value === 'object') return sanitizeInput(value as Record<string, unknown>)
    return value
  }
  const output: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (key === 'messageRef') output[key] = '[opaque-message-ref]'
    else if (!FORBIDDEN_INPUT_KEYS.has(key)) output[key] = sanitizeValue(value)
  }
  return output
}

function containsForbiddenKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenKey)
  if (!value || typeof value !== 'object') return false
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => FORBIDDEN_INPUT_KEYS.has(key) || containsForbiddenKey(child))
}

function actualType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function schemaTypeMatches(value: unknown, type: string): boolean {
  if (type === 'object') return Boolean(value && typeof value === 'object' && !Array.isArray(value))
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value)
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  return actualType(value) === type
}

function validateSchema(value: unknown, schema: ToolSchema, field = '$'): ToolArgumentValidationError | undefined {
  if (schema.type && !schemaTypeMatches(value, schema.type)) {
    return { status: 'invalid_tool_arguments', field, constraint: 'type', expected: schema.type, actual: actualType(value) }
  }
  if (schema.enum && !schema.enum.some((allowed) => Object.is(allowed, value))) {
    return { status: 'invalid_tool_arguments', field, constraint: 'enum', expected: schema.enum, actual: value }
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      return { status: 'invalid_tool_arguments', field, constraint: 'minLength', expected: schema.minLength, actual: value.length }
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      return { status: 'invalid_tool_arguments', field, constraint: 'minimum', expected: schema.minimum, actual: value }
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      return { status: 'invalid_tool_arguments', field, constraint: 'maximum', expected: schema.maximum, actual: value }
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      return { status: 'invalid_tool_arguments', field, constraint: 'minItems', expected: schema.minItems, actual: value.length }
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      return { status: 'invalid_tool_arguments', field, constraint: 'maxItems', expected: schema.maxItems, actual: value.length }
    }
    if (schema.items) {
      for (let index = 0; index < value.length; index += 1) {
        const error = validateSchema(value[index], schema.items, `${field}[${index}]`)
        if (error) return error
      }
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const objectValue = value as Record<string, unknown>
    for (const required of schema.required || []) {
      if (!(required in objectValue)) {
        return { status: 'invalid_tool_arguments', field: field === '$' ? required : `${field}.${required}`, constraint: 'required', expected: true, actual: false }
      }
    }
    const properties = schema.properties || {}
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(objectValue)) {
        if (!(key in properties)) {
          return { status: 'invalid_tool_arguments', field: field === '$' ? key : `${field}.${key}`, constraint: 'additionalProperties', expected: false, actual: true }
        }
      }
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (key in objectValue) {
        const error = validateSchema(objectValue[key], childSchema, field === '$' ? key : `${field}.${key}`)
        if (error) return error
      }
    }
  }
  return undefined
}

function argError(field: string, constraint: string, expected?: unknown, actual?: unknown, hint?: string): ToolArgumentValidationError {
  return { status: 'invalid_tool_arguments', field, constraint, ...(expected === undefined ? {} : { expected }), ...(actual === undefined ? {} : { actual }), ...(hint ? { hint } : {}) }
}

/**
 * 解析 LLM 提供的绝对时间。只接受带显式时区偏移（或 Z）的 ISO-8601；
 * 无时区、epoch 数字、非法日历日一律返回 undefined，由调用方转成可修正的 invalid_tool_arguments。
 */
function parseIsoInstant(value: string): number | undefined {
  const match = ISO_ABSOLUTE_PATTERN.exec(value.trim())
  if (!match) return undefined
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return undefined
  // 先在 UTC 语义下校验字面日期真实存在，再套用时区偏移，避免 2 月 31 日被静默进位。
  const naiveMs = Date.UTC(year, month - 1, day, hour, minute, second)
  const naive = new Date(naiveMs)
  if (naive.getUTCFullYear() !== year || naive.getUTCMonth() !== month - 1 || naive.getUTCDate() !== day) return undefined
  const offset = match[7]
  if (offset === 'Z') return naiveMs
  const sign = offset.startsWith('-') ? -1 : 1
  const offsetHour = Number(offset.slice(1, 3))
  const offsetMinute = Number(offset.slice(4, 6))
  if (offsetHour > 23 || offsetMinute > 59) return undefined
  return naiveMs - sign * (offsetHour * 60 + offsetMinute) * 60000
}

function canonicalizeTimeRange(timeRange: Record<string, unknown>, now: Date): { value?: Record<string, unknown>; error?: ToolArgumentValidationError } {
  const startTime = timeRange.startTime
  const endTime = timeRange.endTime
  if (timeRange.kind !== 'absolute') {
    // 非 absolute 语义下 startTime/endTime 无意义，直接丢弃，避免残留数值进入 Query API。
    const { startTime: _startTime, endTime: _endTime, ...rest } = timeRange
    return { value: rest }
  }
  if (typeof startTime !== 'string' || typeof endTime !== 'string') {
    return { error: argError('timeRange.startTime', 'required', ISO_ABSOLUTE_HINT, actualType(startTime ?? endTime), ISO_ABSOLUTE_HINT) }
  }
  const startMs = parseIsoInstant(startTime)
  if (startMs === undefined) return { error: argError('timeRange.startTime', 'format', ISO_ABSOLUTE_HINT, startTime, ISO_ABSOLUTE_HINT) }
  const endMs = parseIsoInstant(endTime)
  if (endMs === undefined) return { error: argError('timeRange.endTime', 'format', ISO_ABSOLUTE_HINT, endTime, ISO_ABSOLUTE_HINT) }
  if (endMs < startMs) return { error: argError('timeRange.endTime', 'range_order', 'endTime 不得早于 startTime', endTime) }
  const latestMs = now.getTime() + ABSOLUTE_MAX_FUTURE_MS
  const sanityWindow = `2000-01-01 至 ${new Date(latestMs).toISOString()}`
  if (startMs < ABSOLUTE_MIN_MS || startMs > latestMs) return { error: argError('timeRange.startTime', 'range_sanity', sanityWindow, startTime) }
  if (endMs < ABSOLUTE_MIN_MS || endMs > latestMs) return { error: argError('timeRange.endTime', 'range_sanity', sanityWindow, endTime) }
  // 通过全部校验后才换算成 Local Query API 使用的 epoch seconds。
  return { value: { kind: 'absolute', startTime: Math.floor(startMs / 1000), endTime: Math.floor(endMs / 1000) } }
}

/** canonical（已剥离、已校验）的 temporalBasis。 */
interface CanonicalTemporalBasis {
  kind: QueryTemporalBasisKind
  sourceText?: string
}

/**
 * LLM Tool Adapter 的 canonicalization：
 * - temporalBasis 是 LLM-facing 元数据：Host 用它决定 policy，但**剥离**后不传给 Local Query API
 * - absolute 的 ISO-8601 → Local Query API 的 epoch seconds
 * - search_messages 的 queries[] → Local Query API 的 query + variants
 *
 * 这里只做**纯 lexical** 校验（sourceText 是否为用户问题子串 + kind 与 timeRange 是否自洽），
 * 不解释时间短语的意思。
 */
function canonicalizeToolInput(
  name: string,
  input: Record<string, unknown>,
  now: Date,
  question: string
): { input?: Record<string, unknown>; temporalBasis?: CanonicalTemporalBasis; error?: ToolArgumentValidationError } {
  const output: Record<string, unknown> = { ...input }
  const rawBasis = output.temporalBasis
  delete output.temporalBasis

  let temporalBasis: CanonicalTemporalBasis | undefined
  if (rawBasis && typeof rawBasis === 'object' && !Array.isArray(rawBasis)) {
    const record = rawBasis as Record<string, unknown>
    const kind = record.kind
    if (kind === 'constraint' || kind === 'recall_hint' || kind === 'none') {
      const sourceText = typeof record.sourceText === 'string' ? record.sourceText.trim() : undefined
      if (kind === 'none') {
        if (sourceText) {
          return { error: argError('temporalBasis.sourceText', 'forbidden_for_none', null, sourceText, 'kind=none 表示问题里没有任何时间表达，此时不要提供 sourceText。') }
        }
      } else if (!sourceText) {
        return { error: argError('temporalBasis.sourceText', 'required', '用户原问题中的时间原文片段', undefined, `kind=${kind} 时必须给出用户原问题中实际出现的时间片段。`) }
      } else if (!question.includes(sourceText)) {
        return { error: argError('temporalBasis.sourceText', 'source_not_in_question', question, sourceText, 'sourceText 必须是用户原问题中逐字出现的片段，不要改写、翻译或补全。') }
      }
      temporalBasis = { kind, ...(sourceText ? { sourceText } : {}) }
    }
  }

  if (output.timeRange && typeof output.timeRange === 'object' && !Array.isArray(output.timeRange)) {
    const canonical = canonicalizeTimeRange(output.timeRange as Record<string, unknown>, now)
    if (canonical.error) return { error: canonical.error }
    output.timeRange = canonical.value
  }

  // 用户没给任何时间表达时，不得凭空造一个有界范围（earliest/latest 用 order/limit 表达）。
  if (temporalBasis?.kind === 'none') {
    const kind = rangeKind(output)
    if (kind && kind !== 'all') {
      return { error: argError('timeRange', 'temporal_basis_mismatch', 'timeRange.kind=all', output.timeRange, '用户没有给出任何时间表达（temporalBasis.kind=none）。请改用 timeRange.kind=all；如果需要 earliest/latest 这类边界，用 order 与 limit 表达。') }
    }
  }

  if (name === 'search_messages') {
    const raw = Array.isArray(output.queries) ? (output.queries as unknown[]) : []
    const probes = raw.filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean)
    if (!probes.length) return { error: argError('queries', 'required', '至少一个非空检索项') }
    const [first, ...rest] = probes
    delete output.queries
    output.query = first
    if (rest.length) output.variants = rest
  }
  return { input: output, temporalBasis }
}

interface ZeroResultRetryState {
  searchAttempts: number
  searchSignatures: string[]
  queryAttempts: number
  querySignatures: string[]
  /**
   * temporalBasis.kind=constraint 的 query_messages 一旦执行，就锁定其 canonical timeRange。
   * 后续 retry 若替换时间范围会被拒绝 —— 用户明确给出的时间边界不得扩大。
   */
  lockedConstraintRange?: { signature: string; timeRange: Record<string, unknown> }
}

function newRetryState(): ZeroResultRetryState {
  return { searchAttempts: 0, searchSignatures: [], queryAttempts: 0, querySignatures: [] }
}

/** Host 自动执行的扩大查询原因（当前只有一种）。 */
const AUTO_FALLBACK_REASON = 'soft_temporal_hint_zero_result' as const

function rangeKind(input: Record<string, unknown>): string | undefined {
  const range = input.timeRange
  if (!range || typeof range !== 'object' || Array.isArray(range)) return undefined
  const kind = (range as Record<string, unknown>).kind
  return typeof kind === 'string' ? kind : undefined
}

/**
 * constraint 时间边界锁定：时间来源由 LLM 判断（temporalBasis），
 * 但"不得扩大"由 Host 结构性保证，不依赖 prompt。
 */
function lockConstraintTimeRange(
  name: string,
  temporalBasis: CanonicalTemporalBasis | undefined,
  input: Record<string, unknown>,
  state: ZeroResultRetryState
): ToolArgumentValidationError | undefined {
  if (name !== 'query_messages' || temporalBasis?.kind !== 'constraint') return undefined
  const signature = JSON.stringify(input.timeRange ?? null)
  if (!state.lockedConstraintRange) {
    state.lockedConstraintRange = { signature, timeRange: (input.timeRange as Record<string, unknown>) ?? {} }
    return undefined
  }
  if (state.lockedConstraintRange.signature === signature) return undefined
  return argError('timeRange', 'constraint_time_range_immutable', state.lockedConstraintRange.timeRange, input.timeRange, '用户明确给出的时间范围不得改变；只能放宽 direction / messageTypes 等非时间条件。')
}

/**
 * 只有"LLM 自己推断的近似时间范围（recall_hint）+ 有界范围 + 首次 0 结果"才自动扩大。
 * 已经是 all 时无需扩大；constraint 一律不扩大（由 lockConstraintTimeRange 保证）。
 */
function shouldAutoBroaden(
  name: string,
  temporalBasis: CanonicalTemporalBasis | undefined,
  input: Record<string, unknown>,
  result: QueryAgentToolResult
): boolean {
  if (name !== 'query_messages') return false
  if (temporalBasis?.kind !== 'recall_hint') return false
  if (resultCount(result).resultCount !== 0) return false
  return rangeKind(input) !== 'all'
}

function normalizedTarget(input: Record<string, unknown>): string {
  const target = input.target
  const query = target && typeof target === 'object' ? (target as Record<string, unknown>).query : undefined
  return typeof query === 'string' ? query.trim().toLowerCase() : ''
}

/** 只覆盖“实质条件”：忽略 limit/order/excludeSystem 这类不改变检索语义的字段。 */
function retrySignature(name: string, input: Record<string, unknown>): string {
  if (name === 'search_messages') {
    const probes = [input.query, ...(Array.isArray(input.variants) ? input.variants : [])]
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim().toLowerCase())
    return JSON.stringify({ target: normalizedTarget(input), timeRange: input.timeRange ?? null, probes: Array.from(new Set(probes)).sort() })
  }
  const messageTypes = Array.isArray(input.messageTypes) ? [...(input.messageTypes as string[])].sort() : []
  return JSON.stringify({ target: normalizedTarget(input), timeRange: input.timeRange ?? null, direction: input.direction ?? null, messageTypes })
}

function duplicateRetry(name: string, input: Record<string, unknown>, state: ZeroResultRetryState): boolean {
  const signature = retrySignature(name, input)
  if (name === 'search_messages') return state.searchSignatures.includes(signature)
  if (name === 'query_messages') return state.querySignatures.includes(signature)
  return false
}

function recordAttempt(name: string, input: Record<string, unknown>, state: ZeroResultRetryState): void {
  if (name === 'search_messages') { state.searchAttempts += 1; state.searchSignatures.push(retrySignature(name, input)) }
  else if (name === 'query_messages') { state.queryAttempts += 1; state.querySignatures.push(retrySignature(name, input)) }
}

function retryNote(name: string, result: QueryAgentToolResult, state: ZeroResultRetryState): string | undefined {
  if (result.constraint === 'duplicate_retry') return '本次重试的条件与上一次完全相同，已被拒绝；请改用实质不同的条件，或直接基于现有结果作答。'
  if (result.status !== 'completed') return undefined
  const counts = resultCount(result)
  if (name === 'search_messages' && !counts.evidenceCount && state.searchAttempts <= ZERO_RESULT_RETRY_LIMIT) return '本次检索没有任何 Evidence。允许再执行一次 search_messages，但每一项都必须与上一次实质不同；完全相同的检索会被拒绝。'
  if (name === 'query_messages' && counts.resultCount === 0 && !result.fallbackLookup && state.queryAttempts <= ZERO_RESULT_RETRY_LIMIT) return '本次精确查询返回 0 条。允许再执行一次 query_messages，用于放宽 direction 或 messageTypes 等非时间条件；改变时间范围会被拒绝。'
  return undefined
}

export function validateToolArguments(
  name: string,
  value: unknown,
  now: Date = new Date(),
  question = ''
): { input?: Record<string, unknown>; temporalBasis?: CanonicalTemporalBasis; error?: ToolArgumentValidationError } {
  const definition = LOCAL_QUERY_TOOL_DEFINITIONS.find((tool) => tool.name === name)
  if (!definition) return { error: argError('$', 'tool', 'supported tool', name) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: argError('$', 'type', 'object', actualType(value)) }
  }
  if (containsForbiddenKey(value)) {
    return { error: argError('$', 'forbidden_field') }
  }
  const error = validateSchema(value, definition.parameters as ToolSchema)
  if (error) return { error }
  return canonicalizeToolInput(name, value as Record<string, unknown>, now, question)
}

function resultCount(result: QueryAgentToolResult): { resultCount?: number; evidenceCount?: number } {
  return {
    resultCount: typeof result.returnedCount === 'number' ? result.returnedCount : undefined,
    evidenceCount: typeof result.evidenceCount === 'number' ? result.evidenceCount : Array.isArray(result.evidence) ? result.evidence.length : undefined
  }
}

function messageRecordForModel(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const record = value as Record<string, unknown>
  return record.messageType || !record.sourceKind ? record : { ...record, messageType: record.sourceKind }
}

function toolResultForModel(name: string, result: QueryAgentToolResult, callsUsed: number, nextTools: AIChatToolDefinition[], note?: string): QueryAgentToolResult {
  const visible: QueryAgentToolResult = { ...result }
  if (Array.isArray(result.messages)) visible.messages = result.messages.map(messageRecordForModel)
  if (Array.isArray(result.evidence)) visible.evidence = result.evidence.map(messageRecordForModel)
  if (result.anchor) visible.anchor = messageRecordForModel(result.anchor)
  if (Array.isArray(result.before)) visible.before = result.before.map(messageRecordForModel)
  if (Array.isArray(result.after)) visible.after = result.after.map(messageRecordForModel)
  if (result.fallbackLookup && typeof result.fallbackLookup === 'object') {
    const fallback = result.fallbackLookup as Record<string, unknown>
    visible.fallbackLookup = {
      ...fallback,
      ...(Array.isArray(fallback.messages) ? { messages: fallback.messages.map(messageRecordForModel) } : {})
    }
  }
  visible._agent = {
    toolName: name,
    toolCallsUsed: callsUsed,
    toolCallsRemaining: Math.max(0, MAX_TOOL_CALLS - callsUsed),
    availableNextTools: nextTools.map((tool) => tool.function.name),
    ...(note ? { note } : {}),
    instruction: [
      nextTools.length
        ? '先判断当前 Evidence 是否足以回答；足够就立即回答，只在含义仍有明确歧义时使用当前可用 Tool。'
        : '工具阶段已经结束。必须直接给出有边界的最终回答，不得再调用 Tool。',
      result.fallbackLookup
        ? '本次结果有两个 scope：顶层是原查询，fallbackLookup 是系统自动扩大到全部历史后的结果。回答时必须分别说明这两个范围，不要让用户以为原问题就是按“全部历史”提出的。'
        : undefined,
      note
    ].filter(Boolean).join(' ')
  }
  return visible
}

function nextToolDefinitions(name: string, result: QueryAgentToolResult, state: ZeroResultRetryState, rangeWasAll = false): AIChatToolDefinition[] {
  // 重复重试已被拒绝，不再开放工具，避免用有限的 tool budget 反复试同一条件。
  if (result.constraint === 'duplicate_retry') return []
  if (result.status === 'invalid_tool_arguments') return toolDefinition(name)
  if (result.status !== 'completed') return []
  const counts = resultCount(result)
  if (name === 'search_messages') {
    // 有 Evidence 时保持原有高效路径：只允许补一次上下文。
    if (counts.evidenceCount) return toolDefinition('message_context')
    // 首次检索完全没有 Evidence：允许一次实质不同的重试，之后关闭。
    return state.searchAttempts <= ZERO_RESULT_RETRY_LIMIT ? toolDefinition('search_messages') : []
  }
  if (name === 'query_messages') {
    // Host 已经自动执行过一次扩大查询：不再开放 retry，避免出现第三次查询。
    if (result.fallbackLookup) return []
    // 已经查了全部历史且 0 结果：再换时间范围毫无意义（更窄只会更少）。
    if (rangeWasAll && counts.resultCount === 0) return []
    // 只有 0 结果才开放一次重试；有结果时保持原有 stopping。
    return counts.resultCount === 0 && state.queryAttempts <= ZERO_RESULT_RETRY_LIMIT ? toolDefinition('query_messages') : []
  }
  return []
}

export class QueryAgentPocService {
  constructor(
    private readonly provider: QueryAgentProvider,
    private readonly executeTool: QueryAgentToolExecutor,
    private readonly nowProvider: () => Date = () => new Date()
  ) {}

  async run(question: string): Promise<QueryAgentPocResult> {
    const trimmed = question.trim()
    const startedAt = Date.now()
    const runtime = this.provider.getRuntimeConfig()
    const result: QueryAgentPocResult = { question: trimmed, provider: runtime.providerName, model: runtime.modelName || runtime.model, modelCallCount: 0, toolCallCount: 0, toolTotalMs: 0, totalMs: 0, traces: [], modelDurationsMs: [], modelDiagnostics: [] }
    if (!trimmed) return { ...result, error: '请输入查询问题', totalMs: Date.now() - startedAt }
    if (!runtime.configured) return { ...result, error: '当前 AI Provider 尚未配置', totalMs: Date.now() - startedAt }

    const messages: Array<Record<string, unknown>> = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: trimmed }
    ]
    let tools = toolDefinitions()
    const retry = newRetryState()
    const now = this.nowProvider()
    let firstModelAt: number | undefined
    let finalModelDuration: number | undefined
    while (result.toolCallCount < MAX_TOOL_CALLS) {
      const modelStartedAt = Date.now()
      const model = await this.provider.chatWithTools(messages, tools)
      result.modelCallCount += 1
      const modelDuration = Date.now() - modelStartedAt
      // 无论成功失败都记录本次调用耗时与请求级诊断，便于区分模型慢 / 工具慢 / 上游错误。
      result.modelDurationsMs.push(modelDuration)
      result.modelDiagnostics.push({
        index: result.modelCallCount,
        elapsedMs: typeof model.elapsedMs === 'number' ? model.elapsedMs : modelDuration,
        ...(model.errorStatus !== undefined ? { status: model.errorStatus } : {}),
        ...(model.errorContentType ? { contentType: model.errorContentType } : {}),
        ...(model.timedOut ? { timedOut: true } : {}),
        ...(model.htmlInsteadOfJson ? { htmlInsteadOfJson: true } : {}),
        ...(model.errorCode ? { errorCode: model.errorCode } : {}),
        ...(model.errorType ? { errorType: model.errorType } : {}),
        ...(model.success ? {} : { error: model.error || '模型调用失败' })
      })
      if (firstModelAt === undefined) firstModelAt = Date.now()
      if (!model.success) return { ...result, error: model.error || '模型调用失败', firstModelMs: firstModelAt - startedAt, totalMs: Date.now() - startedAt }
      const calls = model.toolCalls || []
      if (calls.length === 0) {
        finalModelDuration = modelDuration
        result.answer = model.data?.trim() || '模型未返回答案'
        result.firstModelMs = firstModelAt - startedAt
        result.finalModelMs = finalModelDuration
        result.totalMs = Date.now() - startedAt
        return result
      }
      if (result.toolCallCount + calls.length > MAX_TOOL_CALLS) {
        return { ...result, error: `超过最大工具调用次数（${MAX_TOOL_CALLS}）`, firstModelMs: firstModelAt - startedAt, totalMs: Date.now() - startedAt }
      }
      messages.push({ role: 'assistant', content: model.data || '', tool_calls: calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) })
      for (const call of calls) {
        const inputStartedAt = Date.now()
        let toolResult: QueryAgentToolResult | undefined
        let traceInput: Record<string, unknown> = {}
        let temporalBasis: CanonicalTemporalBasis | undefined
        let autoFallback: QueryAgentTraceItem['autoFallback']
        try {
          if (!tools.some((tool) => tool.function.name === call.name)) {
            toolResult = { status: 'invalid_tool_arguments', field: '$', constraint: 'tool_availability', expected: tools.map((tool) => tool.function.name), actual: call.name }
          }
          if (!toolResult) {
            let parsed: unknown
            try { parsed = JSON.parse(call.arguments || '{}') } catch {
              toolResult = { status: 'invalid_tool_arguments', field: '$', constraint: 'json' }
            }
            if (!toolResult) {
              const validated = validateToolArguments(call.name, parsed, now, trimmed)
              if (validated.error) {
                toolResult = validated.error
              } else {
                traceInput = validated.input || {}
                temporalBasis = validated.temporalBasis
                // constraint 时间边界由 Host 结构性锁定：不依赖 prompt，也不静默改写用户问题。
                const constraintViolation = lockConstraintTimeRange(call.name, temporalBasis, traceInput, retry)
                if (constraintViolation) {
                  toolResult = constraintViolation
                } else if (duplicateRetry(call.name, traceInput, retry)) {
                  // 明确拒绝“换关键词重搜”里的 identical retry，让模型改用实质不同的条件。
                  toolResult = { status: 'invalid_tool_arguments', field: '$', constraint: 'duplicate_retry', expected: '与上一次实质不同的条件', actual: '与上一次完全相同的条件' }
                } else {
                  recordAttempt(call.name, traceInput, retry)
                  const primary = await this.executeTool(call.name, traceInput)
                  toolResult = primary
                  // recall_hint + 有界范围 + 0 结果 → Host 自动做一次“全部历史”corrective lookup。
                  // 这是一次本地 Query API 调用：不增加 LLM 往返，也不占用 MAX_TOOL_CALLS。
                  if (shouldAutoBroaden(call.name, temporalBasis, traceInput, primary)) {
                    const fallbackStartedAt = Date.now()
                    const fallbackResult = await this.executeTool('query_messages', { ...traceInput, timeRange: { kind: 'all' } })
                    const fallbackCounts = resultCount(fallbackResult)
                    autoFallback = { reason: AUTO_FALLBACK_REASON, timeRange: { kind: 'all' }, status: fallbackResult.status, durationMs: Date.now() - fallbackStartedAt, ...fallbackCounts }
                    toolResult = {
                      ...primary,
                      fallbackLookup: {
                        reason: AUTO_FALLBACK_REASON,
                        explanation: '你的 temporalBasis.kind=recall_hint 表示该时间范围只是你推断的回忆线索，并非用户给出的硬边界；首次查询为 0 条，系统已自动在全部历史中再查一次。请分别说明这两个范围的结果。',
                        timeRange: { kind: 'all' },
                        status: fallbackResult.status,
                        resolvedTimeRange: fallbackResult.resolvedTimeRange,
                        coverage: fallbackResult.coverage,
                        returnedCount: fallbackResult.returnedCount,
                        messages: fallbackResult.messages
                      }
                    }
                  }
                }
              }
            }
          }
        } catch (error) {
          if (!toolResult) toolResult = { status: 'invalid_request', error: error instanceof Error ? error.message : '工具调用失败' }
        }
        const completedToolResult = toolResult || { status: 'invalid_request', error: '工具调用失败' }
        const durationMs = Date.now() - inputStartedAt
        result.toolCallCount += 1
        result.toolTotalMs += durationMs
        const counts = resultCount(completedToolResult)
        result.traces.push({ toolName: call.name, input: sanitizeInput(traceInput), durationMs, status: completedToolResult.status, ...counts, ...(temporalBasis ? { temporalBasis } : {}), ...(autoFallback ? { autoFallback } : {}) })
        const nextTools = completedToolResult.constraint === 'tool_availability'
          ? tools
          : nextToolDefinitions(call.name, completedToolResult, retry, rangeKind(traceInput) === 'all')
        const note = retryNote(call.name, completedToolResult, retry)
        messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: JSON.stringify(toolResultForModel(call.name, completedToolResult, result.toolCallCount, nextTools, note)) })
        tools = nextTools
      }
    }
    result.firstModelMs = firstModelAt ? firstModelAt - startedAt : undefined
    result.totalMs = Date.now() - startedAt
    return { ...result, error: `超过最大工具调用次数（${MAX_TOOL_CALLS}）` }
  }
}
