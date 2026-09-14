import { listContactsAsync, listMessagesAsync, isReady, type FormattedContact, type FormattedMessage } from './chat-service'
import { resolveContact } from './contact-resolution-service'
import type { KnowledgeSearchService } from '../knowledge/knowledge-search-service'
import { inferAiSearchTimeRange } from '../../shared/ai-search'
import { KNOWLEDGE_FRESHNESS_TOLERANCE_MS } from '../../shared/knowledge'
import type {
  QueryCapabilitiesResponse,
  QueryCorpusScope,
  QueryEvidenceItem,
  QueryMessage,
  QueryMessageType,
  QueryTimeRange,
  ResolvedCorpusScope,
  ResolvedTimeRange,
  QueryIndexCoverage,
  QuerySearchTimings,
  QueryMessagesRequest,
  SearchMessagesRequest,
  MessageContextRequest,
  ConversationOverviewRequest
} from '../../shared/local-query-api'
// messageRef 编解码是 main 与 renderer 共用的契约，只定义一次（`src/shared/local-query-api.ts`）：
// 两侧各写一份 base64url 实现会悄悄漂移，那会让「跳转到原聊天」偶发失效。
import {
  encodeMessageRef as toRef,
  decodeMessageRef as fromRef,
  normalizeMessageIdentity
} from '../../shared/local-query-api'

const LIMIT_MAX = 200
const CONTEXT_MAX = 50
/** 会话概览直读源数据时的上限（与派生索引的会话概览同量级）。 */
const OVERVIEW_SOURCE_CAP = 2000
/** 会话概览最多挑选多少条代表证据（与派生索引的候选上限一致）。 */
const OVERVIEW_EVIDENCE_TARGET = 60
const OVERVIEW_CHUNK_GAP_MS = 2 * 60 * 60 * 1000
const OVERVIEW_CHUNK_MAX_MESSAGES = 24
const kinds: QueryMessageType[] = ['text', 'image', 'voice', 'video', 'file', 'link', 'sticker', 'system', 'other']

/**
 * 查询触发追赶同步后最多等待多久（`QUERY_FRESHNESS_WAIT_BUDGET`）。
 *
 * 一次完整 pass 的耗时以分钟计，远超任何交互预算。所以这个预算只用来兜住「已经很接近追平」
 * 的情况：追不上就按当前覆盖如实回答并让后台继续追，而不是把查询卡在索引上。
 */
const QUERY_FRESHNESS_WAIT_BUDGET_MS = 2000

/**
 * 两次由查询触发的追赶之间的最小间隔，避免每个 Query 都重跑一遍索引。
 */
const QUERY_CATCH_UP_MIN_INTERVAL_MS = 30 * 1000

/**
 * 值得为它跑一遍索引的最小落后量（下限）。
 *
 * 追赶一遍的成本以分钟计，因此几秒钟/一两分钟的落后并不值得触发。真正的门槛是
 * `max(这个下限, 上一遍实际耗时)` —— 见 `LocalQueryApiService.ensureFreshness`。
 * 这样在"源数据一直在长"的情况下会自然收敛：一遍跑完后剩下的落后量约等于这一遍的耗时，
 * 于是不会立刻再触发一遍（否则会变成永不停止的连续索引）。
 */
const QUERY_CATCH_UP_MIN_LAG_MS = 2 * 60 * 1000

/**
 * 请求的时间范围是否已经被派生索引覆盖。
 *
 * 需要覆盖的真实边界是 `min(requestedEnd, sourceLatestAt)`：
 * - 请求范围早于源数据最新时间 → 必须覆盖到 requestedEnd；
 * - 请求范围延伸到"现在" → 覆盖到源数据最新就已经完整（其后本来没有内容）。
 *
 * freshness 与 coverage 共用这**一处**判据，避免两套口径漂移。
 */
function indexCovers(indexLatestAt: number | null, requestedEnd: number, sourceLatestAt: number | null): boolean {
  if (indexLatestAt === null) return false
  const requiredEnd = sourceLatestAt === null ? requestedEnd : Math.min(requestedEnd, sourceLatestAt)
  return indexLatestAt + KNOWLEDGE_FRESHNESS_TOLERANCE_MS >= requiredEnd
}

/**
 * `ResolvedTimeRange` 用的是 **epoch 秒**（Local Query API contract），
 * 而 freshness 口径（indexLatestAt / sourceLatestAt）是 **epoch 毫秒**。
 * 这里统一到毫秒，避免混单位把"落后"误判成"已覆盖"。
 */
function rangeEndMs(range: ResolvedTimeRange, fallbackNowMs: number): number {
  return range.endTime === undefined ? fallbackNowMs : range.endTime * 1000
}

/** 本地时间（`MM-DD HH:mm`）；只用于给模型一句可引用的人话，不参与任何判断。 */
function formatLocalMinute(ms: number): string {
  const date = new Date(ms + 8 * 60 * 60 * 1000)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
}

/**
 * 索引覆盖结论：模型直接引用，不要自己换算时间、也不要输出 epoch 数字。
 * 落后时必须把"这段时间暂时无法确认"写进结论句，避免被读成"整段时间都没有"。
 */
function buildIndexCoverage(
  indexLatestAt: number | null,
  sourceLatestAt: number | null,
  covered: boolean
): QueryIndexCoverage | undefined {
  if (indexLatestAt === null) return undefined
  const indexLabel = formatLocalMinute(indexLatestAt)
  return {
    covered,
    indexLatestAtLabel: indexLabel,
    ...(sourceLatestAt !== null ? { sourceLatestAtLabel: formatLocalMinute(sourceLatestAt) } : {}),
    summary: covered
      ? `可搜索索引已覆盖所问的时间范围（索引最新到 ${indexLabel}）。`
      : `可搜索索引只更新到 ${indexLabel}，这之后的聊天还没进索引，这段时间是否聊过暂时无法确认。`
  }
}

const KIND_LABELS: Record<QueryMessageType, string> = {
  text: '文本',
  image: '图片',
  voice: '语音',
  video: '视频',
  file: '文件',
  link: '链接',
  sticker: '表情',
  system: '系统消息',
  other: '消息'
}

function kindOf(message: FormattedMessage): QueryMessageType {
  if (message.contentData?.type === 'system') return 'system'
  if (message.exportMediaType) return message.exportMediaType
  if (message.type === '语音' || message.voiceTranscript) return 'voice'
  if (message.contentData?.type === 'image') return 'image'
  if (message.contentData?.type === 'video') return 'video'
  if (message.contentData?.type === 'sticker') return 'sticker'
  if (message.contentData?.type === 'share') return message.contentData.typeVal === '6' ? 'file' : 'link'
  if (message.contentData?.type === 'miniProgram') return 'link'
  if (message.type === '文件') return 'file'
  if (message.content?.trim()) return 'text'
  return 'other'
}
function contactView(contact: FormattedContact) { return { displayName: contact.m_nsNickName || contact.m_nsUsrName, type: contact.type } as const }
function resolvedTimeRange(input: QueryTimeRange, now = new Date()): ResolvedTimeRange {
  if (input.kind === 'absolute') {
    if ((input.startTime !== undefined && !Number.isFinite(input.startTime)) || (input.endTime !== undefined && !Number.isFinite(input.endTime))) throw new Error('时间范围无效')
    if (input.startTime !== undefined && input.endTime !== undefined && input.endTime < input.startTime) throw new Error('时间范围无效')
    return { ...input, label: '指定时间范围' }
  }
  const map: Record<string, Parameters<typeof inferAiSearchTimeRange>[1]> = { all: 'all', today: 'today', yesterday: 'all', this_week: 'all', last_7_days: '7d', this_month: 'all', previous_month: 'all', this_year: 'all', previous_year: 'all' }
  const phrase: Record<string, string> = { today: '今天', yesterday: '昨天', this_week: '本周', last_7_days: '近 7 天', this_month: '本月', previous_month: '上个月', this_year: '今年', previous_year: '去年', all: '' }
  const range = inferAiSearchTimeRange(phrase[input.kind], map[input.kind], now)
  return { kind: input.kind, startTime: range.startTime, endTime: range.endTime, label: range.label }
}
function toQueryMessage(conversationId: string, message: FormattedMessage, target: FormattedContact): QueryMessage {
  const kind = kindOf(message)
  const content = message.contentData
  const attachment =
    kind === 'image' && content?.type === 'image'
      ? { kind: 'image' as const }
      : kind === 'video' && content?.type === 'video'
        ? { kind: 'video' as const, sizeBytes: content.byteLength }
        : kind === 'sticker' && content?.type === 'sticker'
          ? { kind: 'sticker' as const, url: content.url || content.thumbUrl }
          : kind === 'file'
            ? { kind: 'file' as const, name: message.exportMediaName || (content?.type === 'share' ? content.title : undefined), url: content?.type === 'share' ? content.url : undefined }
            : undefined
  const text = message.content?.trim() || message.voiceTranscript?.trim() || undefined
  return { messageRef: toRef(conversationId, message.id), timestamp: (message.createTime || 0) * 1000, datetime: message.datetime, sender: message.isSender ? '我' : (message.name || target.m_nsNickName), direction: message.isSender ? 'to_target' : 'from_target', messageType: kind, sourceKind: kind, ...(attachment ? { attachment } : {}), ...(text ? { text } : {}) }
}

/**
 * 单条证据的展示形态：群消息必须带**群名 + 发送者**，否则模型无法回答"谁聊过"。
 * 不含 wxid / md5 / DB id；messageRef 保持 opaque。
 */
function toEvidenceItem(contact: FormattedContact, message: FormattedMessage): QueryEvidenceItem {
  const view = toQueryMessage(contact.md5, message, contact)
  const name = contactView(contact).displayName
  return {
    messageRef: view.messageRef,
    timestamp: view.timestamp,
    sender: view.sender,
    sourceKind: view.sourceKind,
    text: view.text || `[${KIND_LABELS[view.messageType]}]`,
    conversationName: name,
    conversationType: contact.type
  }
}

/** 语料边界的解析结果。 */
interface ResolvedCorpus {
  /** undefined = 不限会话（全部可读会话）。 */
  conversationIds?: string[]
  scope: ResolvedCorpusScope
  /** contact / current 命中的会话。 */
  contact?: FormattedContact
  error?: { status: string; [key: string]: unknown }
}

function describeScope(scope: ResolvedCorpusScope): string {
  if (scope.kind === 'all') return '所有聊天记录'
  if (scope.kind === 'groups') return '群聊专属'
  return `${scope.kind === 'contact' ? '单聊专属' : '当前会话'}：${scope.displayName || '未知会话'}`
}

/**
 * 语料边界违规 → 返回**可修正**的 invalid_tool_arguments（Runtime 会重开该 Tool 让模型改）。
 * 这是结构性约束：模型无法用 prompt 绕过。
 */
function outsideScopeError(scope: ResolvedCorpusScope, actual: string): { status: string; [key: string]: unknown } {
  return {
    status: 'invalid_tool_arguments',
    field: 'target',
    constraint: 'target_outside_scope',
    expected: describeScope(scope),
    actual,
    hint: 'target 必须落在应用当前的搜索范围内。需要查其他会话时，请让用户切换搜索范围；不要自行扩大范围。'
  }
}

export class LocalQueryApiService {
  constructor(private readonly knowledge?: KnowledgeSearchService, private readonly nowProvider: () => Date = () => new Date()) {}
  capabilities(): QueryCapabilitiesResponse {
    return { version: 1, tools: { query_messages: { operation: '读取指定联系人的确定性消息', directions: ['any', 'from_target', 'to_target'], messageTypes: kinds, timeRanges: ['all', 'today', 'yesterday', 'this_week', 'last_7_days', 'this_month', 'previous_month', 'this_year', 'previous_year', 'absolute'], limitMax: LIMIT_MAX }, search_messages: { operation: '受限 Knowledge 关键词检索', timeRanges: ['all', 'today', 'yesterday', 'this_week', 'last_7_days', 'this_month', 'previous_month', 'this_year', 'previous_year', 'absolute'], limitMax: LIMIT_MAX }, message_context: { operation: '读取消息前后文', timeRanges: ['all'], limitMax: CONTEXT_MAX }, conversation_overview: { operation: '按会话时间片提取概览证据', timeRanges: ['all', 'today', 'yesterday', 'this_week', 'last_7_days', 'this_month', 'previous_month', 'this_year', 'previous_year', 'absolute'], limitMax: LIMIT_MAX } } }
  }

  /**
   * 解析语料边界。`scope` 由调用方（UI / Host）提供；省略 = 不限。
   * 这里只做**确定性**展开（群列表 / 会话身份校验），不做任何语义推断。
   */
  private async resolveCorpus(scope: QueryCorpusScope | undefined, contacts: FormattedContact[]): Promise<ResolvedCorpus> {
    if (!scope || scope.kind === 'all') {
      return { scope: { kind: 'all', conversationCount: contacts.length } }
    }
    if (scope.kind === 'groups') {
      const ids = contacts.filter((contact) => contact.type === 'group').map((contact) => contact.md5)
      return { conversationIds: ids, scope: { kind: 'groups', conversationCount: ids.length } }
    }
    const contact = contacts.find((item) => item.md5 === scope.conversationId)
    if (!contact) {
      return { scope: { kind: scope.kind, conversationCount: 0 }, error: { status: 'scope_conversation_not_found', kind: scope.kind } }
    }
    if (scope.kind === 'contact' && contact.type !== 'user') {
      return { scope: { kind: scope.kind, conversationCount: 0 }, error: { status: 'scope_contact_requires_direct', actual: contact.type } }
    }
    return {
      conversationIds: [contact.md5],
      contact,
      scope: { kind: scope.kind, conversationCount: 1, displayName: contactView(contact).displayName, conversationType: contact.type }
    }
  }

  async messages(request: QueryMessagesRequest) {
    if (!request?.timeRange || !['any', 'from_target', 'to_target'].includes(request.direction || 'any') || (request.messageTypes || []).some((type) => !kinds.includes(type))) return { status: 'invalid_request' as const }
    if (!isReady()) return { status: 'knowledge_unavailable' as const }
    const contacts = await listContactsAsync()
    const corpus = await this.resolveCorpus(request.scope, contacts)
    if (corpus.error) return corpus.error as { status: string }
    const targetQuery = request.target?.query?.trim()
    let contact: FormattedContact | undefined
    if (targetQuery) {
      const result = resolveContact(targetQuery, contacts)
      if (!result.matched || !result.conversationId) return { status: result.ambiguous ? 'ambiguous_contact' as const : 'contact_not_found' as const, candidates: result.candidates.map((candidate) => ({ displayName: candidate.displayName, type: contacts.find((c) => c.md5 === candidate.conversationId)?.type || 'user' })) }
      contact = contacts.find((c) => c.md5 === result.conversationId)!
      if (corpus.conversationIds && !corpus.conversationIds.includes(contact.md5)) {
        return outsideScopeError(corpus.scope, contactView(contact).displayName) as { status: string }
      }
    } else if (corpus.contact) {
      // 省略 target：范围恰好只有一个会话（单聊专属 / 当前会话）时直接查它，避免让模型重新拼会话名。
      contact = corpus.contact
    } else if (corpus.conversationIds && corpus.conversationIds.length === 1) {
      contact = contacts.find((c) => c.md5 === corpus.conversationIds![0])
    }
    if (!contact) {
      return {
        status: 'invalid_tool_arguments',
        field: 'target',
        constraint: 'target_required_for_scope',
        expected: describeScope(corpus.scope),
        actual: '省略 target',
        hint: '当前搜索范围包含多个会话。精确读取消息必须指定 target（必须在该范围内），或改用 search_messages 做跨会话检索。'
      }
    }
    if (contact.type === 'group' && request.direction && request.direction !== 'any') return { status: 'unsupported_query' as const }; const range = resolvedTimeRange(request.timeRange, this.nowProvider())
    const raw = await listMessagesAsync(contact.md5, range.startTime, range.endTime)
    const direction = request.direction || 'any'; const allowed = new Set(request.messageTypes || kinds)
    const filtered = raw.filter((message) => !(request.excludeSystem !== false && kindOf(message) === 'system')).filter((message) => allowed.has(kindOf(message))).filter((message) => direction === 'any' || (direction === 'to_target' ? message.isSender : !message.isSender)).sort((a, b) => ((a.createTime || 0) - (b.createTime || 0)) * ((request.order || 'asc') === 'asc' ? 1 : -1)).slice(0, Math.min(LIMIT_MAX, Math.max(1, request.limit || 20)))
    return { status: 'completed' as const, target: contactView(contact), query: { direction, messageTypes: request.messageTypes || [], order: request.order || 'asc', limit: Math.min(LIMIT_MAX, Math.max(1, request.limit || 20)), excludeSystem: request.excludeSystem !== false, resolvedTimeRange: range }, coverage: { state: 'complete' as const }, returnedCount: filtered.length, messages: filtered.map((message) => toQueryMessage(contact.md5, message, contact)), scope: corpus.scope }
  }
  async search(request: SearchMessagesRequest) {
    const requestStartedAt = Date.now()
    if (!request?.timeRange || typeof request.query !== 'string' || !request.query.trim() || (request.variants || []).some((value) => typeof value !== 'string')) return { status: 'invalid_request' as const }
    // 真实耗时分解：每一段都用 Date.now() 实测，不做任何推断。
    const scopeStartedAt = Date.now()
    const contacts = await listContactsAsync()
    const corpus = await this.resolveCorpus(request.scope, contacts)
    if (corpus.error) return corpus.error as { status: string }
    let conversationIds = corpus.conversationIds
    let targetView: { displayName: string; type: 'user' | 'group' } | undefined
    const targetQuery = request.target?.query?.trim()
    if (targetQuery) {
      const resolved = resolveContact(targetQuery, contacts)
      if (!resolved.matched || !resolved.conversationId) {
        return { status: resolved.ambiguous ? 'ambiguous_contact' as const : 'contact_not_found' as const, candidates: resolved.candidates.map((candidate) => ({ displayName: candidate.displayName, type: contacts.find((c) => c.md5 === candidate.conversationId)?.type || 'user' })) }
      }
      const target = contacts.find((c) => c.md5 === resolved.conversationId)!
      if (corpus.conversationIds && !corpus.conversationIds.includes(target.md5)) {
        return outsideScopeError(corpus.scope, contactView(target).displayName) as { status: string }
      }
      conversationIds = [target.md5]
      targetView = contactView(target)
    } else if (corpus.conversationIds && corpus.conversationIds.length === 0) {
      // 范围内没有任何会话（例如没有任何群聊）：明确返回空，而不是悄悄退化成全局搜索。
      return { status: 'completed' as const, coverage: { state: 'unknown' as const }, probeCount: 0, evidenceCount: 0, evidence: [], scope: corpus.scope }
    }
    const scopeMs = Date.now() - scopeStartedAt
    if (!this.knowledge) return { status: 'knowledge_unavailable' as const }
    const range = resolvedTimeRange(request.timeRange, this.nowProvider()); const probes = [request.query, ...(request.variants || [])]
    if (probes.length > 5) return { status: 'invalid_request' as const }
    const contactByMd5 = new Map(contacts.map((contact) => [contact.md5, contact]))
    const limit = Math.min(LIMIT_MAX, Math.max(1, request.limit || 20))
    // 一次查询内多个 probe 共用同一个 retrieval session：Knowledge 会按它缓存
    // "群会话 → 成员昵称" 的解析结果，否则每个 probe 都要重读一遍群成员快照，
    // 跨会话检索会被放大成 N 倍。
    const retrievalSessionId = `query-${this.nowProvider().getTime()}-${Math.random().toString(36).slice(2, 8)}`

    // Freshness：请求的时间范围越过索引覆盖时，先请求既有增量通道去追一次；
    // 这属于 Engine/Host 的确定性处理，**不增加 LLM 往返**。
    //
    // 整段交互检索期间必须让后台索引让路：追赶同步会遍历上千个会话，
    // 否则本次查询会和它抢 Worker 与 WCDB，被拖成几十秒。
    this.knowledge.beginInteractiveQuery()
    const probeMs: number[] = []
    let mergeMs = 0
    let enrichmentMs = 0
    let knowledgeTiming: NonNullable<QuerySearchTimings['knowledge']> | undefined
    let found: Awaited<ReturnType<LocalQueryApiService['probe']>>
    let freshness: { resynced: boolean; catchUp: 'none' | 'reused' | 'skipped' | 'completed' | 'pending' }
    let freshnessMs = 0
    try {
      found = await this.probe(probes, conversationIds, range, limit, contactByMd5, retrievalSessionId)
      probeMs.push(...found.probeMs)
      mergeMs = found.mergeMs
      enrichmentMs = found.enrichmentMs
      knowledgeTiming = found.knowledge
      const requestedEnd = rangeEndMs(range, this.nowProvider().getTime())
      const freshnessStartedAt = Date.now()
      freshness = await this.ensureFreshness(found, requestedEnd)
      freshnessMs = Date.now() - freshnessStartedAt
      // 触发过追赶就必须用（可能已更新的）索引重新检索，不能拿同步前的结果回答。
      if (freshness.resynced) {
        const reProbe = await this.probe(probes, conversationIds, range, limit, contactByMd5, retrievalSessionId)
        probeMs.push(...reProbe.probeMs)
        mergeMs += reProbe.mergeMs
        enrichmentMs += reProbe.enrichmentMs
        found = reProbe
      }
    } finally {
      this.knowledge.endInteractiveQuery()
    }
    const requestedEnd = rangeEndMs(range, this.nowProvider().getTime())

    const covered = indexCovers(found.indexLatestAt, requestedEnd, found.sourceLatestAt)
    const indexCoverage = buildIndexCoverage(found.indexLatestAt, found.sourceLatestAt, covered)
    const timings: QuerySearchTimings = {
      totalMs: Date.now() - requestStartedAt,
      scopeMs,
      freshnessMs,
      probeMs,
      mergeMs,
      enrichmentMs,
      ...(knowledgeTiming ? { knowledge: knowledgeTiming } : {})
    }
    return {
      status: 'completed' as const,
      ...(targetView ? { target: targetView } : {}),
      resolvedTimeRange: range,
      coverage: { state: this.searchCoverage(found, requestedEnd) },
      probeCount: probes.length,
      evidenceCount: found.evidence.size,
      evidence: Array.from(found.evidence.values()).slice(0, limit),
      scope: corpus.scope,
      indexLatestAt: found.indexLatestAt,
      sourceLatestAt: found.sourceLatestAt,
      freshness: { catchUp: freshness.catchUp },
      ...(indexCoverage ? { indexCoverage } : {}),
      timings
    }
  }

  /** 逐 probe 检索并合并去重；同时记录派生索引的覆盖口径与真实耗时分解。 */
  private async probe(
    probes: string[],
    conversationIds: string[] | undefined,
    range: ResolvedTimeRange,
    limit: number,
    contactByMd5: Map<string, FormattedContact>,
    retrievalSessionId: string
  ): Promise<{
    evidence: Map<string, QueryEvidenceItem>
    indexLatestAt: number | null
    sourceLatestAt: number | null
    derivedReady: boolean
    probeMs: number[]
    mergeMs: number
    enrichmentMs: number
    knowledge?: NonNullable<QuerySearchTimings['knowledge']>
  }> {
    let indexLatestAt: number | null = null
    let sourceLatestAt: number | null = null
    let derivedReady = false
    let enrichmentMs = 0
    const probeMs: number[] = []
    const knowledge = {
      shortTermSearchMs: 0,
      ftsMs: 0,
      messageLoadMs: 0,
      statusMs: 0,
      voiceCoverageMs: 0,
      workerExecutionMs: 0
    }
    // 先逐 probe 收证据，再统一合并：这样「probe 检索」与「合并去重」的耗时是分开测量的，
    // 不会把合并成本摊到最后一个 probe 上（诊断时最容易被误读的地方）。
    const perProbe: Array<Array<[string, QueryEvidenceItem]>> = []
    for (const probe of probes) {
      const probeStartedAt = Date.now()
      const found = await this.knowledge!.search({
        text: probe,
        terms: [probe],
        conversationIds,
        startTime: range.startTime,
        endTime: range.endTime,
        limit,
        retrievalSessionId
      })
      probeMs.push(Date.now() - probeStartedAt)
      if (found.state === 'ready') derivedReady = true
      if (typeof found.indexLatestAt === 'number' && (indexLatestAt === null || found.indexLatestAt > indexLatestAt)) indexLatestAt = found.indexLatestAt
      if (typeof found.sourceLatestAt === 'number' && (sourceLatestAt === null || found.sourceLatestAt > sourceLatestAt)) sourceLatestAt = found.sourceLatestAt
      const measured = found.timings
      if (measured) {
        knowledge.shortTermSearchMs += measured.shortTermSearchMs || 0
        knowledge.ftsMs += measured.ftsMs || 0
        knowledge.messageLoadMs += measured.messageLoadMs || 0
        knowledge.statusMs += measured.statusMs || 0
        knowledge.voiceCoverageMs += measured.voiceCoverageMs || 0
        knowledge.workerExecutionMs += measured.workerExecutionMs || measured.totalMs || 0
        enrichmentMs += measured.senderEnrichmentMs || 0
      }
      perProbe.push(
        found.evidence.map((item) => {
          const owner = contactByMd5.get(item.conversationId)
          return [
            `${item.conversationId}:${item.messageId}`,
            {
              messageRef: toRef(item.conversationId, item.messageId),
              timestamp: item.timestamp,
              sender: item.sender,
              sourceKind: item.sourceKind,
              text: item.text,
              conversationName: owner ? contactView(owner).displayName : undefined,
              conversationType: owner?.type
            } satisfies QueryEvidenceItem
          ] as [string, QueryEvidenceItem]
        })
      )
    }
    const mergeStartedAt = Date.now()
    const all = new Map<string, QueryEvidenceItem>()
    for (const entries of perProbe) for (const [key, item] of entries) all.set(key, item)
    const mergeMs = Date.now() - mergeStartedAt
    const hasKnowledgeTiming =
      knowledge.shortTermSearchMs > 0 ||
      knowledge.ftsMs > 0 ||
      knowledge.messageLoadMs > 0 ||
      knowledge.workerExecutionMs > 0
    return {
      evidence: all,
      indexLatestAt,
      sourceLatestAt,
      derivedReady,
      probeMs,
      mergeMs,
      enrichmentMs,
      ...(hasKnowledgeTiming ? { knowledge } : {})
    }
  }

  /**
   * 索引新鲜度处理。
   *
   * 派生索引是异步的，可能停在几天前。请求范围越过索引覆盖时，**不能**直接把 0 条 Evidence
   * 当成"没有"，而是请求既有增量通道去追一次，并在有界预算内等它。
   */
  private async ensureFreshness(
    found: { indexLatestAt: number | null; sourceLatestAt: number | null; derivedReady: boolean },
    requestedEnd: number
  ): Promise<{ resynced: boolean; catchUp: 'none' | 'reused' | 'skipped' | 'completed' | 'pending' }> {
    if (!this.knowledge || !found.derivedReady) return { resynced: false, catchUp: 'none' }
    if (indexCovers(found.indexLatestAt, requestedEnd, found.sourceLatestAt)) {
      return { resynced: false, catchUp: 'none' }
    }
    // 落后量是否值得再跑一遍索引：门槛同时受"上一遍实际耗时"约束，
    // 这样"源数据一直在长"时不会退化成永不停止的连续索引。
    const lag = found.sourceLatestAt !== null && found.indexLatestAt !== null ? found.sourceLatestAt - found.indexLatestAt : Number.POSITIVE_INFINITY
    const worthThreshold = Math.max(QUERY_CATCH_UP_MIN_LAG_MS, this.knowledge.lastPassDurationMs())
    if (lag <= worthThreshold) return { resynced: false, catchUp: 'skipped' }

    const request = this.knowledge.requestCatchUp(QUERY_CATCH_UP_MIN_INTERVAL_MS)
    if (!request.triggered) {
      // 已经在跑 → 复用；刚触发过 → 节流。两种都不阻塞本次查询，后台继续追。
      return { resynced: false, catchUp: request.inProgress ? 'reused' : 'skipped' }
    }
    const completed = await this.knowledge.waitForIndexingComplete(QUERY_FRESHNESS_WAIT_BUDGET_MS)
    return { resynced: true, catchUp: completed ? 'completed' : 'pending' }
  }

  /**
   * 覆盖度。
   *
   * 只有「派生索引可用 + 请求范围被索引完整覆盖」才是 `complete`。
   * `complete` 是 0 结果时允许说"没有找到"的唯一前提；索引落后时必须 `partial`。
   */
  private searchCoverage(
    found: { indexLatestAt: number | null; sourceLatestAt: number | null; derivedReady: boolean; evidence: Map<string, QueryEvidenceItem> },
    requestedEnd: number
  ): 'complete' | 'partial' | 'unknown' {
    if (!found.derivedReady) {
      // 派生索引不可用（未建立 / 直读源数据的 fallback）：有证据也只能算 partial。
      return found.evidence.size ? 'partial' : 'unknown'
    }
    // 索引可用但覆盖口径缺失时不能宣称完整；此时按 partial 处理（宁可保守）。
    if (found.indexLatestAt === null) return 'partial'
    return indexCovers(found.indexLatestAt, requestedEnd, found.sourceLatestAt) ? 'complete' : 'partial'
  }
  async context(request: MessageContextRequest) {
    const ref = fromRef(request.messageRef); if (!ref) return { status: 'invalid_request' as const }
    if (request.scope && request.scope.kind !== 'all') {
      const contacts = await listContactsAsync()
      const corpus = await this.resolveCorpus(request.scope, contacts)
      if (corpus.error) return corpus.error as { status: string }
      if (corpus.conversationIds && !corpus.conversationIds.includes(ref.conversationId)) {
        return outsideScopeError(corpus.scope, '其他会话的消息') as { status: string }
      }
    }
    const before = Math.min(CONTEXT_MAX, Math.max(0, request.before ?? 10)); const after = Math.min(CONTEXT_MAX, Math.max(0, request.after ?? 10)); const messages = await listMessagesAsync(ref.conversationId); const index = messages.findIndex((message) => normalizeMessageIdentity(ref.conversationId, message.id)?.messageId === ref.messageId); if (index < 0) return { status: 'contact_not_found' as const }
    const contact = (await listContactsAsync()).find((item) => item.md5 === ref.conversationId); if (!contact) return { status: 'contact_not_found' as const }; const map = (message: FormattedMessage) => toQueryMessage(ref.conversationId, message, contact)
    return { status: 'completed' as const, anchor: map(messages[index]), before: messages.slice(Math.max(0, index - before), index).map(map), after: messages.slice(index + 1, index + 1 + after).map(map) }
  }
  /**
   * 会话概览。
   *
   * **事实来源是 WCDB（源数据），不是派生 Knowledge 索引**：索引是异步派生的、可能滞后，
   * 把"索引里 0 行"当成"完整范围内没有"会产生高置信度的错误否定。这里改为直读源数据
   * 并显式区分 complete / partial。
   */
  async overview(request: ConversationOverviewRequest) {
    if (!request?.timeRange) return { status: 'invalid_request' as const }
    if (!isReady()) return { status: 'knowledge_unavailable' as const }
    const contacts = await listContactsAsync()
    const corpus = await this.resolveCorpus(request.scope, contacts)
    if (corpus.error) return corpus.error as { status: string }
    const targetQuery = request.target?.query?.trim()
    let contact: FormattedContact | undefined
    if (targetQuery) {
      const resolved = resolveContact(targetQuery, contacts)
      if (!resolved.matched || !resolved.conversationId) {
        return { status: resolved.ambiguous ? 'ambiguous_contact' as const : 'contact_not_found' as const, candidates: resolved.candidates.map((candidate) => ({ displayName: candidate.displayName, type: contacts.find((c) => c.md5 === candidate.conversationId)?.type || 'user' })) }
      }
      contact = contacts.find((c) => c.md5 === resolved.conversationId)!
      if (corpus.conversationIds && !corpus.conversationIds.includes(contact.md5)) {
        return outsideScopeError(corpus.scope, contactView(contact).displayName) as { status: string }
      }
    } else if (corpus.contact) {
      contact = corpus.contact
    } else if (corpus.conversationIds && corpus.conversationIds.length === 1) {
      contact = contacts.find((c) => c.md5 === corpus.conversationIds![0])
    }
    if (!contact) {
      return {
        status: 'invalid_tool_arguments',
        field: 'target',
        constraint: 'target_required_for_scope',
        expected: describeScope(corpus.scope),
        actual: '省略 target',
        hint: '当前搜索范围包含多个会话，会话概览只能针对单个会话。请显式指定 target（必须在该范围内），或改用 search_messages。'
      }
    }
    const range = resolvedTimeRange(request.timeRange, this.nowProvider())
    // 注意：这里**不能**给 listMessagesAsync 传 limit —— 实测在有界时间范围下
    // `{ limit }` 会让 WCDB 读取返回 0 条（而同一范围不传 limit 能正常返回）。
    // 与 query_messages 保持一致：读完整区间，再在 JS 侧截断/采样。
    const raw = await listMessagesAsync(contact.md5, range.startTime, range.endTime)
    const messages = raw.length > OVERVIEW_SOURCE_CAP ? raw.slice(-OVERVIEW_SOURCE_CAP) : raw
    const truncated = raw.length > OVERVIEW_SOURCE_CAP
    const evidence = selectTemporalCoverageEvidence(contact, messages, OVERVIEW_EVIDENCE_TARGET)
    const state: 'complete' | 'partial' = truncated ? 'partial' : 'complete'
    return {
      status: 'completed' as const,
      target: contactView(contact),
      resolvedTimeRange: range,
      coverage: { state },
      sourceMessageCount: raw.length,
      evidenceCount: evidence.length,
      sourceCoverage: { state, sourceMessageCount: raw.length },
      selection: { mode: 'temporal_coverage' as const, selectedEvidenceCount: evidence.length, sampled: truncated || evidence.length < messages.length },
      evidence,
      scope: corpus.scope,
      origin: 'wcdb' as const
    }
  }
}

/**
 * 时间片代表证据：按时间间隔切块，每块取"最长文本 / 首条 / 末条"，再轮转挑选，
 * 保证每个时间片都至少有一条代表，避免长会话里最近的时间片被整体丢弃。
 */
export function selectTemporalCoverageEvidence(
  contact: FormattedContact,
  messages: FormattedMessage[],
  target: number
): QueryEvidenceItem[] {
  if (!messages.length || target <= 0) return []
  const chunks: FormattedMessage[][] = []
  for (const message of messages) {
    const current = chunks.at(-1)
    const previous = current?.at(-1)
    const gapMs = ((message.createTime || 0) - (previous?.createTime || 0)) * 1000
    const isNewChunk = !current || gapMs > OVERVIEW_CHUNK_GAP_MS || current.length >= OVERVIEW_CHUNK_MAX_MESSAGES
    if (isNewChunk) chunks.push([])
    chunks.at(-1)!.push(message)
  }
  const representativesByChunk = chunks.map((chunk) => {
    const preferred = chunk.filter((message) => kindOf(message) !== 'system')
    const pool = preferred.length ? preferred : chunk
    const ranked = [...pool].sort(
      (left, right) =>
        String(right.content || '').length - String(left.content || '').length ||
        (right.createTime || 0) - (left.createTime || 0)
    )
    return [ranked[0], pool[0], pool.at(-1)].filter(
      (value, index, items): value is FormattedMessage => Boolean(value) && items.indexOf(value) === index
    )
  })
  const selected: FormattedMessage[] = []
  for (let representativeIndex = 0; selected.length < target; representativeIndex += 1) {
    let added = false
    for (const representatives of representativesByChunk) {
      const representative = representatives[representativeIndex]
      if (representative && selected.length < target) {
        selected.push(representative)
        added = true
      }
    }
    if (!added) break
  }
  return selected.map((message) => toEvidenceItem(contact, message))
}
