import type { AiSearchFinalEvidence, AiSearchPipelineResult } from '../../../../shared/ai-search'
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
  retrievedEvidence: result.candidateEvidenceCount,
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
