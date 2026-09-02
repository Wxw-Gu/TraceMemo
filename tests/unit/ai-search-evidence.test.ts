import { describe, expect, it } from 'vitest'
import {
  buildFinalEvidence,
  evidenceIdentity,
  sanitizeAnswerCitations
} from '../../src/main/services/ai-search-evidence'
import type { AiSearchPipelineEvidence } from '../../src/shared/ai-search'

const candidate = (
  index: number,
  options: Partial<AiSearchPipelineEvidence> = {}
): AiSearchPipelineEvidence => ({
  chunkId: `chunk-${index}`,
  conversationId: index % 2 ? 'fitness-group-a' : 'fitness-group-b',
  conversationName: index % 2 ? '健身群 A' : '健身群 B',
  conversationType: 'group',
  messageId: `message-${index}`,
  senderId: index % 3 ? 'member-yang' : 'member-dongfang',
  sender: index % 3 ? '杨伟' : '东方小唠',
  startTime: 1_785_895_200_000 + index,
  endTime: 1_785_895_200_000 + index,
  timestamp: 1_785_895_200_000 + index,
  messageIds: [`message-${index}`],
  sourceKind: 'text',
  text: `第 ${index} 条去健身相关消息`,
  score: -index,
  ...options
})

describe('Final Evidence builder', () => {
  it('uses exactly the same program-owned E1-E8 collection for final context', () => {
    const candidates = Array.from({ length: 16 }, (_, index) => candidate(index + 1))
    const result = buildFinalEvidence(candidates, 8)

    expect(result.candidateCount).toBe(16)
    expect(result.evidence).toHaveLength(8)
    expect(result.collection).toHaveLength(16)
    expect(result.evidence.map((item) => item.id)).toEqual([
      'E1',
      'E2',
      'E3',
      'E4',
      'E5',
      'E6',
      'E7',
      'E8'
    ])
    expect(result.evidence.map(evidenceIdentity)).toEqual(
      Array.from({ length: 8 }, (_, index) => evidenceIdentity(candidate(16 - index)))
    )
    expect(result.aggregation.messageCount).toBe(8)
    expect(result.aggregation.peopleCount).toBe(2)
    expect(result.aggregation.conversationCount).toBe(2)
  })

  it('does not merge same message ids from different conversations', () => {
    const first = candidate(1, { conversationId: 'conversation-a', messageId: 'same-message-id' })
    const second = candidate(2, { conversationId: 'conversation-b', messageId: 'same-message-id' })

    const result = buildFinalEvidence([first, second], 8)

    expect(result.evidence).toHaveLength(2)
    expect(result.evidence.map(evidenceIdentity)).toEqual([
      'conversation-b\u0000same-message-id',
      'conversation-a\u0000same-message-id'
    ])
  })

  it('preserves voice source type through Final Evidence', () => {
    const result = buildFinalEvidence([candidate(1, { sourceKind: 'voice' })], 8)

    expect(result.evidence[0]).toMatchObject({ id: 'E1', sourceKind: 'voice' })
  })

  it('covers different conversations before filling remaining relevance slots', () => {
    const candidates = Array.from({ length: 24 }, (_, index) =>
      candidate(index + 1, {
        conversationId: `conversation-${Math.floor(index / 2) + 1}`,
        conversationName: `群聊 ${Math.floor(index / 2) + 1}`,
        score: -(index + 1)
      })
    )

    const result = buildFinalEvidence(candidates, 8, { strategy: 'conversation_coverage' })

    expect(result.evidence).toHaveLength(8)
    expect(new Set(result.evidence.map((item) => item.conversationId)).size).toBe(8)
    expect(new Set(result.evidence.map((item) => item.conversationId))).toEqual(
      new Set(Array.from({ length: 8 }, (_, index) => `conversation-${12 - index}`))
    )
  })

  it('keeps sender coverage separate from conversation coverage', () => {
    const candidates = Array.from({ length: 12 }, (_, index) =>
      candidate(index + 1, {
        conversationId: `conversation-${Math.floor(index / 3) + 1}`,
        senderId: `sender-${Math.floor(index / 2) + 1}`,
        sender: `成员 ${Math.floor(index / 2) + 1}`,
        score: -(index + 1)
      })
    )

    const result = buildFinalEvidence(candidates, 8, { strategy: 'sender_coverage' })

    expect(result.evidence).toHaveLength(8)
    expect(new Set(result.evidence.map((item) => item.senderId)).size).toBe(6)
  })

  it('removes citations which do not resolve to Final Evidence', () => {
    const evidence = buildFinalEvidence([candidate(1), candidate(2)], 8).evidence
    const result = sanitizeAnswerCitations('杨伟提到健身。[E1] 另有无效来源。[E10][E23]', evidence)

    expect(result.status).toBe('sanitized')
    expect(result.invalidCitationIds).toEqual(['E10', 'E23'])
    expect(result.answer).toContain('[E1]')
    expect(result.answer).not.toMatch(/\[E(?:10|23)\]/)
  })
})
