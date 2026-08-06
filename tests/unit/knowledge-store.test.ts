import { mkdtempSync, existsSync } from 'fs'
import { rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_KNOWLEDGE_CHUNKER, type KnowledgeFtsConfig } from '../../src/shared/knowledge'
import { chunkConversation } from '../../src/main/knowledge/chunker'
import {
  estimateKnowledgeCapacityPreflight,
  getKnowledgeDatabasePath,
  KnowledgeStore,
  removeKnowledgeDatabase
} from '../../src/main/knowledge/knowledge-store'
import { normalizeKnowledgeMessage } from '../../src/main/knowledge/normalizer'
import {
  createSyntheticConversation,
  FIXTURE_ACCOUNT_A,
  FIXTURE_ACCOUNT_B
} from '../fixtures/knowledge-rag'

const roots: string[] = []
const fts: KnowledgeFtsConfig = {
  profileId: 'test-trigram-external-full',
  tokenizer: 'trigram',
  contentMode: 'external',
  detail: 'full',
  columnsize: 1
}

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'wxe-knowledge-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('knowledge normalizer and chunker', () => {
  it('indexes text, attachment metadata and existing voice transcripts without paths or binary data', () => {
    const normalized = normalizeKnowledgeMessage({
      accountId: FIXTURE_ACCOUNT_A,
      conversationId: 'conversation-a',
      messageId: 'message-a',
      createTime: 1,
      kind: 'voice',
      text: ' 原始说明 ',
      attachment: { name: 'plan.txt', kind: 'file' },
      voiceTranscript: ' 已完成语音转写 '
    })
    expect(normalized.searchableText).toContain('原始说明')
    expect(normalized.searchableText).toContain('附件：plan.txt')
    expect(normalized.searchableText).toContain('语音转写：已完成语音转写')
  })

  it('cuts on time gaps and preserves message evidence ids', () => {
    const source = createSyntheticConversation(
      FIXTURE_ACCOUNT_A,
      'conversation-a',
      0,
      4,
      'short'
    ).messages
    source[3].createTime += 20 * 60 * 1000
    const chunks = chunkConversation(source.map(normalizeKnowledgeMessage), {
      ...DEFAULT_KNOWLEDGE_CHUNKER,
      maxMessages: 12
    })
    expect(chunks).toHaveLength(2)
    expect(chunks.flatMap((chunk) => chunk.messageIds)).toEqual(
      source.map((item) => item.messageId)
    )
  })
})

describe('knowledge sqlite', () => {
  it('is idempotent, supports FTS evidence lookup, and does not mix accounts', async () => {
    const root = makeRoot()
    const source = createSyntheticConversation(FIXTURE_ACCOUNT_A, 'conversation-a', 0, 25, 'mixed')
    const store = new KnowledgeStore(root, FIXTURE_ACCOUNT_A, fts)
    const first = await store.index({ conversations: [source], chunker: DEFAULT_KNOWLEDGE_CHUNKER })
    const second = await store.index({
      conversations: [source],
      chunker: DEFAULT_KNOWLEDGE_CHUNKER
    })
    expect(first.updatedChunks).toBeGreaterThan(0)
    expect(second.updatedChunks).toBe(0)
    expect(second.unchangedConversations).toBe(1)
    const evidence = store.search({ accountId: FIXTURE_ACCOUNT_A, text: '本地知识库', limit: 10 })
    expect(evidence).not.toHaveLength(0)
    expect(evidence[0]).toMatchObject({
      messageId: expect.stringMatching(/^synthetic-mixed-/),
      conversationId: 'conversation-a',
      sender: expect.any(String),
      timestamp: expect.any(Number)
    })
    expect(
      evidence.every((item) => item.messageIds.every((id) => id.startsWith('synthetic-mixed-')))
    ).toBe(true)
    expect(() =>
      store.search({ accountId: FIXTURE_ACCOUNT_B, text: '本地知识库', limit: 10 })
    ).toThrow(/account/)
    store.close()
  })

  it('recovers safely after cancellation and only removes the derived database', async () => {
    const root = makeRoot()
    const source = createSyntheticConversation(
      FIXTURE_ACCOUNT_A,
      'conversation-a',
      0,
      2_000,
      'mixed'
    )
    const controller = new AbortController()
    const store = new KnowledgeStore(root, FIXTURE_ACCOUNT_A, fts)
    const cancelled = await store.index(
      { conversations: [source], chunker: DEFAULT_KNOWLEDGE_CHUNKER },
      controller.signal,
      (progress) => {
        if (progress.processedMessages >= 501) controller.abort()
      }
    )
    expect(cancelled.cancelled).toBe(true)
    const resumed = await store.index({
      conversations: [source],
      chunker: DEFAULT_KNOWLEDGE_CHUNKER
    })
    expect(resumed.cancelled).toBe(false)
    const databasePath = getKnowledgeDatabasePath(root, FIXTURE_ACCOUNT_A)
    store.close()
    expect(existsSync(databasePath)).toBe(true)
    removeKnowledgeDatabase(root, FIXTURE_ACCOUNT_A)
    expect(existsSync(databasePath)).toBe(false)
  })

  it('uses a bounded exact fallback for two-character Chinese queries with the trigram profile', async () => {
    const root = makeRoot()
    const store = new KnowledgeStore(root, FIXTURE_ACCOUNT_A, fts)
    await store.index({
      conversations: [
        {
          conversationId: 'short-query',
          completeSnapshot: true,
          messages: [
            {
              accountId: FIXTURE_ACCOUNT_A,
              conversationId: 'short-query',
              messageId: 'short-query-message',
              createTime: Date.UTC(2026, 7, 5),
              senderId: 'fixture-member',
              senderName: '脱敏成员',
              kind: 'text',
              text: '收到，明早十点。'
            }
          ]
        }
      ],
      chunker: DEFAULT_KNOWLEDGE_CHUNKER
    })
    expect(
      store.search({ accountId: FIXTURE_ACCOUNT_A, text: '十点', terms: ['十点'], limit: 10 })
    ).toEqual([
      expect.objectContaining({ messageId: 'short-query-message', conversationId: 'short-query' })
    ])
    store.close()
  })

  it('keeps equal message ids from different conversations as separate Evidence', async () => {
    const root = makeRoot()
    const store = new KnowledgeStore(root, FIXTURE_ACCOUNT_A, fts)
    await store.index({
      conversations: ['conversation-a', 'conversation-b'].map((conversationId) => ({
        conversationId,
        completeSnapshot: true,
        messages: [
          {
            accountId: FIXTURE_ACCOUNT_A,
            conversationId,
            messageId: 'shared-message-id',
            createTime: Date.UTC(2026, 7, 5),
            senderId: `${conversationId}-sender`,
            senderName: conversationId,
            kind: 'text',
            text: '今天去健身。'
          }
        ]
      })),
      chunker: DEFAULT_KNOWLEDGE_CHUNKER
    })

    const result = store.searchWithStatus({
      accountId: FIXTURE_ACCOUNT_A,
      text: '去健身',
      terms: ['去健身'],
      limit: 10
    })
    const evidence = result.evidence

    expect(evidence).toHaveLength(2)
    expect(evidence.map((item) => `${item.conversationId}:${item.messageId}`).sort()).toEqual([
      'conversation-a:shared-message-id',
      'conversation-b:shared-message-id'
    ])
    expect(result.timings).toMatchObject({
      workerIpcMs: 0,
      ftsMs: expect.any(Number),
      messageLoadMs: expect.any(Number),
      chunkExpandMs: expect.any(Number),
      rankingMs: expect.any(Number),
      totalMs: expect.any(Number)
    })
    expect(result.timings.totalMs).toBeGreaterThanOrEqual(result.timings.ftsMs)
    store.close()
  })

  it('marks voice Evidence and reports scoped transcript coverage without indexing error text', async () => {
    const root = makeRoot()
    const store = new KnowledgeStore(root, FIXTURE_ACCOUNT_A, fts)
    await store.index({
      conversations: [
        {
          conversationId: 'voice-coverage',
          completeSnapshot: true,
          messages: [
            {
              accountId: FIXTURE_ACCOUNT_A,
              conversationId: 'voice-coverage',
              messageId: 'voice-ready',
              createTime: Date.UTC(2026, 7, 5, 9),
              senderName: '成员甲',
              kind: 'voice',
              text: '[语音消息]',
              voiceTranscript: '语音里确认今天去健身。',
              voiceTranscriptState: 'transcribed'
            },
            {
              accountId: FIXTURE_ACCOUNT_A,
              conversationId: 'voice-coverage',
              messageId: 'voice-failed',
              createTime: Date.UTC(2026, 7, 5, 10),
              senderName: '成员乙',
              kind: 'voice',
              text: '[语音消息]',
              voiceTranscriptState: 'failed'
            }
          ]
        }
      ],
      chunker: DEFAULT_KNOWLEDGE_CHUNKER
    })

    const result = store.searchWithStatus({
      accountId: FIXTURE_ACCOUNT_A,
      text: '去健身',
      terms: ['去健身'],
      conversationIds: ['voice-coverage'],
      limit: 10
    })

    expect(result.evidence[0]).toMatchObject({
      messageId: 'voice-ready',
      sourceKind: 'voice'
    })
    expect(result.voiceCoverage).toEqual({
      voiceMessageCount: 2,
      transcribedVoiceCount: 1,
      failedVoiceCount: 1,
      voiceCoverageComplete: false
    })
    expect(result.evidence[0].text).not.toContain('失败')
    store.close()
  })

  it('keeps conversation, sender and time filters when a participant question has no topic terms', async () => {
    const root = makeRoot()
    const store = new KnowledgeStore(root, FIXTURE_ACCOUNT_A, fts)
    await store.index({
      conversations: [
        {
          conversationId: 'participant-query',
          completeSnapshot: true,
          messages: [
            {
              accountId: FIXTURE_ACCOUNT_A,
              conversationId: 'participant-query',
              messageId: 'participant-a',
              createTime: Date.UTC(2026, 7, 5, 9),
              senderId: 'member-a',
              senderName: '成员甲',
              kind: 'text',
              text: '第一条讨论。'
            },
            {
              accountId: FIXTURE_ACCOUNT_A,
              conversationId: 'participant-query',
              messageId: 'participant-b',
              createTime: Date.UTC(2026, 7, 5, 10),
              senderId: 'member-b',
              senderName: '成员乙',
              kind: 'text',
              text: '第二条讨论。'
            }
          ]
        }
      ],
      chunker: DEFAULT_KNOWLEDGE_CHUNKER
    })
    expect(
      store.search({
        accountId: FIXTURE_ACCOUNT_A,
        text: '成员甲最近聊了什么',
        terms: [],
        conversationIds: ['participant-query'],
        senderIds: ['member-a'],
        startTime: Date.UTC(2026, 7, 5, 8),
        limit: 10
      })
    ).toEqual([expect.objectContaining({ messageId: 'participant-a', sender: '成员甲' })])
    store.close()
  })

  it('compresses a single-conversation recap into time chunks and deprioritizes system messages', async () => {
    const root = makeRoot()
    const store = new KnowledgeStore(root, FIXTURE_ACCOUNT_A, fts)
    const base = Date.UTC(2026, 6, 1)
    await store.index({
      conversations: [
        {
          conversationId: 'recap-query',
          completeSnapshot: true,
          messages: Array.from({ length: 48 }, (_, index) => ({
            accountId: FIXTURE_ACCOUNT_A,
            conversationId: 'recap-query',
            messageId: `recap-${index}`,
            createTime: base + Math.floor(index / 12) * 3 * 3600 * 1000 + (index % 12) * 60_000,
            senderId: 'fixture-member',
            senderName: '脱敏成员',
            kind: index % 11 === 0 ? ('system' as const) : ('text' as const),
            text: index % 11 === 0 ? '对方撤回了一条消息' : `第 ${index} 条健身计划和饮食安排讨论。`
          }))
        }
      ],
      chunker: DEFAULT_KNOWLEDGE_CHUNKER
    })
    const result = store.searchWithStatus({
      accountId: FIXTURE_ACCOUNT_A,
      text: '我和张三最近聊了什么',
      terms: [],
      conversationIds: ['recap-query'],
      startTime: base,
      limit: 100
    })

    expect(result.conversationRetrieval).toMatchObject({
      totalMessages: 48,
      chunkCount: 4,
      complete: true
    })
    expect(result.evidence.length).toBeLessThan(48)
    expect(new Set(result.evidence.map((item) => item.chunkId)).size).toBeGreaterThan(1)
    expect(result.evidence.filter((item) => item.text.includes('撤回')).length).toBeLessThan(5)
    store.close()
  })

  it('keeps late conversation slices when the recap candidate budget is reached', async () => {
    const root = makeRoot()
    const store = new KnowledgeStore(root, FIXTURE_ACCOUNT_A, fts)
    const base = Date.UTC(2026, 6, 1)
    await store.index({
      conversations: [
        {
          conversationId: 'long-recap-query',
          completeSnapshot: true,
          messages: Array.from({ length: 90 }, (_, index) => ({
            accountId: FIXTURE_ACCOUNT_A,
            conversationId: 'long-recap-query',
            messageId: `long-recap-${index}`,
            createTime: base + Math.floor(index / 3) * 3 * 3600 * 1000 + (index % 3) * 60_000,
            senderId: 'fixture-member',
            senderName: '脱敏成员',
            kind: 'text' as const,
            text: `第 ${index} 条近期聊天内容。`
          }))
        }
      ],
      chunker: DEFAULT_KNOWLEDGE_CHUNKER
    })

    const result = store.searchWithStatus({
      accountId: FIXTURE_ACCOUNT_A,
      text: '我和张三最近聊了什么',
      terms: [],
      conversationIds: ['long-recap-query'],
      startTime: base,
      limit: 100
    })

    expect(result.conversationRetrieval).toMatchObject({ chunkCount: 30, candidateMessages: 60 })
    expect(Math.max(...result.evidence.map((item) => item.timestamp))).toBeGreaterThan(
      base + 28 * 3 * 3600 * 1000
    )
    store.close()
  })

  it('provides a read-only capacity preflight before a database exists', async () => {
    const root = makeRoot()
    const source = createSyntheticConversation(FIXTURE_ACCOUNT_A, 'conversation-a', 0, 20, 'long')
    const result = await estimateKnowledgeCapacityPreflight({
      accountId: FIXTURE_ACCOUNT_A,
      databaseRoot: root,
      conversations: [source],
      chunker: DEFAULT_KNOWLEDGE_CHUNKER,
      availableDiskBytes: 1
    })
    expect(result.sourceMessageCount).toBe(20)
    expect(result.voiceTranscriptCount).toBeGreaterThan(0)
    expect(result.hasSufficientDiskSpace).toBe(false)
    expect(existsSync(getKnowledgeDatabasePath(root, FIXTURE_ACCOUNT_A))).toBe(false)
  })

  it('indexes 100,000 desensitized messages without touching the main process database', async () => {
    const root = makeRoot()
    const store = new KnowledgeStore(root, FIXTURE_ACCOUNT_A, fts)
    const started = performance.now()
    for (let batch = 0; batch < 10; batch += 1) {
      const source = createSyntheticConversation(
        FIXTURE_ACCOUNT_A,
        `performance-${batch}`,
        batch * 10_000,
        10_000,
        'mixed'
      )
      await store.index({ conversations: [source], chunker: DEFAULT_KNOWLEDGE_CHUNKER })
    }
    const stats = store.getStorageStats()
    expect(stats.databaseBytes).toBeGreaterThan(0)
    expect(performance.now() - started).toBeLessThan(60_000)
    store.close()
  }, 70_000)
})
