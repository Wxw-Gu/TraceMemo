import type { KnowledgeDerivedSource, KnowledgeEvidence, KnowledgeVoiceCoverage } from './knowledge'

export type QueryDirection = 'any' | 'from_target' | 'to_target'
export type QueryOrder = 'asc' | 'desc'
export type QueryMessageType =
  | 'text'
  | 'image'
  | 'voice'
  | 'video'
  | 'file'
  | 'link'
  | 'sticker'
  | 'system'
  | 'other'
export interface LocalQueryToolDefinition {
  name: 'query_messages' | 'search_messages' | 'message_context' | 'conversation_overview'
  description: string
  parameters: Record<string, unknown>
}
const targetSchema = { type: 'object', properties: { query: { type: 'string', minLength: 1 } }, required: ['query'], additionalProperties: false }
// LLM-facing 绝对时间契约：只接受带时区偏移的 ISO-8601 字符串，避免 epoch 单位歧义。
// Local Query API 内部仍使用 epoch seconds（见 QueryTimeRange），由 Host Adapter 负责转换。
const timeRangeSchema = {
  type: 'object',
  properties: {
    kind: { enum: ['all', 'today', 'yesterday', 'this_week', 'last_7_days', 'this_month', 'previous_month', 'this_year', 'previous_year', 'absolute'] },
    startTime: { type: 'string', minLength: 1, description: '仅 kind=absolute 时必填。带时区偏移的 ISO-8601 字符串，例如 2026-08-01T00:00:00+08:00 或 2026-07-31T16:00:00Z。不接受 epoch 数字，也不接受无时区的裸本地时间。' },
    endTime: { type: 'string', minLength: 1, description: '仅 kind=absolute 时必填。含义与格式同 startTime，且不得早于 startTime。' }
  },
  required: ['kind'],
  additionalProperties: false
}
/**
 * LLM-facing 时间来源语义。只由 Query Agent orchestration 消费：
 * Host 在执行 Local Query API 之前会剥离它 —— 它不进入公共 Query API contract。
 * kind 的分类由 LLM 决定；Host 只读取分类结果并执行确定性 policy，
 * 不做中文关键词 / 正则 / 时间短语映射。
 */
export type QueryTemporalBasisKind = 'constraint' | 'recall_hint' | 'none'
const temporalBasisSchema = {
  type: 'object',
  required: ['kind'],
  additionalProperties: false,
  properties: {
    kind: {
      enum: ['constraint', 'recall_hint', 'none'],
      description:
        '用户问题中的时间表达扮演什么角色，必填。constraint：问题里存在能够归一化成具体时间范围的表达（具体日期、具体年月、月份、上个月、今年、过去 N 天、某日到某日等）。判断看“这个表达本身能不能确定查询边界”，与用户是否确信事情发生过无关——例如“我记得他上个月好像发过文件，是不是”里的“上个月”仍是 constraint；没写年份但按当前时间能正常归一化的月份（如“八月份”）同样是 constraint。recall_hint：用户确实提到时间感觉，但该表达无法确定唯一的查询边界，只能当回忆线索（模糊的近情感、“以前某阵子”）。此时你可以自己挑一个合理的有界范围做首次查询，但它是搜索启发式，不是用户约束。none：问题里没有任何时间信息，此时必须用 timeRange.kind=all，不要凭空造时间范围。'
    },
    sourceText: {
      type: 'string',
      minLength: 1,
      description:
        'kind 为 constraint 或 recall_hint 时必填：用户原问题中实际出现的时间相关原文片段，必须逐字摘录（不要改写、翻译、补全或加标点）。kind 为 none 时不要提供该字段。'
    }
  }
}
/**
 * LLM-facing Tool schema。
 *
 * `search_messages` / `conversation_overview` 的 `target` 是**可选**的：省略表示"使用应用
 * 当前的搜索范围（conversation scope）"—— 范围由 UI/Host 决定并强制，模型无法用它切换范围，
 * 也拿不到它的实现细节。`query_messages` 仍是单会话结构化查询。
 */
export const LOCAL_QUERY_TOOL_DEFINITIONS: LocalQueryToolDefinition[] = [
  { name: 'query_messages', description: '精确读取**单个**会话中符合联系人、时间、方向、消息类型、顺序等结构条件的消息；适合具体事实和 earliest/latest 等时间边界查询，边界查询使用 order 与 limit。省略 target 表示"当前搜索范围恰好只有一个会话"（例如单聊专属或当前会话）时直接查该会话；范围里有多个会话时必须显式指定 target，且 target 必须落在当前搜索范围内。每次调用都必须声明 temporalBasis，说明这个时间范围来自用户的明确约束、模糊回忆线索，还是用户根本没给时间信息。跨多个会话的"谁聊过某话题"请改用 search_messages。', parameters: { type: 'object', required: ['timeRange', 'temporalBasis'], additionalProperties: false, properties: { target: targetSchema, timeRange: timeRangeSchema, temporalBasis: temporalBasisSchema, direction: { enum: ['any', 'from_target', 'to_target'] }, messageTypes: { type: 'array', items: { enum: ['text', 'image', 'voice', 'video', 'file', 'link', 'sticker', 'system', 'other'] } }, order: { enum: ['asc', 'desc'] }, limit: { type: 'integer', minimum: 1, maximum: 200 }, excludeSystem: { type: 'boolean' } } } },
  { name: 'search_messages', description: '在应用当前的搜索范围内做关键词检索并返回相关 Evidence。queries 的每一项都是一次独立的字面检索：一项只放一个简短关键词，不要把多个近义词或整句话放进同一项，也不要指望一项内部被拆词理解。首次最多 4 项；只有在本次检索完全没有 Evidence 时，才允许再检索一次，且每一项都必须与上一次实质不同。省略 target 表示在整个当前搜索范围（可能是多个会话，例如所有群聊）内检索——问"最近谁聊过某个话题"这类跨会话问题时应当省略 target；只有当问题明确指向某一个会话时才传 target，且该 target 必须在当前搜索范围内。', parameters: { type: 'object', required: ['timeRange', 'queries'], additionalProperties: false, properties: { target: targetSchema, timeRange: timeRangeSchema, queries: { type: 'array', description: '独立检索项列表，每项一个简短关键词，最多 4 项；每一项单独检索，不会组合成一句话理解。', minItems: 1, maxItems: 4, items: { type: 'string', minLength: 1 } }, limit: { type: 'integer', minimum: 1, maximum: 200 } } } },
  { name: 'message_context', description: '补充已找到的单条有价值 Evidence 的前后消息；仅在该 Evidence 缺少语境、无法判断含义时使用，不是默认确认步骤。', parameters: { type: 'object', required: ['messageRef'], additionalProperties: false, properties: { messageRef: { type: 'string', minLength: 1 }, before: { type: 'integer', minimum: 0, maximum: 50 }, after: { type: 'integer', minimum: 0, maximum: 50 } } } },
  { name: 'conversation_overview', description: '提取**单个**会话在一段时间内的整体聊天覆盖样本；只用于 broad summary，不是语义搜索 fallback，也不能确定 earliest/latest 等精确时间边界。省略 target 只在当前搜索范围恰好只有一个会话时成立（例如"当前会话"）；范围里有多个会话时必须显式指定 target，且目标必须落在该范围内。', parameters: { type: 'object', required: ['timeRange'], additionalProperties: false, properties: { target: targetSchema, timeRange: timeRangeSchema } } }
]
export type QueryTimeRange =
  | { kind: 'all' | 'today' | 'yesterday' | 'this_week' | 'last_7_days' | 'this_month' | 'previous_month' | 'this_year' | 'previous_year' }
  | { kind: 'absolute'; startTime?: number; endTime?: number }
export interface QueryTarget { query: string }

/**
 * 语料边界（conversation scope）。
 *
 * 由**调用方（UI / Host）**决定，**不是** LLM 的输入 —— 它不进入 LLM-facing Tool schema，
 * 也不与 temporalBasis（时间语义）混在一起：scope 是"去哪里搜"，时间是"搜什么时候"。
 *
 * - `all`：所有可读会话（单聊 + 群聊，群聊成员的每条消息都是普通可搜索消息）
 * - `groups`：只搜群聊语料（= 全部群会话及其成员消息），不是"群摘要 / metadata"
 * - `contact`：只搜指定的一对一会话（单聊专属）
 * - `current`：只搜当前打开的那个会话（可能是单聊或群）
 *
 * `conversationId` 使用应用内部会话身份（与 `Contact.md5` 一致）。
 */
export type QueryCorpusScope =
  | { kind: 'all' }
  | { kind: 'groups' }
  | { kind: 'contact'; conversationId: string }
  | { kind: 'current'; conversationId: string }

/** 解析后的语料边界（回显给调用方与模型，用于说明"这次只在哪个范围里查"）。 */
export interface ResolvedCorpusScope {
  kind: QueryCorpusScope['kind']
  /** 实际参与检索的会话数量；`all` 为可读会话总数。 */
  conversationCount: number
  /** `contact` / `current` 解析出的会话展示名。 */
  displayName?: string
  conversationType?: 'user' | 'group'
}

/**
 * Tool 返回的单条证据。
 * 群消息必须能归属到**具体群 + 具体成员**，否则模型无法回答"谁聊过"。
 */
export interface QueryEvidenceItem
  extends Pick<KnowledgeEvidence, 'timestamp' | 'sender' | 'sourceKind' | 'text'> {
  messageRef: string
  /** 该证据所属会话的展示名（群名 / 联系人名）。 */
  conversationName?: string
  conversationType?: 'user' | 'group'
  /**
   * 命中所依赖的**派生来源**（与 `sourceKind` 正交）。
   *
   * 有值时 Evidence UI 加一个轻量来源标记（如「图片文字」），
   * 让用户知道这段内容来自**图片里的文字**，而不是群友真的发了一条文字消息。
   * authoritative source 仍然是原始图片消息，`messageRef` 也仍然指向原图。
   */
  derivedSource?: KnowledgeDerivedSource
  /**
   * 「从图片里读出来的文字」片段，只用作命中解释。
   *
   * 刻意与 `text` 分开：`text` 是这条消息的内容，这里只回答"命中是因为图里的哪段文字"。
   * 普通文字消息不会有这个字段。
   */
  imageOcrText?: string
}

/**
 * 一条消息的**稳定身份**。
 *
 * 不靠「会话 + 秒级时间戳」定位：同一秒里可能有多条消息，时间戳也只能定位到"附近"。
 * `messageRef` 是 opaque 字符串（base64url 的 `{c,m}`），对模型只暴露成不可读 token，
 * 对本进程/渲染进程可以还原成稳定身份。
 */
export interface CanonicalMessageIdentity {
  conversationId: string
  messageId: string
}

/** 归一化消息身份：`local:` 前缀是 WCDB 侧的本地 id 装饰，不属于身份本身。 */
export function normalizeMessageIdentity(
  conversationId: string,
  messageId: string
): CanonicalMessageIdentity | null {
  const normalizedConversationId = String(conversationId ?? '').trim()
  const normalizedMessageId = String(messageId ?? '')
    .trim()
    .replace(/^local:/, '')
  if (!normalizedConversationId || !normalizedMessageId) return null
  return { conversationId: normalizedConversationId, messageId: normalizedMessageId }
}

/**
 * base64url 编解码。
 *
 * 刻意**不用 `Buffer`**：这份实现被 main 与 renderer 共用，而 renderer 在
 * `contextIsolation` + 无 nodeIntegration 下没有 `Buffer` 全局。`TextEncoder` /
 * `btoa` / `atob` 在 Node ≥16 与 Chromium 里都是标准全局，两侧行为一致。
 */
function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index])
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlToBytes(value: string): Uint8Array | null {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  try {
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes
  } catch {
    return null
  }
}

/** 生成 opaque messageRef。语义与 `decodeMessageRef` 严格互逆。 */
export function encodeMessageRef(conversationId: string, messageId: string): string {
  const identity = normalizeMessageIdentity(conversationId, messageId)
  if (!identity) throw new Error('消息引用无效')
  return bytesToBase64Url(
    new TextEncoder().encode(JSON.stringify({ c: identity.conversationId, m: identity.messageId }))
  )
}

/** 还原 opaque messageRef；无法解析（老缓存 / 伪造）时返回 null，调用方必须走降级路径。 */
export function decodeMessageRef(value: unknown): CanonicalMessageIdentity | null {
  if (typeof value !== 'string' || !value) return null
  const bytes = base64UrlToBytes(value)
  if (!bytes) return null
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { c?: unknown; m?: unknown }
    return typeof parsed?.c === 'string' && typeof parsed?.m === 'string'
      ? normalizeMessageIdentity(parsed.c, parsed.m)
      : null
  } catch {
    return null
  }
}

export interface ResolvedTimeRange { kind: QueryTimeRange['kind']; startTime?: number; endTime?: number; label: string }
export interface QueryMessagesRequest {
  /** 省略 = 使用当前搜索范围（仅当范围恰好只有一个会话时成立）。 */
  target?: QueryTarget
  timeRange: QueryTimeRange
  direction?: QueryDirection
  messageTypes?: QueryMessageType[]
  order?: QueryOrder
  limit?: number
  excludeSystem?: boolean
  /** 语料边界；省略 = 不限制（等价于 all）。目标必须落在该边界内，否则被 Host 拒绝。 */
  scope?: QueryCorpusScope
}
export interface QueryMessage {
  messageRef: string
  timestamp: number
  datetime: string
  sender: string
  direction: 'from_target' | 'to_target'
  messageType: QueryMessageType
  sourceKind: QueryMessageType
  text?: string
  attachment?: {
    kind: Exclude<QueryMessageType, 'text' | 'voice' | 'system' | 'other' | 'link'>
    name?: string
    url?: string
    sizeBytes?: number
  }
  /**
   * 图片 OCR 派生文本（**仅**图片消息、且本地已识别出文字时存在）。
   *
   * 它是 derived content，不是消息正文：这条消息的正文仍然是空的"图片附件"，
   * authoritative evidence 也仍然是**原始图片消息**（`messageRef` 指向它）。
   * 之所以必须单独一个字段而不是塞进 `text`：一旦混进去，模型与 UI 就无法区分
   * "群友发了一段文字"和"图片里识别出这段文字"，而这正是本功能的诚实性前提。
   */
  imageOcrText?: string
  /** 派生来源语义：`image_ocr` = 这段文字来自图片识别，而不是原始文字消息。 */
  derivedSource?: KnowledgeDerivedSource
  /**
   * 这条图片消息在本地图片文字索引里的状态。
   *
   * - `indexed`：识别过且有文字（此时 `imageOcrText` 有值）
   * - `empty`：识别过，但图里确实没有文字 —— 这是**已知结论**，不是"没索引"
   * - `not_indexed`：尚未进入索引（未建立 / 还没处理到 / 已被清理）
   *
   * 区分这三者是硬要求：`not_indexed` 不允许被当成"图里没内容"，
   * `empty` 也不允许被当成"可以凭画面猜内容"（OCR 不是 Vision）。
   */
  imageTextState?: 'indexed' | 'empty' | 'not_indexed'
}
export interface QueryMessagesResponse {
  status: string
  target?: { displayName: string; type: 'user' | 'group' }
  query?: Omit<QueryMessagesRequest, 'target' | 'timeRange'> & { resolvedTimeRange: ResolvedTimeRange }
  coverage?: { state: 'complete' | 'partial' | 'unknown' }
  returnedCount?: number
  messages?: QueryMessage[]
  candidates?: Array<{ displayName: string; type: 'user' | 'group' }>
  /** 本次实际使用的语料边界。 */
  scope?: ResolvedCorpusScope
  /**
   * 图片文字索引的覆盖度。
   *
   * 与 `search_messages` 同源同口径 —— 精确读消息这条路径同样必须知道
   * "图片里的文字到底索引了多少"，否则模型在图片文字尚未索引时
   * 只能看到一个光秃秃的 `attachment`，进而把"索引缺口"说成"图片没有文字"。
   */
  imageOcrCoverage?: QueryImageTextCoverage
}
export interface SearchMessagesRequest {
  target: QueryTarget
  timeRange: QueryTimeRange
  query: string
  variants?: string[]
  limit?: number
  /** 语料边界；省略 = 全部可读会话。省略 target 时用它作为跨会话检索范围。 */
  scope?: QueryCorpusScope
}
export interface SearchMessagesResponse {
  status: string
  target?: { displayName: string; type: 'user' | 'group' }
  resolvedTimeRange?: ResolvedTimeRange
  /**
   * 本次检索的覆盖度。
   *
   * `complete` 需要同时满足：派生索引可用 **且** 请求的时间范围被索引完整覆盖
   * （索引已追到源数据最新，或 requested range 落在索引覆盖窗口内）。
   * 只要源数据在索引之后还有内容，就必须是 `partial` —— 此时 0 条 Evidence
   * **不能**被解释成「整个微信里没有」。
   */
  coverage?: { state: 'complete' | 'partial' | 'unknown' }
  probeCount?: number
  evidenceCount?: number
  evidence?: QueryEvidenceItem[]
  candidates?: Array<{ displayName: string; type: 'user' | 'group' }>
  scope?: ResolvedCorpusScope
  /**
   * 派生索引中最新一条消息的时间（epoch ms）。
   * 索引是**异步派生**数据：它落后于 WCDB 时必须能被调用方看见，不能冒充"完整"。
   */
  indexLatestAt?: number | null
  /** 源数据（WCDB）里最新的活跃时间（epoch ms）；与 indexLatestAt 比较即得 freshness。 */
  sourceLatestAt?: number | null
  /**
   * 本次为追赶索引新鲜度做了什么（诊断字段，不参与答案语义）。
   * - `none`：索引已覆盖请求范围，或没有可用的追赶通道
   * - `reused`：已有索引任务在跑，直接复用，不阻塞本次查询
   * - `skipped`：确实落后，但落后量不值得再跑一遍索引（低于门槛），按当前覆盖如实回答
   * - `completed`：本次触发的追赶在等待预算内完成，并已用新索引重新检索
   * - `pending`：本次触发了追赶但没在预算内完成；本次按当前覆盖如实回答，后台继续追
   */
  freshness?: { catchUp: 'none' | 'reused' | 'skipped' | 'completed' | 'pending' }
  /**
   * 索引覆盖结论（模型可直接引用的一句话）。
   *
   * 只给结构化数字时模型会自己换算、甚至反过来宣称"覆盖完整"。这里由 Engine 直接给出
   * **本地时间**与结论，模型只需引用，不需要自己判断，也不需要输出 epoch 数字。
   */
  indexCoverage?: QueryIndexCoverage
  /**
   * 图片文字索引覆盖度（**独立于**文字索引的维度）。
   *
   * `state !== 'complete'` 时，涉及图片/截图/海报的问题**不允许**因为 0 条证据
   * 就回答"没有"——必须说明图片文字索引尚未完成、当前结果无法覆盖全部图片。
   */
  imageOcrCoverage?: QueryImageTextCoverage
  /** 本次检索的真实耗时分解（ADDITIVE，用于诊断与 UI 展示；不进入模型上下文）。 */
  timings?: QuerySearchTimings
}

export interface QueryIndexCoverage {
  /** 索引是否已覆盖本次请求的时间范围。 */
  covered: boolean
  /** 索引覆盖到的时间（本地时间，`MM-DD HH:mm`）。 */
  indexLatestAtLabel?: string
  /** 源数据最新时间（本地时间，`MM-DD HH:mm`）。 */
  sourceLatestAtLabel?: string
  /** 可直接引用的结论句；`covered: false` 时明确说明这段时间暂时无法确认。 */
  summary: string
}

/**
 * 图片文字索引（本地 OCR 派生文本）的覆盖度 —— 与文字索引覆盖度**互相独立**。
 *
 * 为什么必须单独一个维度：文字消息索引 100% 不代表图片里的文字可被搜索。
 * 图片 OCR 是用户确认后才建立的重活，可能"未建立"，也可能"只做了 30%"。
 * 这时如果模型因为 0 条证据就回答"没有"，就是把**索引缺口**说成了**事实空缺**。
 */
export interface QueryImageTextCoverage {
  /**
   * `failed` = 索引**当前异常**（处理过一批但一条都没成功，或运行时依赖缺失）。
   *
   * 它与 `partial` 都必须让 Query Agent 拒绝凭零结果下"没有"的结论。
   */
  state: 'not_built' | 'partial' | 'complete' | 'failed'
  totalImageMessages: number
  processed: number
  indexed: number
  empty: number
  missing: number
  failed: number
  pending: number
  /** 图片数量统计时刻（本地时间 `MM-DD HH:mm`）；从未统计时为 undefined。 */
  countedAtLabel?: string
  /**
   * 已经**真正完整**的时间段描述（新 → 旧），例如"最近 7 天"。
   *
   * recent-first 之后必须有这一维：总进度 30% 不代表"最近一周不可信"，
   * 反过来总进度 99% 也不代表"去年可以下确定性结论"。模型只能引用这里列出的
   * 时间段去下"没有"的结论，其余范围一律只能说"仍在补齐"。
   */
  coveredRanges?: string[]
  /** 可直接引用的结论句；模型只引用，不要自己换算或推断。 */
  summary: string
}

/**
 * `search_messages` 的真实耗时分解（ADDITIVE 诊断字段）。
 *
 * 让 Tool 阶段可以被拆成 freshness 等待 / scope 解析 / 每个 probe / 证据补全，
 * 而不是一个不透明的总数。这些数字全部来自实际 `Date.now()` 测量，不做任何推测。
 *
 * **不进入模型上下文**：Host 在把 Tool Result 交给模型之前会剥离它。
 */
export interface QuerySearchTimings {
  /** 本次 search_messages 端到端耗时（含 freshness 处理与重检索）。 */
  totalMs: number
  /** 语料范围解析（联系人列表读取 + scope 展开成会话集合）。 */
  scopeMs: number
  /** 索引新鲜度判定 + 必要时触发追赶并在预算内等待。 */
  freshnessMs: number
  /** 每个 probe 的检索耗时，顺序与请求中的 probe 一致（可能含重检索后的第二次）。 */
  probeMs: number[]
  /** 跨 probe 证据合并 / 去重 / 排序。 */
  mergeMs: number
  /** 证据展示信息补全（群名 / 成员昵称）所等待的时间，主要是 WCDB 读取。 */
  enrichmentMs: number
  /** 派生库内部的分项（worker 侧测量）。 */
  knowledge?: {
    shortTermSearchMs: number
    ftsMs: number
    messageLoadMs: number
    statusMs: number
    voiceCoverageMs: number
    workerExecutionMs: number
  }
}
export interface MessageContextRequest { messageRef: string; before?: number; after?: number; scope?: QueryCorpusScope }
export interface MessageContextResponse {
  status: string
  anchor?: QueryMessage
  before?: QueryMessage[]
  after?: QueryMessage[]
}
export interface ConversationOverviewRequest { target: QueryTarget; timeRange: QueryTimeRange; scope?: QueryCorpusScope }
export interface ConversationOverviewResponse {
  status: string
  target?: { displayName: string; type: 'user' | 'group' }
  resolvedTimeRange?: ResolvedTimeRange
  coverage?: { state: 'complete' | 'partial' | 'unknown' }
  sourceMessageCount?: number
  evidenceCount?: number
  sourceCoverage?: { state: 'complete' | 'partial' | 'unknown'; sourceMessageCount: number }
  selection?: { mode: 'temporal_coverage'; selectedEvidenceCount: number; sampled: boolean }
  voiceCoverage?: KnowledgeVoiceCoverage
  evidence?: QueryEvidenceItem[]
  candidates?: Array<{ displayName: string; type: 'user' | 'group' }>
  scope?: ResolvedCorpusScope
  /**
   * 图片文字索引覆盖度（**独立维度**，与 `voiceCoverage` 平级）。
   *
   * 会话概览以源数据为准，所以能如实反映"这段时间聊了什么"；但"图片里的文字"
   * 只存在于本地 OCR 派生索引里，概览的完整性**不覆盖**这一维。
   */
  imageOcrCoverage?: QueryImageTextCoverage
  /**
   * 证据来源：`wcdb` = 直接读源数据（会话概览的事实来源）；`knowledge` = 派生索引。
   * 派生索引可能滞后，故概览以源数据为准。
   */
  origin?: 'wcdb' | 'knowledge'
}
export interface QueryCapabilitiesResponse {
  version: 1
  tools: Record<string, { operation: string; directions?: QueryDirection[]; messageTypes?: QueryMessageType[]; timeRanges: QueryTimeRange['kind'][]; limitMax?: number }>
}
