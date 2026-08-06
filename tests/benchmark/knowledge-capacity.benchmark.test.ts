import { mkdtempSync } from 'fs'
import { rename, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { performance } from 'perf_hooks'
import { describe, expect, it } from 'vitest'
import { DEFAULT_KNOWLEDGE_CHUNKER, type KnowledgeFtsConfig } from '../../src/shared/knowledge'
import { KnowledgeStore } from '../../src/main/knowledge/knowledge-store'
import { createSyntheticConversation, FIXTURE_ACCOUNT_A } from '../fixtures/knowledge-rag'

const runCapacity = process.env.KNOWLEDGE_CAPACITY === '1'
const capacityIt = runCapacity ? it : it.skip
const scales = [100_000, 500_000, 1_000_000] as const
const distributions = ['short', 'mixed', 'long'] as const
const batchSize = 10_000
const reportPath = process.env.KNOWLEDGE_CAPACITY_REPORT_PATH || join(tmpdir(), 'wechatexplorer-knowledge-capacity-report.json')
const profile: KnowledgeFtsConfig = {
  profileId: 'capacity-unicode-external-full-columnsize',
  tokenizer: 'unicode61',
  contentMode: 'external',
  detail: 'full',
  columnsize: 1
}

describe('knowledge capacity benchmark', () => {
  capacityIt(
    'measures 100k, 500k and 1m desensitized messages across text distributions',
    async () => {
      const reports: Array<Record<string, number | string>> = []
      for (const distribution of distributions) {
        for (const messageCount of scales) {
          const root = mkdtempSync(join(tmpdir(), `wxe-knowledge-capacity-${distribution}-${messageCount}-`))
          const store = new KnowledgeStore(root, FIXTURE_ACCOUNT_A, profile)
          let peakWalBytes = 0
          let peakTemporaryBytes = 0
          let peakRssBytes = process.memoryUsage().rss
          const started = performance.now()
          try {
            for (let offset = 0; offset < messageCount; offset += batchSize) {
              const count = Math.min(batchSize, messageCount - offset)
              await store.index({
                conversations: [
                  createSyntheticConversation(
                    FIXTURE_ACCOUNT_A,
                    `capacity-${distribution}-${offset / batchSize}`,
                    offset,
                    count,
                    distribution
                  )
                ],
                chunker: DEFAULT_KNOWLEDGE_CHUNKER
              })
              const stats = store.getStorageStats()
              peakWalBytes = Math.max(peakWalBytes, stats.walBytes)
              peakTemporaryBytes = Math.max(peakTemporaryBytes, stats.walBytes + stats.shmBytes)
              peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss)
            }
            store.checkpoint()
            const stats = store.getStorageStats()
            reports.push({
              profile: profile.profileId,
              distribution,
              messageCount,
              finalDatabaseBytes: stats.databaseBytes,
              perTenThousandMessagesBytes: Math.round(stats.databaseBytes / (messageCount / 10_000)),
              peakWalBytes,
              peakTemporaryBytes,
              elapsedMs: Math.round(performance.now() - started),
              workerPeakRssBytes: peakRssBytes,
              pageSize: stats.pageSize,
              pageCount: stats.pageCount,
              freelistCount: stats.freelistCount
            })
          } finally {
            store.close()
            await rm(root, { recursive: true, force: true })
          }
        }
      }
      const report = {
        generatedAt: new Date().toISOString(),
        fixture: 'synthetic-desensitized-v1',
        profile,
        scenarios: reports
      }
      const temporaryReportPath = `${reportPath}.partial`
      await writeFile(temporaryReportPath, JSON.stringify(report, null, 2), 'utf8')
      await rename(temporaryReportPath, reportPath)
      console.log(`KNOWLEDGE_CAPACITY_REPORT_PATH=${reportPath}`)
      expect(reports).toHaveLength(scales.length * distributions.length)
    },
    20 * 60 * 1000
  )
})
