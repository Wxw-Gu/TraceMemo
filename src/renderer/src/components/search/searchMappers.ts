import type { AiSearchFinalEvidence, AiSearchPipelineResult } from '../../../../shared/ai-search'
import { encodeMessageRef } from '../../../../shared/local-query-api'
import type { Contact } from '../../../../shared/types'
import { compactCacheItem } from './searchUtils'
import type { AISearchCacheRecord, EvidenceItem, SearchTrace } from './searchTypes'
import { formatEvidenceTimestamp } from './searchFormatters'

const fallbackEvidenceContact = (conversationId: string): Contact => ({
  md5: conversationId,
  m_nsUsrName: conversationId,
  m_nsNickName: '未加载的会话',
  type: conversationId.endsWith('@chatroom') ? 'group' : 'user'
})

export const mapPipelineEvidenceItem = (
  item: AiSearchFinalEvidence,
  contactsById: ReadonlyMap<string, Contact>
): EvidenceItem => {
  const contact = contactsById.get(item.conversationId) || {
    ...fallbackEvidenceContact(item.conversationId),
    m_nsNickName: item.conversationName,
    type: item.conversationType
  }
  return {
    evidenceId: item.id,
    sourceKind: item.sourceKind,
    contact,
    // 这条路径本来就同时知道真实会话 id 与消息 id，顺手补上稳定引用，
    // 让 Legacy / ai-search 证据也能被精确定位（而不是只有 Query Agent 路径能跳准）。
    ...(safeRef(item.conversationId, item.messageId) || {}),
    message: {
      id: item.messageId,
      from: item.senderId || 'user',
      type: item.sourceKind === 'voice' ? '语音转写' : '检索消息',
      datetime: formatEvidenceTimestamp(item.timestamp),
      content: item.text,
      isSender: item.sender === '我',
      name: item.sender,
      senderId: item.senderId,
      createTime: Math.floor(item.timestamp / 1000)
    }
  }
}

/** 引用构造失败（缺 id）时返回 null，调用方退化到按时间定位 —— 不允许抛异常打断结果渲染。 */
function safeRef(conversationId: string, messageId: string): { messageRef: string } | null {
  try {
    return { messageRef: encodeMessageRef(conversationId, messageId) }
  } catch {
    return null
  }
}

export const mapPipelineEvidence = (
  items: AiSearchFinalEvidence[],
  contacts: Contact[]
): EvidenceItem[] => {
  const contactsById = new Map(contacts.map((contact) => [contact.md5, contact]))
  return items.map((item) => mapPipelineEvidenceItem(item, contactsById))
}

export const mapEvidenceSenderNames = (items: EvidenceItem[]): Record<string, string> =>
  Object.fromEntries(
    items
      .filter(({ message }) => Boolean(message.senderId && message.name))
      .map(({ message }) => [message.senderId as string, message.name as string])
  )

export const mapSearchResultToTrace = (
  result: AiSearchPipelineResult,
  finalEvidenceCount: number
): SearchTrace => ({
  knowledgeMessages: result.knowledge.indexedMessageCount,
  retrievedEvidence:
    result.retrieval.intent === 'conversation_recall'
      ? result.retrieval.sourceMessageCount ?? result.candidateEvidenceCount
      : result.candidateEvidenceCount,
  finalEvidence: finalEvidenceCount,
  timings: result.timings,
  contextEvidence: result.contextEvidenceCount,
  inputTokens: result.ai?.inputTokens,
  inputTokensEstimated: result.ai?.inputTokensEstimated || false,
  aggregation: result.aggregation,
  invalidCitationIds: result.citationValidation?.invalidCitationIds || [],
  agent: result.agent,
  voiceCoverage: result.knowledge.voiceCoverage
})

export interface PipelineRendererResult {
  evidence: EvidenceItem[]
  evidenceCollection: EvidenceItem[]
  searchTrace: SearchTrace
  senderNames: Record<string, string>
  messageCount: number
}

export const mapPipelineResultToRendererResult = (
  result: AiSearchPipelineResult,
  contacts: Contact[]
): PipelineRendererResult => {
  const evidence = mapPipelineEvidence(result.evidence, contacts)
  const evidenceCollection = mapPipelineEvidence(
    result.evidenceCollection || result.evidence,
    contacts
  )

  return {
    evidence,
    evidenceCollection,
    searchTrace: mapSearchResultToTrace(result, evidence.length),
    senderNames: mapEvidenceSenderNames(evidence),
    messageCount: result.knowledge.totalMessages
  }
}

export const mapCacheRecordToResult = (
  cached: AISearchCacheRecord,
  queryValue: string,
  evidencePageSize: number
): {
  resultQuery: string
  answer: string
  evidence: EvidenceItem[]
  evidenceCollection: EvidenceItem[]
  visibleEvidenceCount: number
  senderNames: Record<string, string>
  messageCount: number
  cachedAt: number
} => {
  const evidenceCollection = cached.evidenceCollection || cached.evidence
  return {
    resultQuery: queryValue,
    answer: cached.answer,
    evidence: cached.evidence,
    evidenceCollection,
    visibleEvidenceCount: Math.min(evidencePageSize, evidenceCollection.length),
    senderNames: cached.senderNames,
    messageCount: cached.messageCount,
    cachedAt: cached.createdAt
  }
}

export const createSearchCacheRecord = ({
  key,
  createdAt,
  answer,
  evidence,
  evidenceCollection,
  senderNames,
  messageCount
}: {
  key: string
  createdAt: number
  answer: string
  evidence: EvidenceItem[]
  evidenceCollection: EvidenceItem[]
  senderNames: Record<string, string>
  messageCount: number
}): AISearchCacheRecord => ({
  version: 3,
  key,
  createdAt,
  answer,
  evidence: evidence.map(compactCacheItem),
  evidenceCollection: evidenceCollection.map(compactCacheItem),
  senderNames,
  messageCount
})
