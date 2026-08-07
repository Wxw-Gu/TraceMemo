import type {
  KnowledgeEvidence,
  KnowledgeSearchIpcResult,
  KnowledgeVoiceCoverage
} from './knowledge'

export type AiSearchScope = 'global' | 'groups' | 'contacts' | 'conversation'
export type AiSearchRange = 'today' | '7d' | '30d' | 'all'
/**
 * Retrieval semantics, not presentation labels. Each intent has a constrained
 * execution path in the main process; a model must not be able to quietly turn
 * an identity lookup into a generic message-keyword search.
 */
export type AiSearchIntent =
  | 'conversation_recall'
  | 'conversation_topic_search'
  | 'global_topic_search'
  | 'conversation_name_search'
  | 'general'

export interface AiSearchTimeRange {
  /** Unix seconds. Undefined start means the user explicitly allowed all history. */
  startTime?: number
  endTime?: number
  label: string
  reason: string
  source: 'ui' | 'query' | 'user_retry' | 'user_selected'
}
export type AiSearchProgressStage =
  | 'query_understanding'
  | 'agent_start'
  | 'agent_tool'
  | 'agent_decision'
  | 'search_plan_ready'
  | 'knowledge_searching'
  | 'evidence_ranking'
  | 'evidence_ready'
  | 'aggregation'
  | 'ai_generating'
  | 'completed'
  | 'error'
export type AiSearchProgressStatus = 'running' | 'completed' | 'error'

export interface AiSearchPlan {
  intent: AiSearchIntent
  keywords: string[]
  variants: string[]
  source: 'local' | 'ai' | 'hybrid'
  scopeLabel: string
  rangeLabel: string
  timeRange: AiSearchTimeRange
  contactNames: string[]
  /** A user-supplied identity candidate. It must be resolved by Contact Resolution. */
  contactQuery?: string
  /** The message-content query, never a contact display name. */
  topicQuery?: string
}

export interface AiSearchPipelineRequest {
  requestId: string
  text: string
  scope: AiSearchScope
  range: AiSearchRange
  conversationId?: string
  /** Explicit UI choice or retry takes precedence over natural-language inference. */
  timeRangeOverride?: AiSearchTimeRange
}

export interface AiSearchProgressEvent {
  requestId: string
  stage: AiSearchProgressStage
  status: AiSearchProgressStatus
  message: string
  plan?: AiSearchPlan
  stats?: {
    knowledgeMessageCount?: number
    matchedMessages?: number
    evidenceCount?: number
    contextEvidenceCount?: number
    tokenEstimate?: number
    inputTokens?: number
    inputTokensEstimated?: boolean
    elapsedMs?: number
    deduplicatedMessages?: number
    peopleCount?: number
    conversationCount?: number
  }
  timings?: AiSearchPipelineTimings
  modelName?: string
  agentTrace?: AiSearchAgentTraceItem
  error?: string
}

export type AiSearchAgentToolName =
  | 'search_conversations'
  | 'search_people'
  | 'search_messages'
  | 'get_conversation_messages'
  | 'get_messages_by_time'
  | 'get_message_context'

export type AiSearchAgentTraceEvent =
  | 'agentStart'
  | 'toolCallStart'
  | 'toolCallEnd'
  | 'agentDecision'
  | 'evidenceBuild'
  | 'summaryStart'
  | 'summaryEnd'
  | 'fallback'

/** Public trace: deliberately contains no SQL, paths, raw IDs, or Worker details. */
export interface AiSearchAgentTraceItem {
  sequence: number
  event: AiSearchAgentTraceEvent
  label: string
  toolName?: AiSearchAgentToolName
  /** Sanitized, human-readable arguments only. */
  arguments?: Record<string, string | number | boolean>
  resultCount?: number
  uniqueCandidateCount?: number
  newCandidateCount?: number
  newEvidenceCount?: number
  newConversationCount?: number
  newSenderCount?: number
  queryFingerprint?: string
  hasMore?: boolean
  elapsedMs?: number
  decision?: string
}

export interface AiSearchAgentRun {
  mode: 'agent' | 'fallback'
  toolCalls: number
  trace: AiSearchAgentTraceItem[]
  fallbackReason?: string
}

export interface AiSearchPipelineEvidence extends KnowledgeEvidence {
  conversationName: string
  conversationType: 'user' | 'group'
}

/** A program-generated, stable citation. This is the only Evidence shape sent to AI/UI. */
export interface AiSearchFinalEvidence extends AiSearchPipelineEvidence {
  id: `E${number}`
}

export interface AiSearchPersonAggregation {
  id: string
  name: string
  messageCount: number
  conversationCount: number
  lastMessageAt: number
  evidenceIds: Array<`E${number}`>
}

export interface AiSearchConversationAggregation {
  id: string
  name: string
  type: 'user' | 'group'
  messageCount: number
  peopleCount: number
  lastMessageAt: number
  evidenceIds: Array<`E${number}`>
}

export interface AiSearchAggregation {
  messageCount: number
  peopleCount: number
  conversationCount: number
  people: AiSearchPersonAggregation[]
  conversations: AiSearchConversationAggregation[]
}

/** All fields are directly measured around real work. */
export interface AiSearchPipelineTimings {
  queryUnderstandingMs: number
  contactResolutionMs: number
  knowledgeSearchMs: number
  workerIpcMs: number
  workerBootMs: number
  dispatchMs: number
  workerSqlMs: number
  responseSerializeMs: number
  responseTransferMs: number
  workerQueueMs: number
  workerExecutionMs: number
  globalCountMs: number
  voiceCoverageMs: number
  wcdbQueueMs: number
  wcdbExecutionMs: number
  senderEnrichmentMs: number
  ipcMs: number
  serializationMs: number
  otherMs: number
  ftsMs: number
  chunkExpandMs: number
  messageLoadMs: number
  rankingMs: number
  candidateRankingMs: number
  evidenceBuildMs: number
  aggregationMs: number
  contextPreparationMs: number
  agentDecisionMs: number
  agentToolMs: number
  aiGenerationMs: number
  totalMs: number
}

export interface AiSearchCitationValidation {
  status: 'valid' | 'sanitized'
  invalidCitationIds: string[]
}

/** Truthful retrieval metadata shared by the AI, UI and diagnostics. */
export interface AiSearchRetrievalContract {
  intent: AiSearchIntent
  conversationId?: string
  timeRange: AiSearchTimeRange
  retrievalMode:
    | 'conversation_metadata'
    | 'conversation_topic_fts'
    | 'global_fts'
    | 'conversation_name'
    | 'unresolved_identity'
  candidateCount: number
  uniqueCandidateCount: number
  sourceMessageCount?: number
  sourceCoverage: 'complete' | 'partial' | 'keyword_match' | 'unknown'
  isComplete: boolean
  fallbackUsed: boolean
  fallbackReason?: string
  suspicious: boolean
  voiceCoverage?: KnowledgeVoiceCoverage
}

export interface AiSearchPipelineResult {
  requestId: string
  status:
    | 'completed'
    | 'no_evidence'
    | 'retrieval_incomplete'
    | 'ai_failed'
    | 'failed'
    | 'cancelled'
  plan: AiSearchPlan
  knowledge: Pick<
    KnowledgeSearchIpcResult,
    | 'source'
    | 'state'
    | 'fallbackReason'
    | 'indexedMessageCount'
    | 'indexedChunkCount'
    | 'totalMessages'
    | 'voiceCoverage'
  >
  candidateEvidenceCount: number
  retrieval: AiSearchRetrievalContract
  evidence: AiSearchFinalEvidence[]
  contextEvidenceCount: number
  aggregation: AiSearchAggregation
  agent: AiSearchAgentRun
  citationValidation?: AiSearchCitationValidation
  timings: AiSearchPipelineTimings
  answer?: string
  ai?: {
    providerName: string
    modelName: string
    inputTokens?: number
    inputTokensEstimated: boolean
  }
  error?: string
  errorStage?: Exclude<AiSearchProgressStage, 'completed' | 'error'>
  elapsedMs: number
}

export interface AiSearchCancelResult {
  cancelled: boolean
}

const RANGE_LABELS: Record<AiSearchRange, string> = {
  today: '今天',
  '7d': '近 7 天',
  '30d': '近 30 天',
  all: '全部历史'
}

const SEARCH_INTENT_PHRASES = [
  '全局搜一下',
  '全局搜索',
  '搜索一下',
  '搜一下',
  '查询一下',
  '查一下',
  '找一下',
  '我和谁聊过',
  '谁和我聊过',
  '谁聊过',
  '哪些人和我聊过',
  '最近讨论了什么',
  '最近聊了什么',
  '最近说了什么',
  '讨论了什么',
  '讨论什么',
  '聊了什么',
  '聊些什么',
  '说了什么',
  '说些什么',
  '最近讨论',
  '最近聊天',
  '这个话题',
  '相关话题',
  '的聊天',
  '的内容',
  '的记录',
  '关于',
  '聊天',
  '记录',
  '聊天记录',
  '帮我',
  '请问',
  '最近'
].sort((left, right) => right.length - left.length)

const RECALL_QUESTION = '聊了什么|聊过什么|说了什么|谈了什么|聊了啥|聊啥|说了啥|说啥'

const SEARCH_STOP_WORDS = new Set([
  '我',
  '谁',
  '什么',
  '哪些',
  '哪个',
  '人',
  '和',
  '聊过',
  '说过',
  '提到',
  '讨论',
  '聊天',
  '记录',
  '说',
  '聊',
  '话题',
  '内容',
  '相关',
  '最近',
  '一下'
])

export const aiSearchRangeLabel = (range: AiSearchRange): string => RANGE_LABELS[range]

export const aiSearchRangeStart = (range: AiSearchRange): number | undefined => {
  if (range === 'all') return undefined
  if (range === 'today') {
    const now = new Date()
    return Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000)
  }
  return Math.floor(Date.now() / 1000) - (range === '7d' ? 7 : 30) * 86400
}

const dayStart = (date: Date): number =>
  Math.floor(new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() / 1000)

const currentYearStart = (date: Date): number =>
  Math.floor(new Date(date.getFullYear(), 0, 1).getTime() / 1000)

const currentMonthStart = (date: Date): number =>
  Math.floor(new Date(date.getFullYear(), date.getMonth(), 1).getTime() / 1000)

const CHINESE_NUMBERS: Record<string, number> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10
}

const parseNaturalNumber = (value: string | undefined): number | undefined => {
  if (!value) return undefined
  const numeric = Number(value)
  if (Number.isFinite(numeric)) return numeric
  return CHINESE_NUMBERS[value]
}

/**
 * Query time expressions are part of SearchPlan, never a renderer-only rule.
 * A natural-language time constraint is more specific than the broad "all" UI scope.
 */
export const inferAiSearchTimeRange = (
  query: string,
  uiRange: AiSearchRange,
  now = new Date(),
  override?: AiSearchTimeRange
): AiSearchTimeRange => {
  if (override?.source === 'user_retry' || override?.source === 'user_selected') return override
  const nowSeconds = Math.floor(now.getTime() / 1000)
  const fromQuery = (startTime: number, label: string, reason: string): AiSearchTimeRange => ({
    startTime,
    endTime: nowSeconds,
    label,
    reason,
    source: 'query'
  })
  const recentDays = query.match(/最近\s*(\d{1,3}|[一二两三四五六七八九十])\s*天/)
  if (recentDays) {
    const days = Math.max(1, Math.min(365, parseNaturalNumber(recentDays[1]) || 30))
    return fromQuery(nowSeconds - days * 86400, `近 ${days} 天`, `用户说“最近 ${days} 天”`)
  }
  const recentMonths = query.match(/最近\s*(\d{1,2}|[一二两三四五六七八九十])\s*个?月/)
  if (recentMonths) {
    const months = Math.max(1, Math.min(24, parseNaturalNumber(recentMonths[1]) || 1))
    const start = new Date(now.getFullYear(), now.getMonth() - months, now.getDate()).getTime()
    return fromQuery(Math.floor(start / 1000), `近 ${months} 个月`, `用户说“最近 ${months} 个月”`)
  }
  if (/刚刚|刚才/.test(query))
    return fromQuery(nowSeconds - 24 * 3600, '近 24 小时', '用户说“刚刚”')
  if (/这几天/.test(query)) return fromQuery(nowSeconds - 7 * 86400, '近 7 天', '用户说“这几天”')
  if (/这周|本周/.test(query)) {
    const weekday = now.getDay() || 7
    return fromQuery(dayStart(now) - (weekday - 1) * 86400, '本周', '用户说“这周”')
  }
  if (/这个月|本月/.test(query)) return fromQuery(currentMonthStart(now), '本月', '用户说“这个月”')
  if (/上个月/.test(query)) {
    const start = Math.floor(new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime() / 1000)
    const end = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000) - 1
    return {
      startTime: start,
      endTime: end,
      label: '上个月',
      reason: '用户说“上个月”',
      source: 'query'
    }
  }
  if (/今年/.test(query)) return fromQuery(currentYearStart(now), '今年', '用户说“今年”')
  if (/最近/.test(query)) return fromQuery(nowSeconds - 30 * 86400, '近 30 天', '用户说“最近”')
  return {
    startTime: aiSearchRangeStart(uiRange),
    endTime: undefined,
    label: aiSearchRangeLabel(uiRange),
    reason: '使用界面选择的时间范围',
    source: 'ui'
  }
}

export const aiSearchIntentLabel = (intent: AiSearchIntent): string => {
  if (intent === 'conversation_recall') return '回顾最近聊天'
  if (intent === 'conversation_topic_search') return '在指定聊天中查找话题'
  if (intent === 'global_topic_search') return '按话题查找'
  if (intent === 'conversation_name_search') return '查找聊天'
  return '综合查找'
}

export const aiSearchScopeLabel = (scope: AiSearchScope, conversationName?: string): string => {
  if (scope === 'groups') return '群聊'
  if (scope === 'contacts') return '单聊'
  if (scope === 'conversation') return conversationName || '当前会话'
  return '所有聊天'
}

const normalizeTerms = (terms: unknown): string[] => {
  if (!Array.isArray(terms)) return []
  return Array.from(
    new Set(
      terms
        .filter((term): term is string => typeof term === 'string')
        .map((term) => term.trim())
        .filter((term) => term.length >= 2 && term.length <= 32)
    )
  ).slice(0, 16)
}

const extractKeywords = (query: string): string[] => {
  const cleaned = SEARCH_INTENT_PHRASES.reduce(
    (value, phrase) => value.split(phrase).join(' '),
    query.toLowerCase()
  )
  return Array.from(
    new Set(
      cleaned
        .split(/[\s,，。！？!?、:：;；"“”‘’()（）[\]【】]+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2 && !SEARCH_STOP_WORDS.has(token))
    )
  )
}

const keywordVariants = (keywords: string[]): string[] =>
  Array.from(
    new Set(
      keywords.flatMap((keyword) => {
        const variants = [keyword]
        if (/^[\u4e00-\u9fff]+$/.test(keyword) && keyword.length > 2) {
          variants.push(keyword.slice(-2))
        }
        return variants
      })
    )
  )

export const buildLocalAiSearchPlan = (
  query: string
): Pick<
  AiSearchPlan,
  'intent' | 'keywords' | 'variants' | 'source' | 'contactQuery' | 'topicQuery'
> => {
  const keywords = extractKeywords(query)
  const normalized = query.replace(/[“”"'‘’「」『』]/g, '').trim()
  const recall = normalized.match(
    new RegExp(
      `(?:我和|我跟|我与)\\s*(.+?)\\s*(?:最近|这几天|本周|这个月|本月|今年|上个月|刚刚|刚才)?\\s*(?:${RECALL_QUESTION})`
    )
  )
  const reverseRecall = normalized.match(
    new RegExp(`^\\s*(.+?)\\s*(?:最近)?(?:跟我|和我|与我)\\s*(?:${RECALL_QUESTION})`)
  )
  const namedConversationRecall = normalized.match(
    new RegExp(`(?:我在|在)\\s*(.+?)\\s*(?:最近)?\\s*(?:${RECALL_QUESTION})`)
  )
  const bareNamedConversationRecall = normalized.match(
    new RegExp(
      `^\\s*(.{2,32}?(?:群聊|交流群|群))\\s*(?:最近|这几天|本周|这个月|本月|今年|上个月|刚刚|刚才)?\\s*(?:${RECALL_QUESTION})[，,。！？!?]*$`
    )
  )
  const conversationTopic = normalized.match(
    /(?:我和|我跟|我与)\s*(.+?)\s*(?:最近|这几天|本周|这个月|本月|今年|上个月)?\s*(?:聊过|提过|说过|讨论过)\s*(.+?)(?:吗|么|沒有|没有)?[？?。！!]*$/
  )
  const globalTopic = normalized.match(
    /(?:最近|这几天|本周|这个月|本月|今年)?\s*(?:谁|哪些人|大家)\s*(?:聊过|提过|说过|讨论过)\s*(.+?)[？?。！!]*$/
  )
  const conversationName =
    !recall &&
    !reverseRecall &&
    !conversationTopic &&
    !namedConversationRecall &&
    !bareNamedConversationRecall &&
    !globalTopic &&
    /^[^，,。！？!?]{2,32}(?:群|群聊|交流群)$/.test(normalized)
      ? normalized
      : undefined
  const contactQuery = (
    conversationTopic?.[1] ||
    recall?.[1] ||
    reverseRecall?.[1] ||
    namedConversationRecall?.[1] ||
    bareNamedConversationRecall?.[1]
  )
    ?.replace(/^(?:和|跟|与)\s*/, '')
    .trim()
  const topicQuery = (conversationTopic?.[2] || globalTopic?.[1])
    ?.replace(/^(?:关于|一下|吗|么)\s*/, '')
    .trim()
  const intent: AiSearchIntent = conversationTopic
    ? 'conversation_topic_search'
    : recall || reverseRecall
      ? 'conversation_recall'
      : namedConversationRecall || bareNamedConversationRecall
        ? 'conversation_name_search'
        : globalTopic
          ? 'global_topic_search'
          : conversationName
            ? 'conversation_name_search'
            : keywords.length
              ? 'global_topic_search'
              : 'general'
  const effectiveKeywords = topicQuery ? [topicQuery] : keywords
  return {
    intent,
    keywords: effectiveKeywords,
    variants: keywordVariants(effectiveKeywords),
    source: 'local',
    contactQuery: contactQuery || conversationName,
    topicQuery
  }
}

export const parseAiSearchPlan = (
  value: string
): Partial<Pick<AiSearchPlan, 'intent' | 'keywords' | 'variants' | 'topicQuery'>> | null => {
  const jsonMatch = value.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return null
  try {
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>
    const intent = [
      'general',
      'conversation_recall',
      'conversation_topic_search',
      'global_topic_search',
      'conversation_name_search'
    ].includes(String(parsed.intent))
      ? (parsed.intent as AiSearchIntent)
      : undefined
    return {
      intent,
      keywords: normalizeTerms(parsed.keywords),
      variants: normalizeTerms(parsed.variants),
      topicQuery:
        typeof parsed.topicQuery === 'string' && parsed.topicQuery.trim().length >= 2
          ? parsed.topicQuery.trim().slice(0, 64)
          : undefined
    }
  } catch {
    return null
  }
}

export const mergeAiSearchPlans = (
  local: Pick<
    AiSearchPlan,
    'intent' | 'keywords' | 'variants' | 'source' | 'contactQuery' | 'topicQuery'
  >,
  ai: Partial<Pick<AiSearchPlan, 'intent' | 'keywords' | 'variants' | 'topicQuery'>> | null
): Pick<
  AiSearchPlan,
  'intent' | 'keywords' | 'variants' | 'source' | 'contactQuery' | 'topicQuery'
> => {
  if (!ai) return local
  const keywords = normalizeTerms([...local.keywords, ...(ai.keywords || [])])
  const variants = normalizeTerms([
    ...keywordVariants(keywords),
    ...local.variants,
    ...(ai.variants || [])
  ])
  // Identity-bearing local intents are deterministic contracts. A planner may
  // refine topic terms but may not weaken them into an unrelated FTS intent.
  const lockedIntent =
    local.intent === 'conversation_recall' ||
    local.intent === 'conversation_topic_search' ||
    local.intent === 'conversation_name_search'
  return {
    intent: lockedIntent ? local.intent : ai.intent || local.intent,
    keywords,
    variants,
    source: 'hybrid',
    contactQuery: local.contactQuery,
    topicQuery: local.topicQuery || ai.topicQuery
  }
}

export const includesExplicitAiSearchAlias = (query: string, alias: string): boolean => {
  const name = alias.trim()
  if (!name || name.length < 2) return false
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const quoted = new RegExp(`[“"'‘「『]${escaped}[”"'’」』]`)
  const relational = new RegExp(
    `(?:我和|我跟|我与|和|跟|与|在|给|向|@)${escaped}(?=$|[\\s，,。！？!?、:：；;])`
  )
  if (quoted.test(query) || relational.test(query)) return true

  // Users often omit a nickname's punctuation, for example typing
  // “中田健身弘毅” for “中田健身-弘毅”. Keep this tolerant matching limited
  // to an explicit relational query so a short alias cannot accidentally
  // select a contact from unrelated prose.
  const compact = (value: string): string =>
    value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
  const compactName = compact(name)
  return (
    compactName.length >= 2 &&
    /(?:我和|我跟|我与|和|跟|与|在|给|向|@)/.test(query) &&
    compact(query).includes(compactName)
  )
}
