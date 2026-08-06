import { mkdtempSync } from 'fs'
import { rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { performance } from 'perf_hooks'
import { afterAll, describe, expect, it } from 'vitest'
import {
  DEFAULT_KNOWLEDGE_CHUNKER,
  type KnowledgeEvidence,
  type KnowledgeFtsConfig,
  type KnowledgeSourceMessage
} from '../../src/shared/knowledge'
import { KnowledgeStore } from '../../src/main/knowledge/knowledge-store'
import {
  createRealisticKnowledgeFixture,
  type RealisticBenchmarkCase,
  type RealisticBenchmarkCategory
} from '../fixtures/knowledge-realistic'

const root = mkdtempSync(join(tmpdir(), 'wxe-realistic-fts-'))

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

type Retrieval = { messageIds: string[] }
type Metrics = {
  recallAt5: number
  recallAt10: number
  mrr: number
  evidenceAccuracy: number
  findSuccessAt10: number
  p50LatencyMs: number
  p95LatencyMs: number
}

function percentile(values: number[], ratio: number): number {
  if (!values.length) return 0
  const sorted = values.slice().sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)]
}

function oldSearch(
  messages: KnowledgeSourceMessage[],
  testCase: RealisticBenchmarkCase
): Retrieval[] {
  return messages
    .map((message) => {
      const text =
        `${message.text || ''}\n${message.voiceTranscript || ''}\n${message.attachment?.name || ''}`.toLowerCase()
      const score = testCase.searchTerms.reduce(
        (total, term) => total + (text.includes(term.toLowerCase()) ? 1 : 0),
        0
      )
      return { messageIds: [message.messageId], score }
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
}

function score(
  cases: RealisticBenchmarkCase[],
  search: (testCase: RealisticBenchmarkCase) => Retrieval[]
): Metrics {
  const latency: number[] = []
  let recallAt5 = 0
  let recallAt10 = 0
  let reciprocalRank = 0
  let evidenceAccuracy = 0
  let findSuccessAt10 = 0
  for (const testCase of cases) {
    const started = performance.now()
    const results = search(testCase)
    latency.push(performance.now() - started)
    const expected = new Set(testCase.expectedMessageIds)
    const firstTen = results.slice(0, 10)
    const hitIndex = firstTen.findIndex((item) => item.messageIds.some((id) => expected.has(id)))
    if (results.slice(0, 5).some((item) => item.messageIds.some((id) => expected.has(id)))) {
      recallAt5 += 1
    }
    if (hitIndex >= 0) {
      recallAt10 += 1
      findSuccessAt10 += 1
      reciprocalRank += 1 / (hitIndex + 1)
    }
    const firstFive = results.slice(0, 5)
    if (firstFive.length) {
      evidenceAccuracy +=
        firstFive.filter((item) => item.messageIds.some((id) => expected.has(id))).length /
        firstFive.length
    }
  }
  return {
    recallAt5: recallAt5 / cases.length,
    recallAt10: recallAt10 / cases.length,
    mrr: reciprocalRank / cases.length,
    evidenceAccuracy: evidenceAccuracy / cases.length,
    findSuccessAt10: findSuccessAt10 / cases.length,
    p50LatencyMs: percentile(latency, 0.5),
    p95LatencyMs: percentile(latency, 0.95)
  }
}

function groupedByCategory<T>(
  cases: RealisticBenchmarkCase[],
  evaluate: (items: RealisticBenchmarkCase[]) => T
): Record<RealisticBenchmarkCategory, T> {
  const groups = new Map<RealisticBenchmarkCategory, RealisticBenchmarkCase[]>()
  for (const item of cases) groups.set(item.category, [...(groups.get(item.category) || []), item])
  return Object.fromEntries(
    Array.from(groups.entries()).map(([category, items]) => [category, evaluate(items)])
  ) as Record<RealisticBenchmarkCategory, T>
}

const profiles: KnowledgeFtsConfig[] = [
  {
    profileId: 'unicode61-external-full-columnsize',
    tokenizer: 'unicode61',
    contentMode: 'external',
    detail: 'full',
    columnsize: 1
  },
  {
    profileId: 'trigram-external-full-columnsize',
    tokenizer: 'trigram',
    contentMode: 'external',
    detail: 'full',
    columnsize: 1
  },
  {
    profileId: 'trigram-external-column-no-columnsize',
    tokenizer: 'trigram',
    contentMode: 'external',
    detail: 'column',
    columnsize: 0
  }
]

describe('realistic desensitized WeChat FTS5 benchmark', () => {
  it('compares unicode61 and trigram by recall quality before Task 3 chooses a runtime profile', async () => {
    const fixture = createRealisticKnowledgeFixture()
    const messages = fixture.conversations.flatMap((conversation) => conversation.messages)
    const oldMetrics = score(fixture.cases, (testCase) => oldSearch(messages, testCase))
    const comparisons: Array<{
      profile: KnowledgeFtsConfig
      metrics: Metrics
      categoryMetrics: Record<RealisticBenchmarkCategory, Metrics>
      databaseBytes: number
    }> = []
    for (const profile of profiles) {
      const store = new KnowledgeStore(
        join(root, profile.profileId),
        messages[0].accountId,
        profile
      )
      await store.index({
        conversations: fixture.conversations,
        chunker: DEFAULT_KNOWLEDGE_CHUNKER
      })
      const search = (testCase: RealisticBenchmarkCase): Retrieval[] =>
        store
          .search({
            accountId: messages[0].accountId,
            text: testCase.question,
            terms: testCase.searchTerms,
            limit: 10
          })
          .map((item: KnowledgeEvidence) => ({ messageIds: item.messageIds }))
      const metrics = score(fixture.cases, search)
      store.checkpoint()
      comparisons.push({
        profile,
        metrics,
        categoryMetrics: groupedByCategory(fixture.cases, (items) => score(items, search)),
        databaseBytes: store.getStorageStats().databaseBytes
      })
      store.close()
    }
    console.log(
      `KNOWLEDGE_REALISTIC_FTS_REPORT=${JSON.stringify(
        {
          fixture: 'realistic-desensitized-wechat-v1',
          questionCount: fixture.cases.length,
          categories: Array.from(new Set(fixture.cases.map((item) => item.category))),
          oldSearch: oldMetrics,
          fts5Comparisons: comparisons
        },
        null,
        2
      )}`
    )
    expect(fixture.cases).toHaveLength(14)
    expect(new Set(fixture.cases.map((item) => item.category))).toEqual(
      new Set([
        'chinese-continuous',
        'chinese-short',
        'person-name',
        'mixed-language',
        'url',
        'file-name',
        'technical-term',
        'number-email-path',
        'short-message',
        'long-voice'
      ])
    )
    expect(comparisons).toHaveLength(profiles.length)
  })
})
