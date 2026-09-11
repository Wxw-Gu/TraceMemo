import { describe, expect, it } from 'vitest'
import {
  KNOWLEDGE_FRESHNESS_TOLERANCE_MS,
  isKnowledgeFresh,
  type KnowledgePassProgress,
  type KnowledgeRuntimeStatus
} from '../../src/shared/knowledge'
import { formatIndexDate, knowledgeIsStale, knowledgeStateLabel } from '../../src/renderer/src/components/search/searchFormatters'

type StatusPatch = Partial<
  Pick<KnowledgeRuntimeStatus, 'state' | 'indexLatestAt' | 'sourceLatestAt' | 'pass'>
>

const makePass = (phase: KnowledgePassProgress['phase']): KnowledgePassProgress => ({
  phase,
  cancellable: phase !== 'idle',
  startedAt: 0,
  scannedMessages: 0,
  indexedMessages: 0,
  processedConversations: 0,
  totalConversations: 0,
  skippedConversations: 0,
  mainLoopLagMs: 0
})

const status = (patch: StatusPatch): KnowledgeRuntimeStatus =>
  ({
    accountId: 'fixture',
    state: 'ready',
    indexedMessageCount: 1,
    indexedChunkCount: 1,
    sourceMessageCount: 1,
    processedMessages: 1,
    totalMessages: 1,
    estimatedRemainingMs: null,
    databaseBytes: 0,
    walBytes: 0,
    shmBytes: 0,
    indexLatestAt: null,
    sourceLatestAt: null,
    ...patch
  })

describe('isKnowledgeFresh（READY 与 FRESH 是两个概念）', () => {
  it('索引追平源数据时算 fresh', () => {
    expect(isKnowledgeFresh({ indexLatestAt: 1000, sourceLatestAt: 1000 })).toBe(true)
  })

  it('容差内算 fresh：吸收 Session 元数据晚于消息落库的漂移', () => {
    expect(
      isKnowledgeFresh({ indexLatestAt: 1000, sourceLatestAt: 1000 + KNOWLEDGE_FRESHNESS_TOLERANCE_MS })
    ).toBe(true)
  })

  it('明显落后时算 stale', () => {
    expect(
      isKnowledgeFresh({ indexLatestAt: 1000, sourceLatestAt: 1000 + KNOWLEDGE_FRESHNESS_TOLERANCE_MS + 1 })
    ).toBe(false)
  })

  it('任一侧口径缺失时返回 null（无法判定，不冒充 fresh）', () => {
    expect(isKnowledgeFresh({ indexLatestAt: null, sourceLatestAt: 1000 })).toBeNull()
    expect(isKnowledgeFresh({ indexLatestAt: 1000, sourceLatestAt: null })).toBeNull()
  })
})

describe('Knowledge UI 状态文案', () => {
  const indexLatestAt = new Date('2026-08-26T11:37:24+08:00').getTime()
  const sourceLatestAt = new Date('2026-09-11T11:57:24+08:00').getTime()

  it('索引落后时显示「可用 · 待追新」，不得显示「已同步」', () => {
    const label = knowledgeStateLabel(status({ indexLatestAt, sourceLatestAt }))
    // READY ≠ FRESH：落后时既要说"还能用"，又要如实说"还没追平"。
    expect(label).toBe('可用 · 待追新')
    expect(label).not.toBe('已同步')
    expect(label).not.toContain('已追至最新')
    expect(knowledgeIsStale(status({ indexLatestAt, sourceLatestAt }))).toBe(true)
    // 卡片必须能给出真实的覆盖边界。
    expect(formatIndexDate(indexLatestAt)).toBe('8/26')
  })

  it('索引真正追平源数据最新时才显示「可用 · 已追至最新」', () => {
    expect(knowledgeStateLabel(status({ indexLatestAt: sourceLatestAt, sourceLatestAt }))).toBe(
      '可用 · 已追至最新'
    )
    expect(knowledgeIsStale(status({ indexLatestAt: sourceLatestAt, sourceLatestAt }))).toBe(false)
  })

  it('无法判定 freshness 时不能把"不确定"说成已经追平', () => {
    // 安全侧：无法确认就按"可能还没追平"表达，绝不说「已追至最新」。
    expect(knowledgeStateLabel(status({ indexLatestAt, sourceLatestAt: null }))).toBe(
      '可用 · 待追新'
    )
    expect(knowledgeIsStale(status({ indexLatestAt, sourceLatestAt: null }))).toBe(false)
  })

  it('同步中必须区分「正在追新」与「正在补齐历史」', () => {
    expect(knowledgeStateLabel(status({ state: 'syncing', indexLatestAt, sourceLatestAt }))).toBe(
      '可用 · 正在追新'
    )
    // 首轮全量建立历史时不能谎称"只是在追新"。
    expect(
      knowledgeStateLabel(
        status({
          state: 'syncing',
          indexLatestAt,
          sourceLatestAt,
          pass: makePass('full')
        })
      )
    ).toBe('可用 · 正在补齐历史')
  })

  it('取消与失败都不能丢掉「可用」前缀（已建立的分片仍然能查）', () => {
    expect(knowledgeStateLabel(status({ state: 'cancelled' }))).toBe('可用 · 同步已取消')
    expect(knowledgeStateLabel(status({ state: 'error' }))).toBe('可用 · 更新失败')
  })
})
