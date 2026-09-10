import type { AIChatToolCall, AIChatToolDefinition } from './ai-provider-service'
import { LOCAL_QUERY_TOOL_DEFINITIONS } from '../../shared/local-query-api'

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
- query_messages 是精确事实查询，适用于能用联系人、时间、方向、消息类型、顺序等结构条件表达的问题。earliest/latest 等时间边界也是结构条件，必须使用 order 与 limit 精确查询，不能使用抽样 overview。结果已经回答问题时，不要追加 conversation_overview。若返回 0 条且你判断是时间范围或结构条件不合适，允许再查一次并合理扩大或更换条件，但必须与上一次实质不同。
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

/**
 * LLM Tool Adapter 的 canonicalization：
 * - absolute 的 ISO-8601 → Local Query API 的 epoch seconds
 * - search_messages 的 queries[] → Local Query API 的 query + variants
 */
function canonicalizeToolInput(name: string, input: Record<string, unknown>, now: Date): { input?: Record<string, unknown>; error?: ToolArgumentValidationError } {
  const output: Record<string, unknown> = { ...input }
  if (output.timeRange && typeof output.timeRange === 'object' && !Array.isArray(output.timeRange)) {
    const canonical = canonicalizeTimeRange(output.timeRange as Record<string, unknown>, now)
    if (canonical.error) return { error: canonical.error }
    output.timeRange = canonical.value
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
  return { input: output }
}

interface ZeroResultRetryState {
  searchAttempts: number
  searchSignatures: string[]
  queryAttempts: number
  querySignatures: string[]
}

function newRetryState(): ZeroResultRetryState {
  return { searchAttempts: 0, searchSignatures: [], queryAttempts: 0, querySignatures: [] }
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
  if (name === 'query_messages' && counts.resultCount === 0 && state.queryAttempts <= ZERO_RESULT_RETRY_LIMIT) return '本次精确查询返回 0 条。允许再执行一次 query_messages，用于合理扩大或更换时间范围、方向或消息类型；完全相同的条件会被拒绝。'
  return undefined
}

export function validateToolArguments(name: string, value: unknown, now: Date = new Date()): { input?: Record<string, unknown>; error?: ToolArgumentValidationError } {
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
  return canonicalizeToolInput(name, value as Record<string, unknown>, now)
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
      note
    ].filter(Boolean).join(' ')
  }
  return visible
}

function nextToolDefinitions(name: string, result: QueryAgentToolResult, state: ZeroResultRetryState): AIChatToolDefinition[] {
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
              const validated = validateToolArguments(call.name, parsed, now)
              if (validated.error) {
                toolResult = validated.error
              } else {
                traceInput = validated.input || {}
                if (duplicateRetry(call.name, traceInput, retry)) {
                  // 明确拒绝“换关键词重搜”里的 identical retry，让模型改用实质不同的条件。
                  toolResult = { status: 'invalid_tool_arguments', field: '$', constraint: 'duplicate_retry', expected: '与上一次实质不同的条件', actual: '与上一次完全相同的条件' }
                } else {
                  recordAttempt(call.name, traceInput, retry)
                  toolResult = await this.executeTool(call.name, traceInput)
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
        result.traces.push({ toolName: call.name, input: sanitizeInput(traceInput), durationMs, status: completedToolResult.status, ...counts })
        const nextTools = completedToolResult.constraint === 'tool_availability'
          ? tools
          : nextToolDefinitions(call.name, completedToolResult, retry)
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
