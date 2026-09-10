import { describe, expect, it, vi, beforeEach } from 'vitest'

const fixture = vi.hoisted(() => ({
  contacts: [
    { m_nsUsrName: 'wxid-bobo', m_nsNickName: 'BOBO', md5: 'md5-bobo', type: 'user' as const },
    { m_nsUsrName: 'wxid-bobo-2', m_nsNickName: 'BOBO', md5: 'md5-bobo-2', type: 'user' as const }
  ],
  messages: [
    { id: 'm1', from: 'user', type: '图片', datetime: '2026/8/2 10:00:00', content: '', contentData: { type: 'image', md5: 'image-md5' }, isSender: false, name: 'BOBO', createTime: Math.floor(new Date('2026-08-02T10:00:00+08:00').getTime() / 1000) },
    { id: 'm2', from: 'assistant', type: '文件', datetime: '2026/8/3 10:00:00', content: '', isSender: true, exportMediaType: 'file' as const, exportMediaName: 'a.pdf', createTime: Math.floor(new Date('2026-08-03T10:00:00+08:00').getTime() / 1000) }
  ]
}))
vi.mock('../../src/main/services/chat-service', () => ({
  isReady: () => true,
  listContactsAsync: vi.fn(async () => fixture.contacts),
  listMessagesAsync: vi.fn(async () => fixture.messages)
}))

import { LocalQueryApiService } from '../../src/main/services/local-query-api-service'

describe('LocalQueryApiService', () => {
  const knowledge = { search: vi.fn(async () => ({ state: 'ready', evidence: [{ conversationId: 'md5-bobo', messageId: 'm1', timestamp: 1, sender: 'BOBO', sourceKind: 'text', text: '你好' }], conversationRetrieval: { totalMessages: 2, chunkCount: 1, complete: true }, voiceCoverage: undefined })) } as any
  let service: LocalQueryApiService
  beforeEach(() => { vi.clearAllMocks(); if (!fixture.contacts.some((contact) => contact.md5 === 'md5-bobo-2')) fixture.contacts.push({ m_nsUsrName: 'wxid-bobo-2', m_nsNickName: 'BOBO', md5: 'md5-bobo-2', type: 'user' }); service = new LocalQueryApiService(knowledge, () => new Date('2026-09-09T12:00:00+08:00')) })

  it('publishes capability contract and resolves previous month', async () => {
    expect(service.capabilities().tools.query_messages.messageTypes).toContain('file')
    const result = await service.messages({ target: { query: 'BOBO' }, timeRange: { kind: 'previous_month' }, direction: 'any', order: 'asc', limit: 1 })
    expect(result.status).toBe('ambiguous_contact')
    fixture.contacts.splice(1)
    const resolved = await service.messages({ target: { query: 'BOBO' }, timeRange: { kind: 'previous_month' }, direction: 'any', order: 'asc', limit: 1 })
    expect(resolved.query?.resolvedTimeRange).toMatchObject({ startTime: expect.any(Number), endTime: expect.any(Number), label: '2026年8月' })
    expect(resolved.returnedCount).toBe(1)
  })

  it('filters direction and message type, and rejects too many variants', async () => {
    fixture.contacts.splice(1)
    const result = await service.messages({ target: { query: 'BOBO' }, timeRange: { kind: 'all' }, direction: 'to_target', messageTypes: ['file'], limit: 1 })
    expect(result.messages?.[0].sourceKind).toBe('file')
    await expect(service.search({ target: { query: 'BOBO' }, timeRange: { kind: 'all' }, query: 'x', variants: ['1', '2', '3', '4', '5'] })).resolves.toMatchObject({ status: 'invalid_request' })
  })

  it('returns canonical type and attachment for the earliest non-text message', async () => {
    fixture.contacts.splice(1)
    const result = await service.messages({ target: { query: 'BOBO' }, timeRange: { kind: 'all' }, order: 'asc', limit: 1, excludeSystem: true })
    expect(result.messages?.[0]).toMatchObject({ messageType: 'image', sourceKind: 'image', attachment: { kind: 'image' } })
    expect(result.messages?.[0]).not.toHaveProperty('text')
  })

  it('round-trips opaque refs from messages, search, and overview through context', async () => {
    fixture.contacts.splice(1)
    const queried = await service.messages({ target: { query: 'BOBO' }, timeRange: { kind: 'all' }, order: 'asc', limit: 1 })
    const queriedRef = queried.messages?.[0]?.messageRef
    expect(queriedRef).toEqual(expect.any(String))
    await expect(service.context({ messageRef: queriedRef!, before: 0, after: 0 })).resolves.toMatchObject({
      status: 'completed',
      anchor: { messageRef: queriedRef }
    })

    knowledge.search.mockResolvedValueOnce({ state: 'ready', evidence: [{ conversationId: 'md5-bobo', messageId: 'local:m1', timestamp: 1, sender: 'BOBO', sourceKind: 'text', text: '你好' }], conversationRetrieval: { totalMessages: 2, chunkCount: 1, complete: true }, voiceCoverage: undefined })
    const searched = await service.search({ target: { query: 'BOBO' }, timeRange: { kind: 'all' }, query: '你好' })
    const searchedRef = searched.evidence?.[0]?.messageRef
    expect(searchedRef).toBe(queriedRef)
    await expect(service.context({ messageRef: searchedRef!, before: 0, after: 0 })).resolves.toMatchObject({ status: 'completed' })

    knowledge.search.mockResolvedValueOnce({ state: 'ready', evidence: [{ conversationId: 'md5-bobo', messageId: 'local:m1', timestamp: 1, sender: 'BOBO', sourceKind: 'text', text: '你好' }], conversationRetrieval: { totalMessages: 2, chunkCount: 1, complete: true }, voiceCoverage: undefined })
    const overview = await service.overview({ target: { query: 'BOBO' }, timeRange: { kind: 'all' } })
    const overviewRef = overview.evidence?.[0]?.messageRef
    expect(overviewRef).toBe(queriedRef)
    await expect(service.context({ messageRef: overviewRef!, before: 0, after: 0 })).resolves.toMatchObject({ status: 'completed' })
  })

  it('sorts overview evidence while preserving the selected set and exposes sampling', async () => {
    fixture.contacts.splice(1)
    knowledge.search.mockResolvedValueOnce({ state: 'ready', evidence: [
      { conversationId: 'md5-bobo', messageId: 'late', timestamp: 300, sender: 'BOBO', sourceKind: 'text', text: 'late' },
      { conversationId: 'md5-bobo', messageId: 'early', timestamp: 100, sender: 'BOBO', sourceKind: 'text', text: 'early' }
    ], conversationRetrieval: { totalMessages: 82, chunkCount: 4, complete: true }, voiceCoverage: undefined })
    const result = await service.overview({ target: { query: 'BOBO' }, timeRange: { kind: 'previous_month' } })
    expect(result.sourceCoverage).toEqual({ state: 'complete', sourceMessageCount: 82 })
    expect(result.selection).toEqual({ mode: 'temporal_coverage', selectedEvidenceCount: 2, sampled: true })
    expect(result.evidence?.map((item) => item.timestamp)).toEqual([100, 300])
  })
})
