import { mkdtempSync } from 'fs'
import { rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_KNOWLEDGE_CHUNKER,
  type KnowledgeChunk,
  type KnowledgeFtsConfig,
  type KnowledgeSourceMessage
} from '../../src/shared/knowledge'
import { chunkConversation, createChunkStreamer } from '../../src/main/knowledge/chunker'
import {
  getKnowledgeDatabasePath,
  KnowledgeStore
} from '../../src/main/knowledge/knowledge-store'
import { normalizeKnowledgeMessage } from '../../src/main/knowledge/normalizer'
import { createSyntheticConversation, FIXTURE_ACCOUNT_A } from '../fixtures/knowledge-rag'

const fts: KnowledgeFtsConfig = {
  profileId: 'test-trigram-external-full',
  tokenizer: 'trigram',
  contentMode: 'external',
  detail: 'full',
  columnsize: 1
}

const roots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'wxe-knowledge-stream-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function* inBatches(
  messages: readonly KnowledgeSourceMessage[],
  size: number
): AsyncGenerator<readonly KnowledgeSourceMessage[], void, void> {
  for (let index = 0; index < messages.length; index += size) {
    yield messages.slice(index, index + size)
  }
}

function readChunks(root: string): Array<{ chunk_id: string; text: string }> {
  const database = new DatabaseSync(getKnowledgeDatabasePath(root, FIXTURE_ACCOUNT_A))
  try {
    return database
      .prepare('SELECT chunk_id, text FROM knowledge_chunks ORDER BY chunk_id')
      .all() as Array<{ chunk_id: string; text: string }>
  } finally {
    database.close()
  }
}

function readState(root: string): Record<string, unknown> | undefined {
  const database = new DatabaseSync(getKnowledgeDatabasePath(root, FIXTURE_ACCOUNT_A))
  try {
    return database
      .prepare('SELECT * FROM knowledge_index_state WHERE conversation_id = ?')
      .get('conversation-stream') as Record<string, unknown> | undefined
  } finally {
    database.close()
  }
}

describe('knowledge chunk streamer', () => {
  it('produces exactly the same chunks as the one-shot chunker for every batch size', () => {
    const conversation = createSyntheticConversation(
      FIXTURE_ACCOUNT_A,
      'conversation-stream',
      0,
      500,
      'mixed'
    )
    const normalized = conversation.messages
      .map(normalizeKnowledgeMessage)
      .sort(
        (left, right) =>
          left.createTime - right.createTime || left.messageId.localeCompare(right.messageId)
      )
    const expected = chunkConversation(normalized, DEFAULT_KNOWLEDGE_CHUNKER)

    for (const size of [1, 5, 12, 13, 64, 499]) {
      const streamer = createChunkStreamer(DEFAULT_KNOWLEDGE_CHUNKER)
      const actual: KnowledgeChunk[] = []
      for (let index = 0; index < normalized.length; index += size) {
        actual.push(...streamer.push(normalized.slice(index, index + size)))
      }
      actual.push(...streamer.drain())
      // 逐 chunk 比对 id 与正文：切点漂移会让正文变、id 也可能变。
      expect(actual.map((chunk) => chunk.chunkId)).toEqual(expected.map((chunk) => chunk.chunkId))
      expect(actual.map((chunk) => chunk.text)).toEqual(expected.map((chunk) => chunk.text))
    }
  })
})

describe('KnowledgeStore.indexConversationStreaming', () => {
  it('writes the same index as a one-shot snapshot', async () => {
    const conversation = createSyntheticConversation(
      FIXTURE_ACCOUNT_A,
      'conversation-stream',
      0,
      400,
      'mixed'
    )

    const oneShotRoot = makeRoot()
    const oneShotStore = new KnowledgeStore(oneShotRoot, FIXTURE_ACCOUNT_A, fts)
    await oneShotStore.index(
      { conversations: [conversation], chunker: DEFAULT_KNOWLEDGE_CHUNKER },
      undefined,
      () => undefined
    )
    oneShotStore.close()
    const expected = readChunks(oneShotRoot)

    const streamedRoot = makeRoot()
    const streamedStore = new KnowledgeStore(streamedRoot, FIXTURE_ACCOUNT_A, fts)
    const result = await streamedStore.indexConversationStreaming(
      'conversation-stream',
      inBatches(conversation.messages, 40),
      DEFAULT_KNOWLEDGE_CHUNKER,
      { completeSnapshot: true, sourceHighWaterTime: 1_800_000_000_000 },
      undefined,
      () => undefined
    )
    streamedStore.close()

    expect(result.cancelled).toBe(false)
    expect(result.processedMessages).toBe(conversation.messages.length)
    expect(expected.length).toBeGreaterThan(0)
    expect(readChunks(streamedRoot)).toEqual(expected)

    const state = readState(streamedRoot)
    // 整段读完后才能置 1；回填过程中一直是 0。
    expect(Number(state?.complete_snapshot)).toBe(1)
    expect(Number(state?.source_high_water_time)).toBe(1_800_000_000_000)
    expect(state?.backfill_resume_time).toBeNull()
  })

  it('resumes from the last committed chunk without duplicating or dropping messages', async () => {
    const conversation = createSyntheticConversation(
      FIXTURE_ACCOUNT_A,
      'conversation-stream',
      0,
      300,
      'mixed'
    )

    const referenceRoot = makeRoot()
    const referenceStore = new KnowledgeStore(referenceRoot, FIXTURE_ACCOUNT_A, fts)
    await referenceStore.indexConversationStreaming(
      'conversation-stream',
      inBatches(conversation.messages, 30),
      DEFAULT_KNOWLEDGE_CHUNKER,
      { completeSnapshot: true },
      undefined,
      () => undefined
    )
    referenceStore.close()
    const expected = readChunks(referenceRoot)

    const root = makeRoot()
    const store = new KnowledgeStore(root, FIXTURE_ACCOUNT_A, fts)
    const controller = new AbortController()
    let emitted = 0
    const interrupted = (async function* () {
      for (let index = 0; index < conversation.messages.length; index += 30) {
        // 喂到大约三分之一就中止，确保有已提交批次、也有未收盘的尾巴。
        if (emitted >= 120) {
          controller.abort()
          return
        }
        emitted += 30
        yield conversation.messages.slice(index, index + 30)
      }
    })()

    const first = await store.indexConversationStreaming(
      'conversation-stream',
      interrupted,
      DEFAULT_KNOWLEDGE_CHUNKER,
      { completeSnapshot: true },
      controller.signal,
      () => undefined
    )
    expect(first.cancelled).toBe(true)
    expect(readChunks(root).length).toBeGreaterThan(0)

    const resume = store.readBackfillResume('conversation-stream')
    expect(resume).not.toBeNull()

    // 续跑：从边界时刻重读，已提交的 chunk 由消息 id 跳过。
    const remaining = conversation.messages.filter(
      (message) => message.createTime >= (resume as { time: number }).time
    )
    await store.indexConversationStreaming(
      'conversation-stream',
      inBatches(remaining, 30),
      DEFAULT_KNOWLEDGE_CHUNKER,
      { completeSnapshot: true, resume: resume ?? undefined },
      undefined,
      () => undefined
    )
    store.close()

    // 不多不少：重复的 chunk 会在这里以重复 id 或多余正文显形。
    expect(readChunks(root)).toEqual(expected)
    const state = readState(root)
    expect(Number(state?.complete_snapshot)).toBe(1)
    expect(state?.backfill_resume_time).toBeNull()
  })

  it('keeps the previous index usable when a pass is interrupted', async () => {
    const conversation = createSyntheticConversation(
      FIXTURE_ACCOUNT_A,
      'conversation-stream',
      0,
      120,
      'short'
    )
    const root = makeRoot()
    const store = new KnowledgeStore(root, FIXTURE_ACCOUNT_A, fts)
    await store.indexConversationStreaming(
      'conversation-stream',
      inBatches(conversation.messages, 20),
      DEFAULT_KNOWLEDGE_CHUNKER,
      { completeSnapshot: true },
      undefined,
      () => undefined
    )
    const before = readChunks(root)

    const controller = new AbortController()
    controller.abort()
    const aborted = await store.indexConversationStreaming(
      'conversation-stream',
      inBatches(conversation.messages, 20),
      DEFAULT_KNOWLEDGE_CHUNKER,
      { completeSnapshot: true },
      controller.signal,
      () => undefined
    )
    store.close()

    expect(aborted.cancelled).toBe(true)
    // 取消不预删旧 chunk，所以中断之后原索引仍然完整。
    expect(readChunks(root)).toEqual(before)
  })
})
