import { listContactsAsync, listMessagesAsync, isReady, type FormattedContact, type FormattedMessage } from './chat-service'
import { resolveContact } from './contact-resolution-service'
import type { KnowledgeSearchService } from '../knowledge/knowledge-search-service'
import { inferAiSearchTimeRange } from '../../shared/ai-search'
import type { QueryCapabilitiesResponse, QueryMessage, QueryMessageType, QueryTimeRange, ResolvedTimeRange, QueryMessagesRequest, SearchMessagesRequest, MessageContextRequest, ConversationOverviewRequest } from '../../shared/local-query-api'

const LIMIT_MAX = 200
const CONTEXT_MAX = 50
const kinds: QueryMessageType[] = ['text', 'image', 'voice', 'video', 'file', 'link', 'sticker', 'system', 'other']

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
function toRef(conversationId: string, messageId: string): string {
  return Buffer.from(JSON.stringify({ c: conversationId, m: messageId }), 'utf8').toString('base64url')
}
function fromRef(value: string): { c: string; m: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    return typeof parsed?.c === 'string' && typeof parsed?.m === 'string' ? parsed : null
  } catch { return null }
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

export class LocalQueryApiService {
  constructor(private readonly knowledge?: KnowledgeSearchService, private readonly nowProvider: () => Date = () => new Date()) {}
  capabilities(): QueryCapabilitiesResponse {
    return { version: 1, tools: { query_messages: { operation: '读取指定联系人的确定性消息', directions: ['any', 'from_target', 'to_target'], messageTypes: kinds, timeRanges: ['all', 'today', 'yesterday', 'this_week', 'last_7_days', 'this_month', 'previous_month', 'this_year', 'previous_year', 'absolute'], limitMax: LIMIT_MAX }, search_messages: { operation: '受限 Knowledge 关键词检索', timeRanges: ['all', 'today', 'yesterday', 'this_week', 'last_7_days', 'this_month', 'previous_month', 'this_year', 'previous_year', 'absolute'], limitMax: LIMIT_MAX }, message_context: { operation: '读取消息前后文', timeRanges: ['all'], limitMax: CONTEXT_MAX }, conversation_overview: { operation: '按会话时间片提取概览证据', timeRanges: ['all', 'today', 'yesterday', 'this_week', 'last_7_days', 'this_month', 'previous_month', 'this_year', 'previous_year', 'absolute'], limitMax: LIMIT_MAX } } }
  }
  private async resolve(target: { query: string }) {
    const contacts = await listContactsAsync()
    const result = resolveContact(target.query, contacts)
    return { contacts, result }
  }
  async messages(request: QueryMessagesRequest) {
    if (!request?.target?.query?.trim() || !request.timeRange || !['any', 'from_target', 'to_target'].includes(request.direction || 'any') || (request.messageTypes || []).some((type) => !kinds.includes(type))) return { status: 'invalid_request' as const }
    if (!isReady()) return { status: 'knowledge_unavailable' as const }
    const { contacts, result } = await this.resolve(request.target)
    if (!result.matched || !result.conversationId) return { status: result.ambiguous ? 'ambiguous_contact' as const : 'contact_not_found' as const, candidates: result.candidates.map((candidate) => ({ displayName: candidate.displayName, type: contacts.find((c) => c.md5 === candidate.conversationId)?.type || 'user' })) }
    const contact = contacts.find((c) => c.md5 === result.conversationId)!; if (contact.type === 'group' && request.direction && request.direction !== 'any') return { status: 'unsupported_query' as const }; const range = resolvedTimeRange(request.timeRange, this.nowProvider())
    const raw = await listMessagesAsync(contact.md5, range.startTime, range.endTime)
    const direction = request.direction || 'any'; const allowed = new Set(request.messageTypes || kinds)
    const filtered = raw.filter((message) => !(request.excludeSystem !== false && kindOf(message) === 'system')).filter((message) => allowed.has(kindOf(message))).filter((message) => direction === 'any' || (direction === 'to_target' ? message.isSender : !message.isSender)).sort((a, b) => ((a.createTime || 0) - (b.createTime || 0)) * ((request.order || 'asc') === 'asc' ? 1 : -1)).slice(0, Math.min(LIMIT_MAX, Math.max(1, request.limit || 20)))
    return { status: 'completed' as const, target: contactView(contact), query: { direction, messageTypes: request.messageTypes || [], order: request.order || 'asc', limit: Math.min(LIMIT_MAX, Math.max(1, request.limit || 20)), excludeSystem: request.excludeSystem !== false, resolvedTimeRange: range }, coverage: { state: 'complete' as const }, returnedCount: filtered.length, messages: filtered.map((message) => toQueryMessage(contact.md5, message, contact)) }
  }
  async search(request: SearchMessagesRequest) {
    if (!request?.target?.query?.trim() || !request.timeRange || typeof request.query !== 'string' || !request.query.trim() || (request.variants || []).some((value) => typeof value !== 'string')) return { status: 'invalid_request' as const }
    const { contacts, result } = await this.resolve(request.target)
    if (!result.matched || !result.conversationId) return { status: result.ambiguous ? 'ambiguous_contact' as const : 'contact_not_found' as const, candidates: result.candidates.map((candidate) => ({ displayName: candidate.displayName, type: contacts.find((c) => c.md5 === candidate.conversationId)?.type || 'user' })) }
    if (!this.knowledge) return { status: 'knowledge_unavailable' as const }
    const contact = contacts.find((c) => c.md5 === result.conversationId)!; const range = resolvedTimeRange(request.timeRange, this.nowProvider()); const probes = [request.query, ...(request.variants || [])]
    if (probes.length > 5) return { status: 'invalid_request' as const }
    const all = new Map<string, any>(); let coverage: 'complete' | 'partial' | 'unknown' = 'unknown'
    for (const probe of probes) { const found = await this.knowledge.search({ text: probe, terms: [probe], conversationIds: [contact.md5], startTime: range.startTime, endTime: range.endTime, limit: Math.min(LIMIT_MAX, Math.max(1, request.limit || 20)) }); coverage = found.state === 'ready' ? 'complete' : found.evidence.length ? 'partial' : 'unknown'; for (const item of found.evidence) all.set(`${item.conversationId}:${item.messageId}`, { messageRef: toRef(item.conversationId, item.messageId), messageId: item.messageId, timestamp: item.timestamp, sender: item.sender, sourceKind: item.sourceKind, text: item.text }) }
    return { status: 'completed' as const, target: contactView(contact), resolvedTimeRange: range, coverage: { state: coverage }, probeCount: probes.length, evidenceCount: all.size, evidence: Array.from(all.values()).map(({ messageId: _messageId, ...item }) => item).slice(0, request.limit || 20) }
  }
  async context(request: MessageContextRequest) {
    const ref = fromRef(request.messageRef); if (!ref) return { status: 'invalid_request' as const }
    const before = Math.min(CONTEXT_MAX, Math.max(0, request.before ?? 10)); const after = Math.min(CONTEXT_MAX, Math.max(0, request.after ?? 10)); const messages = await listMessagesAsync(ref.c); const index = messages.findIndex((message) => message.id === ref.m); if (index < 0) return { status: 'contact_not_found' as const }
    const contact = (await listContactsAsync()).find((item) => item.md5 === ref.c); if (!contact) return { status: 'contact_not_found' as const }; const map = (message: FormattedMessage) => toQueryMessage(ref.c, message, contact)
    return { status: 'completed' as const, anchor: map(messages[index]), before: messages.slice(Math.max(0, index - before), index).map(map), after: messages.slice(index + 1, index + 1 + after).map(map) }
  }
  async overview(request: ConversationOverviewRequest) {
    if (!request?.target?.query?.trim() || !request.timeRange) return { status: 'invalid_request' as const }
    const { contacts, result } = await this.resolve(request.target); if (!result.matched || !result.conversationId) return { status: result.ambiguous ? 'ambiguous_contact' as const : 'contact_not_found' as const, candidates: result.candidates.map((candidate) => ({ displayName: candidate.displayName, type: contacts.find((c) => c.md5 === candidate.conversationId)?.type || 'user' })) }; if (!this.knowledge) return { status: 'knowledge_unavailable' as const }
    const contact = contacts.find((c) => c.md5 === result.conversationId)!; const range = resolvedTimeRange(request.timeRange, this.nowProvider()); const found = await this.knowledge.search({ text: '', terms: [], conversationIds: [contact.md5], startTime: range.startTime, endTime: range.endTime, limit: LIMIT_MAX }); const retrieval = found.conversationRetrieval
    const sourceMessageCount = retrieval?.totalMessages || 0
    const evidence = found.evidence
      .map((item, index) => ({ messageRef: toRef(item.conversationId, item.messageId), timestamp: item.timestamp, sender: item.sender, sourceKind: item.sourceKind, text: item.text, index }))
      .sort((left, right) => left.timestamp - right.timestamp || left.index - right.index)
      .map(({ index: _index, ...item }) => item)
    const sourceState = retrieval?.complete ? 'complete' as const : 'partial' as const
    return { status: found.state === 'ready' ? 'completed' as const : 'retrieval_incomplete' as const, target: contactView(contact), resolvedTimeRange: range, coverage: { state: sourceState }, sourceMessageCount, evidenceCount: evidence.length, sourceCoverage: { state: sourceState, sourceMessageCount }, selection: { mode: 'temporal_coverage' as const, selectedEvidenceCount: evidence.length, sampled: evidence.length < sourceMessageCount }, voiceCoverage: found.voiceCoverage, evidence }
  }
}
