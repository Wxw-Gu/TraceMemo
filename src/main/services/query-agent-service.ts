/**
 * Shared Query Agent runtime used by Ask WeChat, Agent Hub, and the CLI harness.
 * Query semantics and tool orchestration are centralized here — prompt, tool mapping,
 * validation, temporal policy, retry/stopping, and the bounded model loop — so every
 * entry point behaves consistently; they differ only by injected tool executor and adapter.
 */
import type { AIChatToolCall, AIChatToolDefinition } from './ai-provider-service'
import {
  LOCAL_QUERY_TOOL_DEFINITIONS,
  type QueryCorpusScope,
  type QuerySearchTimings,
  type QueryTemporalBasisKind
} from '../../shared/local-query-api'
// 进度事件定义在 shared（renderer 也要用），这里只是把它带进本文件作用域。
import type {
  QueryAgentProgressEvent,
  QueryAgentProgressStage
} from '../../shared/query-agent'

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
  /** 会话概览覆盖的源消息条数（additive，用于 UI 顶部真实统计）。 */
  sourceMessageCount?: number
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
  /**
   * Engine 侧的真实耗时分解（ADDITIVE 诊断）。
   *
   * 由 `search_messages` 的 Tool Result 携带，**不会进入模型上下文**（`toolResultForModel`
   * 会剥离）。用途：把不透明的 Tool 总耗时拆成 scope / freshness / 每个 probe / 合并 / 证据补全。
   */
  searchTimings?: QuerySearchTimings
  /**
   * 本次 Tool Result 里携带 OCR 派生文本的图片消息/证据条数（诊断用，不进模型上下文）。
   *
   * 存在的意义是让"图片已经识别出文字、但模型没拿到"这类**链路断点**可以被直接观测：
   * 真机上曾经出现过 `query_messages` 返回了图片消息却只带 `attachment`、
   * 模型因此回答"没有取得 OCR 文字"。当时从回答文本无法判断是"索引没建"还是"没接上"，
   * 因为这两件事在日志里长得一模一样。有了这个数字就能一眼分开。
   */
  imageOcrTextCount?: number
  /** 本次 Tool Result 里图片文字索引的覆盖度状态（`not_built` / `partial` / `complete` / `failed`）。 */
  imageOcrCoverageState?: string
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

/**
 * 失败分类（additive 诊断字段，供 Adapter 决定展示与是否允许 Legacy fallback）。
 *
 * 'provider_unavailable' = Provider 未配置；'provider_failure' = 模型请求本身失败
 * （网络 / 上游 / 超时）。未分类的异常由 Adapter 归类为 runtime_error。
 */
export type QueryAgentErrorKind = 'invalid_question' | 'provider_unavailable' | 'provider_failure' | 'tool_limit'

/**
 * 多轮澄清所需的最小历史。**由 Adapter 提供**，Runtime 只负责按顺序放进 messages。
 * Runtime 自身仍然是无状态单轮执行器；历史长度 / 保留时间的边界由调用方负责。
 */
export interface QueryAgentHistoryTurn {
  question: string
  answer: string
}

export interface QueryAgentResult {
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
  /** 失败分类；additive 诊断字段，成功时为 undefined */
  errorKind?: QueryAgentErrorKind
  /** 本次回答实际依据的证据（additive）；按首次命中顺序去重。 */
  evidence?: QueryAgentEvidenceItem[]
}

/**
 * 语料边界（conversation scope）：由 UI / Adapter 传入，**不是** LLM 的输入。
 * `label` 只用于给模型描述"当前范围是什么"，强制逻辑完全在 Engine（target 越界会被拒绝）。
 */
export interface QueryAgentConversationScope {
  scope: QueryCorpusScope
  label?: string
}

/** 单次 Tool 执行的上下文（由 Runtime 注入，LLM 无法提供）。 */
export interface QueryAgentToolContext {
  conversationScope?: QueryCorpusScope
}

export type QueryAgentToolExecutor = (
  name: string,
  input: Record<string, unknown>,
  context?: QueryAgentToolContext
) => Promise<QueryAgentToolResult>

/**
 * 本次回答实际依据的证据（ADDITIVE，供 Adapter 展示）。
 * 只保留可展示字段；messageRef 仍是 opaque 引用。
 */
export interface QueryAgentEvidenceItem {
  messageRef: string
  conversationName?: string
  conversationType?: 'user' | 'group'
  sender?: string
  /** epoch ms */
  timestamp?: number
  messageType?: string
  text?: string
  attachment?: { kind?: string; name?: string; url?: string; sizeBytes?: number }
  /** 产生这条证据的 Tool 名（诊断 / UI 分组用）。 */
  source: string
}

/** 一次回答最多带出多少条证据（IPC 体积与 UI 噪声控制）。 */
const MAX_EVIDENCE_ITEMS = 40


const SYSTEM_PROMPT = `你是 TraceMemo 的本地聊天查询助手，只能使用提供的四个 Query Tool 获取事实，最终回答只基于 Tool Result。

规划原则：
- 先判断问题需要哪种证据，再调用最少的 Tool。每次收到 Tool Result 后都判断“当前 Evidence 是否已经足以给出有边界的回答”；足够就立即回答，不为追求绝对完整继续调查。
- query_messages 是精确事实查询，适用于能用联系人、时间、方向、消息类型、顺序等结构条件表达的问题。earliest/latest 等时间边界也是结构条件，必须使用 order 与 limit 精确查询，不能使用抽样 overview。每次调用都必须如实声明 temporalBasis。结果已经回答问题时，不要追加 conversation_overview。
方向（direction）必须按**说话人是谁**来定，不要按语序猜：
- direction 的参照物是“目标会话”：to_target = **我发出**的（说话人是我自己），from_target = **对方发来**的。没有 other 取值，拿不准就用 any。
- 说话人是我 → to_target：“我给张三发了什么”“我发给张三的”“我发给他的文件”“我之前给他发过什么”“我发出去的图片”“我在这个群里发过什么”。
- 说话人是对方 → from_target：“张三给我发了什么”“他之前给我的图片”“张三发给我的文件”。
- **不许**因为“我”出现在句首就选 from_target；也不要凭昵称是否叫“我”来判断说话人，自我身份以消息自身的发送者标记为准。
- 一旦某次 query_messages 返回 0 条，先回头核对 direction 是否与问题的说话人**冲突**；冲突就属于允许的 substantively different retry，必须直接换方向再查一次，**不要**问用户“是不是方向搞错了/要不要换个方向”，用户已经把话说清楚了。
- 需要绝对时间范围时，startTime/endTime 必须使用带时区偏移的 ISO-8601 字符串（例如 2026-08-01T00:00:00+08:00 或 2026-07-31T16:00:00Z）。不要传 epoch 数字，也不要传没有时区的裸本地时间。
- search_messages 是关键词检索，适用于结构条件无法确定答案的问题。queries 的每一项都是一次独立的字面检索：一项只放一个简短关键词，不要把多个近义词或整句话塞进同一项。首次最多 4 项。检索到 Evidence 后直接判断；只有本次完全没有 Evidence 时，才允许再检索一次，且每一项都必须与上一次实质不同。
- conversation_overview 只用于真正需要理解一个时间范围内整体聊了什么、主要话题或整体互动的 broad summary。它返回 temporal coverage sample，不代表完整聊天，也不是检索不足时的默认 fallback。
- message_context 只用于已经找到一条有价值 Evidence、但单条内容缺少前后语境而无法判断真实含义的情况。不要把它当作默认确认步骤；上下文足够后立即回答。
- 普通聊天查询不是 exhaustive investigation。经过合理的检索或可选 context 仍不足以形成强结论时，直接说明证据范围和不确定性，不要循环调用 search、overview、context。

事实边界：不得编造未返回的消息、猜测联系人、修改 resolvedTimeRange，或把 partial/unknown 当作 complete。coverage complete 且结果为 0 时，可以说明当前可读取的完整范围没有找到；coverage partial/unknown 且结果为 0 时，必须说明无法确认绝对不存在。不要把 sampled Evidence 当作完整聊天，也不要把 source message count 和 selected evidence count 混为一谈。
索引新鲜度：search_messages 的 indexLatestAt / sourceLatestAt 是**结构化事实**，indexCoverage 是 Engine 给出的结论句。规则：
- 覆盖边界只能引用 indexCoverage（含本地时间与结论），**不要自己换算时间，也不要把 epoch 数字写进回答**。
- indexCoverage.covered 为 false 时，说明这段时间还没进索引：此时即使结果为 0 也只能说"索引尚未覆盖这段时间，暂时无法确认"，**绝不能**说成"没有"。必须如实引用结论里的索引更新时间。
- 已经检索到 Evidence 时，只有当这个覆盖边界真的会影响结论时才补一句说明，不要机械附加警告。
- 只有 coverage.state 为 complete（indexCoverage.covered 为 true）且结果为 0，才可以下"没有找到"的结论。不要自己把 partial 说成 complete。
图片文字索引：search_messages 的 imageOcrCoverage 是**独立于文字索引**的覆盖维度，只针对“图片里的文字”（截图、报价图、公告截图、海报）。规则：
- 文字消息索引完整**不代表**图片里的文字搜得到。不要把这两个维度混着说。
- 问题涉及图片里的文字、而 imageOcrCoverage.state 不是 complete 时：即使图片证据为 0，也**绝不能**回答“没有”或“没找到”。必须如实引用 imageOcrCoverage.summary，说明图片文字索引尚未完成、当前无法确认全部历史图片。
- imageOcrCoverage.state 为 not_built 时，明确告诉用户图片文字索引还没建立，图片里的文字目前搜不到，并提示可以在「问问微信」里建立。
- 只有 imageOcrCoverage.state 为 complete 且图片证据为 0，才可以下“没有找到”的结论。
图片消息的文字（query_messages 与 search_messages 都适用）：
- 图片消息可能带 imageOcrText / derivedSource=image_ocr —— 那是**这张图片里识别出的文字**（本地 OCR 派生），可以直接用它回答“图片里写了什么”。问法可能是“我今早发的那张图片里写了什么”“那张 ChatGPT 价格截图是什么内容”。
- imageOcrText 是派生内容，**证据永远是那条原始图片消息**：messageRef、sender、conversation、时间都只能用原始图片消息的。描述时说“图片里的文字是…”，**不许**把它说成某人发的一条文字消息，**不许**为了它编造任何不存在的消息。
- imageTextState 是**结构化事实**，三种取值含义不同，不要互相替代：
  - indexed：已识别出文字（同时有 imageOcrText）。
  - empty：本地识别过，这张图里确实没有文字。此时**只能**回答图片本身，**绝不许**根据 OCR 去猜人物、场景、物体或表情包含义（OCR 不是看图，没有 Vision 能力就不要假装有）。
  - not_indexed：这条图片还没进图片文字索引。**不许**把“还没索引”说成“图片里没有文字”；若 imageOcrCoverage 不是 complete，必须说明当前无法确认。
- 图片文字索引状态一律以 Tool Result 的结构化字段为准。**不要**在回答里凭空建议“可以先建立图片文字索引再查”——只有 imageOcrCoverage.state 确实是 not_built 时才可以这么说。
- 区分「图片里确实没有文字」（OCR 结果为空，属于已处理的正常终态）与「图片还没被索引」（覆盖缺口）：前者是事实，后者不能当成事实。
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
 * LLM Tool Adapter 的 canonicalization：剥离 LLM-facing 元数据（temporalBasis）、把 absolute 的
 * ISO-8601 换成 Local Query API 的 epoch seconds、把 `queries[]` 摊平成 query + variants。
 *
 * 这里只做**纯 lexical** 校验（sourceText 是否为用户问题子串、kind 与 timeRange 是否自洽），
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
  if (name === 'query_messages' && counts.resultCount === 0 && !result.fallbackLookup && state.queryAttempts <= ZERO_RESULT_RETRY_LIMIT) return '本次精确查询返回 0 条。只允许放宽 direction 或 messageTypes 等非时间条件（改变时间范围会被拒绝）。**特别注意方向选反这种情况**：如果问题是“我给 X 发 / 我发给 X 的”，而本次用的是 from_target（对方发来），那是方向选反了 —— 直接改用 to_target 重查一次，这属于允许的实质不同重试。不要因为有 0 条就收尾，也不要问用户“是不是方向搞错了 / 要不要换个方向”，用户已经把说话人讲清楚了。'
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

function resultCount(result: QueryAgentToolResult): { resultCount?: number; evidenceCount?: number; sourceMessageCount?: number } {
  return {
    resultCount: typeof result.returnedCount === 'number' ? result.returnedCount : undefined,
    evidenceCount: typeof result.evidenceCount === 'number' ? result.evidenceCount : Array.isArray(result.evidence) ? result.evidence.length : undefined,
    // 会话概览用它说明"覆盖了多少条源消息"，UI 顶部统计需要真实数字。
    sourceMessageCount: typeof result.sourceMessageCount === 'number' ? result.sourceMessageCount : undefined
  }
}

function messageRecordForModel(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const record = value as Record<string, unknown>
  return record.messageType || !record.sourceKind ? record : { ...record, messageType: record.sourceKind }
}

/**
 * 从 Tool Result 里读出图片 OCR 的两条**结构化事实**（诊断 / 日志用）。
 *
 * 只看字段存在与否与数量，**不读文本内容**：排查链路断点不需要正文，
 * 日志里也不该多留一份聊天内容。
 */
function imageOcrDiagnostics(result: QueryAgentToolResult): {
  imageOcrTextCount?: number
  imageOcrCoverageState?: string
} {
  let count = 0
  const collect = (value: unknown): void => {
    if (!Array.isArray(value)) return
    for (const item of value) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      const text = (item as Record<string, unknown>).imageOcrText
      if (typeof text === 'string' && text.trim()) count += 1
    }
  }
  collect(result.messages)
  collect(result.evidence)
  const coverage = result.imageOcrCoverage
  const state =
    coverage && typeof coverage === 'object' && !Array.isArray(coverage)
      ? (coverage as Record<string, unknown>).state
      : undefined
  return {
    ...(count > 0 ? { imageOcrTextCount: count } : {}),
    ...(typeof state === 'string' ? { imageOcrCoverageState: state } : {})
  }
}

function toolResultForModel(name: string, result: QueryAgentToolResult, callsUsed: number, nextTools: AIChatToolDefinition[], note?: string): QueryAgentToolResult {  const visible: QueryAgentToolResult = { ...result }
  if (Array.isArray(result.messages)) visible.messages = result.messages.map(messageRecordForModel)
  if (Array.isArray(result.evidence)) {
    visible.evidence = result.evidence.map((item) => {
      const record = messageRecordForModel(item)
      if (!record || typeof record !== 'object' || Array.isArray(record)) return record
      // `imageOcrText` 是给 Evidence UI 做"命中解释"的片段；它的内容已经在 `text` 里，
      // 再原样带一份进模型上下文是纯重复。模型侧保留 `derivedSource` 这个语义标记即可，
      // 由此知道"这条命中的是图片里的文字"。
      const trimmed = { ...(record as Record<string, unknown>) }
      delete trimmed.imageOcrText
      return trimmed
    })
  }
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
    // Host 已经自动执行过一次扩大查询：不再开放 retry，避免出现第三次查询。
    if (result.fallbackLookup) return []
    /**
     * 这里**不能**因为"时间范围已经是全部"就关掉重试。
     *
     * 原实现是 `if (rangeWasAll && resultCount === 0) return []`，依据是"时间不能再放宽了、
     * 更窄只会更少"。但 0 结果的重试本来就不是为了改时间 —— 它是为了放宽
     * **direction / messageTypes**：「我给 X 发了什么图片」被错判成 `from_target` 时，
     * 换成 `to_target` 会从 0 条变成有结果。
     *
     * 这个守卫的后果正是真机那个回归：工具没发出去 → 第二次调用被
     * `tool_availability` 拒掉 → 模型想改向也调不动 → 只能回头问用户"是不是方向搞错了"。
     *
     * 时间范围不可变由 `constraint_time_range_immutable` 单独把关，
     * 完全相同的重试由 `duplicate_retry` 拦下，次数由 ZERO_RESULT_RETRY_LIMIT 限制，
     * 所以这里放开是安全的。
     */
    return counts.resultCount === 0 && state.queryAttempts <= ZERO_RESULT_RETRY_LIMIT
      ? toolDefinition('query_messages')
      : []
  }
  return []
}

/** 进度阶段的类型定义在 `src/shared/query-agent.ts`（renderer 也要消费它，放这里会让 renderer 反向依赖 main）。 */
export type { QueryAgentProgressEvent, QueryAgentProgressStage } from '../../shared/query-agent'

export interface QueryAgentRunOptions {
  /**
   * 最小多轮澄清支持：前几轮（问 + 答）的问答对，由 Adapter 负责长度 / 时间 / 隐私边界。
   * 不传时 messages = [system, user]。
   */
  history?: QueryAgentHistoryTurn[]
  /**
   * 语料边界（搜索范围）。由 UI 决定；Runtime 负责把它传给 Engine 并在 prompt 里说明，
   * 但**强制**发生在 Engine（target 越界 → 可修正的 invalid_tool_arguments）。
   * 不传则不限制范围、不加范围说明。
   */
  conversationScope?: QueryAgentConversationScope
  /**
   * 真实进度回调（ADDITIVE）。由 Adapter 转发给 UI；不传则零额外开销。
   * 回调抛出的异常不会影响查询本身。
   */
  onProgress?: (event: QueryAgentProgressEvent) => void
}

/** 给模型的范围说明：只描述边界，不做"请遵守"的祈祷式约束（约束由 Engine 强制）。 */
function conversationScopeNote(input: QueryAgentConversationScope): string {
  const { scope } = input
  const label = input.label?.trim()
  const header = label ? `当前搜索范围（由应用界面决定）：${label}。` : '当前搜索范围由应用界面决定。'
  const rules = [
    '所有工具调用都会被强制限制在这个范围内；target 若不在范围内会被拒绝，被拒绝时请如实说明范围限制，不要试图绕过。',
    '范围之外还有别的会话，但你**看不到**它们，也不要在回答里声称它们的情况。'
  ]
  if (scope.kind === 'groups') {
    rules.push(
      '范围是群聊专属：包含全部群会话以及群成员实际发送的消息。问"谁聊过某话题"时应省略 search_messages 的 target 做跨群检索，并在回答里保留群名与发送者。'
    )
  } else if (scope.kind === 'contact' || scope.kind === 'current') {
    rules.push(
      '范围只有一个会话：所有工具都可以省略 target（query_messages 也可以），省略即在该会话内检索；不要猜会话名，也不要指定其他会话。'
    )
  }
  return `${header}\n${rules.map((rule) => `- ${rule}`).join('\n')}`
}

/**
 * 证据收集器（Host 侧）。
 *
 * 从 Tool Result 中提取**真实**证据供 UI 展示 —— UI 不允许从回答文本里反解析证据。
 * - 按 `messageRef` 去重（search 与 context 命中同一条消息只显示一次）；
 * - 顺序 = 首次命中顺序；上限 MAX_EVIDENCE_ITEMS；
 * - 只保留展示字段，不携带 wxid / md5 / DB id / raw Tool JSON。
 */
class EvidenceCollector {
  private readonly items = new Map<string, QueryAgentEvidenceItem>()

  addFromToolResult(toolName: string, result: QueryAgentToolResult): void {
    const target = result.target && typeof result.target === 'object' ? (result.target as Record<string, unknown>) : undefined
    const defaults: { conversationName?: string; conversationType?: 'user' | 'group' } = {
      conversationName: typeof target?.displayName === 'string' ? target.displayName : undefined,
      conversationType: target?.type === 'user' || target?.type === 'group' ? target.type : undefined
    }
    const push = (value: unknown): void => {
      const item = this.normalize(value, toolName, defaults)
      if (item) this.merge(item)
    }
    if (Array.isArray(result.messages)) result.messages.forEach(push)
    if (Array.isArray(result.evidence)) result.evidence.forEach(push)
    // message_context：只收 anchor（被补充语境的那条证据），前后文不是本次结论的依据。
    if (result.anchor) push(result.anchor)
    // recall_hint 自动扩大的那次查询也是真实证据。
    const fallback = result.fallbackLookup && typeof result.fallbackLookup === 'object' ? (result.fallbackLookup as Record<string, unknown>) : undefined
    if (Array.isArray(fallback?.messages)) fallback.messages.forEach(push)
  }

  list(): QueryAgentEvidenceItem[] {
    return Array.from(this.items.values()).slice(0, MAX_EVIDENCE_ITEMS)
  }

  private merge(item: QueryAgentEvidenceItem): void {
    const existing = this.items.get(item.messageRef)
    if (!existing) {
      this.items.set(item.messageRef, item)
      return
    }
    // 同一消息被不同 Tool 命中：补齐缺失字段，保留首次的 source。
    const merged = existing as unknown as Record<string, unknown>
    for (const key of Object.keys(item)) {
      if (key === 'source') continue
      const value = (item as unknown as Record<string, unknown>)[key]
      if (value !== undefined && merged[key] === undefined) merged[key] = value
    }
  }

  private normalize(
    value: unknown,
    source: string,
    defaults: { conversationName?: string; conversationType?: 'user' | 'group' }
  ): QueryAgentEvidenceItem | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const record = value as Record<string, unknown>
    const messageRef = typeof record.messageRef === 'string' ? record.messageRef : undefined
    if (!messageRef) return undefined
    const attachment =
      record.attachment && typeof record.attachment === 'object' && !Array.isArray(record.attachment)
        ? (record.attachment as Record<string, unknown>)
        : undefined
    const attachmentView = attachment
      ? {
          ...(typeof attachment.kind === 'string' ? { kind: attachment.kind } : {}),
          ...(typeof attachment.name === 'string' ? { name: attachment.name } : {}),
          ...(typeof attachment.url === 'string' ? { url: attachment.url } : {}),
          ...(typeof attachment.sizeBytes === 'number' ? { sizeBytes: attachment.sizeBytes } : {})
        }
      : undefined
    return {
      messageRef,
      ...(typeof record.conversationName === 'string'
        ? { conversationName: record.conversationName }
        : defaults.conversationName
          ? { conversationName: defaults.conversationName }
          : {}),
      ...(record.conversationType === 'user' || record.conversationType === 'group'
        ? { conversationType: record.conversationType }
        : defaults.conversationType
          ? { conversationType: defaults.conversationType }
          : {}),
      ...(typeof record.sender === 'string' ? { sender: record.sender } : {}),
      ...(typeof record.timestamp === 'number' ? { timestamp: record.timestamp } : {}),
      ...(typeof record.messageType === 'string'
        ? { messageType: record.messageType }
        : typeof record.sourceKind === 'string'
          ? { messageType: record.sourceKind }
          : {}),
      ...(typeof record.text === 'string' && record.text ? { text: record.text } : {}),
      // 「靠图片里的文字命中」这个来源语义必须带到 UI：用户要能看出这条答案来自
      // 图片 OCR，而不是群友真发了一条文字消息。messageRef 仍然指向原始图片消息。
      ...(record.derivedSource === 'image_ocr' ? { derivedSource: 'image_ocr' as const } : {}),
      ...(typeof record.imageOcrText === 'string' && record.imageOcrText
        ? { imageOcrText: record.imageOcrText }
        : {}),
      ...(attachmentView && Object.keys(attachmentView).length ? { attachment: attachmentView } : {}),
      source
    }
  }
}

export class QueryAgentService {
  constructor(
    private readonly provider: QueryAgentProvider,
    private readonly executeTool: QueryAgentToolExecutor,
    private readonly nowProvider: () => Date = () => new Date()
  ) {}

  async run(question: string, options: QueryAgentRunOptions = {}): Promise<QueryAgentResult> {
    const startedAt = Date.now()
    // 计数用可变持有者：`completed` 由 finally 发出，那时 result 已经离开作用域。
    const counters = { modelCallCount: 0, toolCallCount: 0 }
    const emit = (stage: QueryAgentProgressStage, extra: { toolName?: string } = {}): void => {
      const onProgress = options.onProgress
      if (!onProgress) return
      const at = Date.now()
      try {
        onProgress({
          stage,
          elapsedMs: at - startedAt,
          at,
          ...(extra.toolName ? { toolName: extra.toolName } : {}),
          modelCallCount: counters.modelCallCount,
          toolCallCount: counters.toolCallCount
        })
      } catch {
        // 进度上报失败绝不能影响查询本身。
      }
    }
    try {
      return await this.runLoop(question, options, emit, counters)
    } finally {
      // 成功、Provider 失败、tool_limit、异常 —— 一律以 completed 收尾，
      // 避免 UI 永远停在某个中间阶段。
      emit('completed')
    }
  }

  private async runLoop(
    question: string,
    options: QueryAgentRunOptions,
    emit: (stage: QueryAgentProgressStage, extra?: { toolName?: string }) => void,
    counters: { modelCallCount: number; toolCallCount: number }
  ): Promise<QueryAgentResult> {
    const trimmed = question.trim()
    const startedAt = Date.now()
    const runtime = this.provider.getRuntimeConfig()
    const result: QueryAgentResult = { question: trimmed, provider: runtime.providerName, model: runtime.modelName || runtime.model, modelCallCount: 0, toolCallCount: 0, toolTotalMs: 0, totalMs: 0, traces: [], modelDurationsMs: [], modelDiagnostics: [] }
    if (!trimmed) return { ...result, error: '请输入查询问题', errorKind: 'invalid_question', totalMs: Date.now() - startedAt }
    if (!runtime.configured) return { ...result, error: '当前 AI Provider 尚未配置', errorKind: 'provider_unavailable', totalMs: Date.now() - startedAt }

    const history = options.history || []
    const scopeNote = options.conversationScope ? conversationScopeNote(options.conversationScope) : undefined
    const messages: Array<Record<string, unknown>> = [
      { role: 'system', content: SYSTEM_PROMPT },
      // 范围说明是**上下文**，不是强制执行手段：真正的边界由 Engine 拒绝越界 target 来保证。
      ...(scopeNote ? [{ role: 'system', content: scopeNote }] : []),
      ...history.flatMap((turn) => [
        { role: 'user', content: turn.question },
        { role: 'assistant', content: turn.answer }
      ]),
      { role: 'user', content: trimmed }
    ]
    const toolContext: QueryAgentToolContext = options.conversationScope
      ? { conversationScope: options.conversationScope.scope }
      : {}
    const evidence = new EvidenceCollector()
    let tools = toolDefinitions()
    const retry = newRetryState()
    const now = this.nowProvider()
    let firstModelAt: number | undefined
    let finalModelDuration: number | undefined
    while (result.toolCallCount < MAX_TOOL_CALLS) {
      // 真实生命周期边界：还没有任何 Tool 结果 → 这次模型调用是"理解问题"；
      // 已经有结果 → 这次是在消化证据并**生成回答**。不用定时器、不猜进度。
      emit(result.toolCallCount === 0 ? 'understanding' : 'generating_answer')
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
      if (!model.success) return { ...result, error: model.error || '模型调用失败', errorKind: 'provider_failure', firstModelMs: firstModelAt - startedAt, totalMs: Date.now() - startedAt }
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
        return { ...result, error: `超过最大工具调用次数（${MAX_TOOL_CALLS}）`, errorKind: 'tool_limit', firstModelMs: firstModelAt - startedAt, totalMs: Date.now() - startedAt }
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
                  // Tool 真正开始执行 = "在搜索聊天记录"。跨会话范围会明显更慢，
                  // UI 用范围（不是调用次数）决定副提示文案。
                  emit('searching', { toolName: call.name })
                  const primary = await this.executeTool(call.name, traceInput, toolContext)
                  toolResult = primary
                  // recall_hint + 有界范围 + 0 结果 → Host 自动做一次“全部历史”corrective lookup。
                  // 这是一次本地 Query API 调用：不增加 LLM 往返，也不占用 MAX_TOOL_CALLS。
                  // 注意：自动补查必须沿用同一个语料边界，不能借它逃出当前搜索范围。
                  if (shouldAutoBroaden(call.name, temporalBasis, traceInput, primary)) {
                    const fallbackStartedAt = Date.now()
                    const fallbackResult = await this.executeTool('query_messages', { ...traceInput, timeRange: { kind: 'all' } }, toolContext)
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
        counters.toolCallCount = result.toolCallCount
        result.toolTotalMs += durationMs
        // Tool Result 已经拿到 → 真实进入"整理证据"阶段。
        emit('organizing_evidence', { toolName: call.name })
        // 收集真实证据（去重、限量），供 UI 展示；不进入模型上下文。
        evidence.addFromToolResult(call.name, completedToolResult)
        result.evidence = evidence.list()
        const counts = resultCount(completedToolResult)
        // 引擎耗时分解留在 Host 侧（诊断 / UI），不进入模型上下文。
        const rawTimings = completedToolResult.timings
        const searchTimings: QuerySearchTimings | undefined =
          rawTimings && typeof rawTimings === 'object' && !Array.isArray(rawTimings)
            ? (rawTimings as QuerySearchTimings)
            : undefined
        result.traces.push({ toolName: call.name, input: sanitizeInput(traceInput), durationMs, status: completedToolResult.status, ...counts, ...imageOcrDiagnostics(completedToolResult), ...(temporalBasis ? { temporalBasis } : {}), ...(autoFallback ? { autoFallback } : {}), ...(searchTimings ? { searchTimings } : {}) })
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
    return { ...result, error: `超过最大工具调用次数（${MAX_TOOL_CALLS}）`, errorKind: 'tool_limit' }
  }
}
