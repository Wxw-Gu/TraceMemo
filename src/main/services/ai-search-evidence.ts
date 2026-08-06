import type {
  AiSearchAggregation,
  AiSearchFinalEvidence,
  AiSearchPipelineEvidence
} from '../../shared/ai-search'

export type EvidenceBuildResult = {
  evidence: AiSearchFinalEvidence[]
  aggregation: AiSearchAggregation
  candidateCount: number
  deduplicatedCount: number
  candidateRankingMs: number
  evidenceBuildMs: number
  aggregationMs: number
}

export type CitationValidationResult = {
  answer: string
  invalidCitationIds: string[]
  status: 'valid' | 'sanitized'
}

export const evidenceIdentity = (
  item: Pick<AiSearchPipelineEvidence, 'conversationId' | 'messageId'>
): string => `${item.conversationId}\u0000${item.messageId}`

const compareEvidence = (left: AiSearchPipelineEvidence, right: AiSearchPipelineEvidence): number =>
  (left.score ?? 0) - (right.score ?? 0) ||
  right.timestamp - left.timestamp ||
  evidenceIdentity(left).localeCompare(evidenceIdentity(right))

const personIdentity = (item: AiSearchFinalEvidence): string =>
  item.senderId
    ? `sender:${item.senderId}`
    : `conversation:${item.conversationId}:name:${item.sender}`

export function buildEvidenceAggregation(evidence: AiSearchFinalEvidence[]): AiSearchAggregation {
  const people = new Map<
    string,
    {
      id: string
      name: string
      messageCount: number
      conversationIds: Set<string>
      lastMessageAt: number
      evidenceIds: AiSearchFinalEvidence['id'][]
    }
  >()
  const conversations = new Map<
    string,
    {
      id: string
      name: string
      type: 'user' | 'group'
      messageCount: number
      people: Set<string>
      lastMessageAt: number
      evidenceIds: AiSearchFinalEvidence['id'][]
    }
  >()

  for (const item of evidence) {
    const personId = personIdentity(item)
    const person = people.get(personId) || {
      id: personId,
      name: item.sender,
      messageCount: 0,
      conversationIds: new Set<string>(),
      lastMessageAt: item.timestamp,
      evidenceIds: []
    }
    person.messageCount += 1
    person.conversationIds.add(item.conversationId)
    person.lastMessageAt = Math.max(person.lastMessageAt, item.timestamp)
    person.evidenceIds.push(item.id)
    people.set(personId, person)

    const conversation = conversations.get(item.conversationId) || {
      id: item.conversationId,
      name: item.conversationName,
      type: item.conversationType,
      messageCount: 0,
      people: new Set<string>(),
      lastMessageAt: item.timestamp,
      evidenceIds: []
    }
    conversation.messageCount += 1
    conversation.people.add(personId)
    conversation.lastMessageAt = Math.max(conversation.lastMessageAt, item.timestamp)
    conversation.evidenceIds.push(item.id)
    conversations.set(item.conversationId, conversation)
  }

  return {
    messageCount: evidence.length,
    peopleCount: people.size,
    conversationCount: conversations.size,
    people: Array.from(people.values())
      .map((person) => ({
        id: person.id,
        name: person.name,
        messageCount: person.messageCount,
        conversationCount: person.conversationIds.size,
        lastMessageAt: person.lastMessageAt,
        evidenceIds: person.evidenceIds
      }))
      .sort(
        (left, right) =>
          right.messageCount - left.messageCount || right.lastMessageAt - left.lastMessageAt
      ),
    conversations: Array.from(conversations.values())
      .map((conversation) => ({
        id: conversation.id,
        name: conversation.name,
        type: conversation.type,
        messageCount: conversation.messageCount,
        peopleCount: conversation.people.size,
        lastMessageAt: conversation.lastMessageAt,
        evidenceIds: conversation.evidenceIds
      }))
      .sort(
        (left, right) =>
          right.messageCount - left.messageCount || right.lastMessageAt - left.lastMessageAt
      )
  }
}

/**
 * Performs all candidate ordering, identity de-duplication, final limiting and
 * program-owned citation assignment in one place. Nothing downstream receives
 * the candidate list as an AI context.
 */
export function buildFinalEvidence(
  candidates: AiSearchPipelineEvidence[],
  limit: number,
  options?: { strategy?: 'ranked' | 'conversation_coverage' }
): EvidenceBuildResult {
  const rankingStartedAt = Date.now()
  const ranked = [...candidates].sort(compareEvidence)
  const candidateRankingMs = Date.now() - rankingStartedAt

  const evidenceStartedAt = Date.now()
  const unique = new Map<string, AiSearchPipelineEvidence>()
  for (const item of ranked) {
    const identity = evidenceIdentity(item)
    if (!unique.has(identity)) unique.set(identity, item)
  }
  const uniqueEvidence = Array.from(unique.values())
  const selected =
    options?.strategy === 'conversation_coverage'
      ? selectConversationCoverage(uniqueEvidence, limit)
      : uniqueEvidence.slice(0, Math.max(1, limit))
  const evidence = selected.map((item, index) => ({ ...item, id: `E${index + 1}` as const }))
  const evidenceBuildMs = Date.now() - evidenceStartedAt

  const aggregationStartedAt = Date.now()
  const aggregation = buildEvidenceAggregation(evidence)
  const aggregationMs = Date.now() - aggregationStartedAt

  return {
    evidence,
    aggregation,
    candidateCount: candidates.length,
    deduplicatedCount: unique.size,
    candidateRankingMs,
    evidenceBuildMs,
    aggregationMs
  }
}

/**
 * A recent-conversation answer should cover separate local conversation chunks,
 * not merely pick eight adjacent newest messages from one exchange.
 */
function selectConversationCoverage(
  evidence: AiSearchPipelineEvidence[],
  limit: number
): AiSearchPipelineEvidence[] {
  const max = Math.max(1, limit)
  const byChunk = new Map<string, AiSearchPipelineEvidence[]>()
  for (const item of evidence) {
    const chunk = byChunk.get(item.chunkId) || []
    chunk.push(item)
    byChunk.set(item.chunkId, chunk)
  }
  const representatives = Array.from(byChunk.values())
    .map((items) => [...items].sort(compareEvidence)[0])
    .sort((left, right) => left.timestamp - right.timestamp)
  if (representatives.length <= max) return representatives
  const selected: AiSearchPipelineEvidence[] = []
  for (let index = 0; index < max; index += 1) {
    const position = Math.round((index * (representatives.length - 1)) / (max - 1 || 1))
    const item = representatives[position]
    if (item && !selected.includes(item)) selected.push(item)
  }
  return selected
}

/** Do not expose citations that cannot resolve to program-owned Final Evidence. */
export function sanitizeAnswerCitations(
  answer: string,
  evidence: Array<Pick<AiSearchFinalEvidence, 'id'>>
): CitationValidationResult {
  const allowed = new Set(evidence.map((item) => item.id))
  const invalidCitationIds = new Set<string>()
  const sanitized = answer.replace(/\[E(\d+)\]/g, (citation, number: string) => {
    const id = `E${number}`
    if (allowed.has(id as AiSearchFinalEvidence['id'])) return citation
    invalidCitationIds.add(id)
    return ''
  })
  return {
    answer: sanitized,
    invalidCitationIds: Array.from(invalidCitationIds),
    status: invalidCitationIds.size ? 'sanitized' : 'valid'
  }
}
