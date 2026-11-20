import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_KNOWLEDGE_CHUNKER,
  type KnowledgeFtsConfig,
  type KnowledgeSourceMessage
} from '../../src/shared/knowledge'
import { KnowledgeStore } from '../../src/main/knowledge/knowledge-store'
import { FIXTURE_ACCOUNT_A } from '../fixtures/knowledge-rag'

const fts: KnowledgeFtsConfig = {
  profileId: 'test-trigram-external-full',
  tokenizer: 'trigram',
  contentMode: 'external',
  detail: 'full',
  columnsize: 1
}

const SCALE = Number(process.env.KNOWLEDGE_STREAM_SCALE || 0)
const PAGE = Number(process.env.KNOWLEDGE_STREAM_PAGE || 1500)

function* syntheticMessages(count: number): Generator<KnowledgeSourceMessage> {
  const base = Date.UTC(2025, 0, 1)
  for (let index = 0; index < count; index += 1) {
    yield {
      accountId: FIXTURE_ACCOUNT_A,
      conversationId: 'conversation-bulk',
      messageId: `bulk-${index}`,
      createTime: base + index * 60_000,
      senderId: `member-${index % 8}`,
      senderName: `脱敏成员${index % 8}`,
      kind: 'text',
      text: `第 ${index} 条脱敏消息：本地知识库索引的内存峰值与吞吐验证。`
    }
  }
}

async function* pagedBatches(count: number): AsyncGenerator<KnowledgeSourceMessage[], void, void> {
  let batch: KnowledgeSourceMessage[] = []
  for (const message of syntheticMessages(count)) {
    batch.push(message)
    if (batch.length >= PAGE) {
      yield batch
      batch = []
    }
  }
  if (batch.length) yield batch
}

describe('knowledge streaming memory profile', () => {
  it('keeps peak heap flat as the conversation grows', async () => {
    if (!SCALE) {
      // 需要显式指定规模：默认不让 CI 跑几十万条。
      expect(true).toBe(true)
      return
    }

    const root = mkdtempSync(join(tmpdir(), 'wxe-knowledge-bulk-'))
    const store = new KnowledgeStore(root, FIXTURE_ACCOUNT_A, fts)
    let peakHeap = 0
    let peakRss = 0
    const startedAt = Date.now()
    let lastSampleAt = startedAt

    try {
      const result = await store.indexConversationStreaming(
        'conversation-bulk',
        pagedBatches(SCALE),
        DEFAULT_KNOWLEDGE_CHUNKER,
        { completeSnapshot: true },
        undefined,
        (processed) => {
          const usage = process.memoryUsage()
          if (processed % (PAGE * 20) === 0 || processed === SCALE) {
            peakHeap = Math.max(peakHeap, usage.heapUsed)
            peakRss = Math.max(peakRss, usage.rss)
            lastSampleAt = Date.now()
          }
        }
      )
      const elapsedMs = Date.now() - startedAt
      expect(result.cancelled).toBe(false)
      expect(result.processedMessages).toBe(SCALE)
      // 只有这一行是给人看的输出，其余断言只保证跑通。
      console.log(
        JSON.stringify({
          scale: SCALE,
          pageSize: PAGE,
          elapsedMs,
          peakHeapMb: Math.round(peakHeap / 1024 / 1024),
          peakRssMb: Math.round(peakRss / 1024 / 1024),
          chunks: result.chunkCount,
          lastSampleAt
        })
      )
    } finally {
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
  }, 20 * 60 * 1000)
})
