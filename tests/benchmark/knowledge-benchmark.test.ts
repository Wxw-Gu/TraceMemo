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
  createKnowledgeBenchmarkFixture,
  type KnowledgeBenchmarkCase
} from '../fixtures/knowledge-rag'

const root = mkdtempSync(join(tmpdir(), 'wxe-knowledge-benchmark-'))

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
  averageInputTokens: number
}

function percentile(values: number[], percentileValue: number): number {
  if (!values.length) return 0
  const sorted = values.slice().sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1)]
}

function estimateInputTokens(messages: KnowledgeSourceMessage[]): number {
  const chars = messages.reduce((total, message) => total + (message.text || '').length, 0)
  // Conservative Chinese-oriented baseline: question/system metadata plus the selected old-search context.
  return 1_000 + Math.ceil(chars / 2)
}

function oldSearch(
  messages: KnowledgeSourceMessage[],
  testCase: KnowledgeBenchmarkCase
): Retrieval[] {
  const normalizedTerms = testCase.oldSearchTerms.map((term) => term.toLowerCase())
  return messages
    .map((message) => {
      const text =
        `${message.text || ''}\n${message.voiceTranscript || ''}\n${message.attachment?.name || ''}`.toLowerCase()
      const score = normalizedTerms.reduce(
        (total, term) => total + (text.includes(term) ? 1 : 0),
        0
      )
      return { messageIds: [message.messageId], score }
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
}

function scoreCases(
  cases: KnowledgeBenchmarkCase[],
  search: (testCase: KnowledgeBenchmarkCase) => Retrieval[],
  inputTokens: (testCase: KnowledgeBenchmarkCase) => number
): Metrics {
  const latency: number[] = []
  let recallAt5 = 0
  let recallAt10 = 0
  let reciprocalRank = 0
  let evidenceAccuracy = 0
  let findSuccessAt10 = 0
  let totalInputTokens = 0
  for (const testCase of cases) {
    const started = performance.now()
    const retrieved = search(testCase)
    latency.push(performance.now() - started)
    const flattened = retrieved.map((item) => item.messageIds)
    const expected = new Set(testCase.expectedMessageIds)
    const hitPosition = flattened.findIndex((ids) => ids.some((id) => expected.has(id)))
    if (flattened.slice(0, 5).some((ids) => ids.some((id) => expected.has(id)))) recallAt5 += 1
    if (hitPosition >= 0 && hitPosition < 10) {
      recallAt10 += 1
      findSuccessAt10 += 1
      reciprocalRank += 1 / (hitPosition + 1)
    }
    const firstFive = flattened.slice(0, 5)
    if (firstFive.length) {
      evidenceAccuracy +=
        firstFive.filter((ids) => ids.some((id) => expected.has(id))).length / firstFive.length
    }
    totalInputTokens += inputTokens(testCase)
  }
  return {
    recallAt5: recallAt5 / cases.length,
    recallAt10: recallAt10 / cases.length,
    mrr: reciprocalRank / cases.length,
    evidenceAccuracy: evidenceAccuracy / cases.length,
    findSuccessAt10: findSuccessAt10 / cases.length,
    p50LatencyMs: percentile(latency, 0.5),
    p95LatencyMs: percentile(latency, 0.95),
    averageInputTokens: totalInputTokens / cases.length
  }
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
  },
  {
    profileId: 'trigram-internal-none-no-columnsize',
    tokenizer: 'trigram',
    contentMode: 'internal',
    detail: 'none',
    columnsize: 0
  }
]

describe('desensitized local knowledge benchmark', () => {
  it('records the 100-question Old Search baseline and FTS5 configuration comparisons', async () => {
    const fixture = createKnowledgeBenchmarkFixture()
    expect(fixture.cases).toHaveLength(100)
    expect(new Set(fixture.cases.map((item) => item.category))).toEqual(
      new Set(['fact', 'person', 'time', 'decision', 'semantic'])
    )
    const sourceMessages = fixture.conversations.flatMap((conversation) => conversation.messages)
    const oldMetrics = scoreCases(
      fixture.cases,
      (testCase) => oldSearch(sourceMessages, testCase),
      (testCase) => {
        const selected = oldSearch(sourceMessages, testCase).slice(0, 240)
        const ids = new Set(selected.flatMap((item) => item.messageIds))
        return estimateInputTokens(sourceMessages.filter((message) => ids.has(message.messageId)))
      }
    )

    const comparisons: Array<{
      profile: KnowledgeFtsConfig
      metrics: Metrics
      databaseBytes: number
    }> = []
    for (const profile of profiles) {
      const store = new KnowledgeStore(
        join(root, profile.profileId),
        sourceMessages[0].accountId,
        profile
      )
      await store.index({
        conversations: fixture.conversations,
        chunker: DEFAULT_KNOWLEDGE_CHUNKER
      })
      const metrics = scoreCases(
        fixture.cases,
        (testCase) =>
          store.search({
            accountId: sourceMessages[0].accountId,
            text: testCase.question,
            terms: testCase.oldSearchTerms,
            limit: 10
          }),
        (testCase) => {
          const evidence: KnowledgeEvidence[] = store.search({
            accountId: sourceMessages[0].accountId,
            text: testCase.question,
            terms: testCase.oldSearchTerms,
            limit: 10
          })
          return (
            1_000 + Math.ceil(evidence.reduce((total, item) => total + item.text.length, 0) / 2)
          )
        }
      )
      store.checkpoint()
      comparisons.push({ profile, metrics, databaseBytes: store.getStorageStats().databaseBytes })
      store.close()
    }
    console.log(
      `KNOWLEDGE_BENCHMARK_REPORT=${JSON.stringify(
        {
          fixture: 'synthetic-desensitized-v1',
          questions: fixture.cases.length,
          categories: ['fact', 'person', 'time', 'decision', 'semantic'],
          oldSearch: oldMetrics,
          fts5Comparisons: comparisons
        },
        null,
        2
      )}`
    )
    expect(oldMetrics.averageInputTokens).toBeGreaterThan(1_000)
    expect(comparisons).toHaveLength(profiles.length)
  })
})
