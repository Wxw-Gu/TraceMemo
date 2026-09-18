/**
 * 「recent-first 图片文字索引」的行为测试。
 *
 * 这一轮改的是**调度**：不再从最老的历史往下扫，而是先让"最近聊天的图片"可搜索。
 * 调度改动最容易骗人的地方是"看起来更快了，其实漏了东西"，所以这里的断言都落在
 * **可观察的结果**上（读了哪些窗口、处理了哪些消息、覆盖度怎么说），而不是内部变量。
 *
 * 被测的性质：
 * - 分段计划：互不重叠、无空隙，边界唯一；
 * - 处理顺序按时间分段从新到旧；
 * - 断点续跑不重复 OCR；
 * - 历史分段跑着的时候，新图片仍然优先；
 * - 覆盖度能按时间范围回答"这段能不能下确定性结论"；
 * - 老版本既有索引 / 旧 checkpoint 不被降级，源侧有新增时必须补上；
 * - UI 文案不暴露工程术语。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as chat from '../../src/main/services/chat-service'
import { ImageTextIndexService } from '../../src/main/services/image-text-index-service'
import {
  ImageTextIndexStore,
  getImageTextIndexDatabasePath
} from '../../src/main/services/image-text-index-store'
import { sourceMessageId } from '../../src/main/knowledge/message-identity'
import {
  IMAGE_TEXT_BACKFILL_WINDOW_DAYS,
  buildImageTextBackfillSegments,
  describeImageTextRangeCoverage,
  imageTextPhaseLabel,
  imageTextRangeCoverage,
  imageTextWindowToSeconds,
  type ImageTextBackfillTier,
  type ImageTextIndexCoverage,
  type ImageTextTierRunState
} from '../../src/shared/image-text-index'

const ACCOUNT = 'wxid_recent_first_fixture'
const CONVERSATION = 'conversation-fixture-md5'
const DAY_MS = 24 * 60 * 60 * 1000
const ANCHOR_MS = 1_800_000_000_000
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      // 测试收尾尽力而为。
    }
  }
})

function makeDatabaseRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'tm-recent-first-'))
  roots.push(root)
  return root
}

function imageMessage(localId: number, createTimeSeconds: number): chat.FormattedMessage {
  return {
    localId: String(localId),
    createTime: createTimeSeconds,
    content: '[图片]',
    contentData: { type: 'image', md5: `md5-${localId}`, datName: `dat-${localId}` }
  } as unknown as chat.FormattedMessage
}

type Window = { sinceMs?: number; beforeMs?: number }

interface HarnessState {
  messages: chat.FormattedMessage[]
  count: number
  maxLocalId: number
  now: number
}

interface HarnessResult {
  service: ImageTextIndexService
  databasePath: string
  state: HarnessState
  /** 每次向底层请求图片消息时记录的**时间边界**（不含分页上限）。 */
  windows: Window[]
  listImageMessages: ReturnType<typeof vi.fn>
  /** 真正"过了一遍处理"的图片数 —— 用它证明断点续跑没有重做。 */
  findImageFile: ReturnType<typeof vi.fn>
}

function inWindow(message: chat.FormattedMessage, window?: Window): boolean {
  const createTimeMs = (message.createTime || 0) * 1000
  if (window?.sinceMs !== undefined && createTimeMs < window.sinceMs) return false
  if (window?.beforeMs !== undefined && createTimeMs >= window.beforeMs) return false
  return true
}

function makeHarness(options: {
  messages: chat.FormattedMessage[]
  onWindow?: (window: Window | undefined, callIndex: number) => void
}): HarnessResult {
  const databaseRoot = makeDatabaseRoot()
  const databasePath = getImageTextIndexDatabasePath(databaseRoot, ACCOUNT)
  const state = {
    messages: [...options.messages],
    count: options.messages.length,
    maxLocalId: options.messages.reduce((max, m) => Math.max(max, Number(m.localId) || 0), 0),
    now: ANCHOR_MS
  }
  const windows: Window[] = []
  const findImageFile = vi.fn(() => null)

  const listImageMessages = vi.fn(async (_conversationId: string, window?: Window) => {
    // 只记时间边界：调用方还会带一个分页上限，那与"读了哪个时间窗"无关。
    const bounds: Window = {}
    if (window?.sinceMs !== undefined) bounds.sinceMs = window.sinceMs
    if (window?.beforeMs !== undefined) bounds.beforeMs = window.beforeMs
    windows.push(bounds)
    options.onWindow?.(window, windows.length - 1)
    return state.messages.filter((message) => inWindow(message, window))
  })

  const service = new ImageTextIndexService()
  service.bind({
    databaseRoot,
    resolveAccountId: () => ACCOUNT,
    resolveAccountRoot: () => 'C:/fixture/account',
    now: () => state.now,
    listContacts: async () => [
      { md5: CONVERSATION, m_nsUsrName: 'fixture', type: 'group' as const }
    ],
    listImageMessages,
    // 窗口感知的计数：新架构"这段没图片就整段跳过"完全依赖它说实话。
    countConversationImages: async (_conversationId: string, window?: Window) => ({
      count: state.messages.filter((message) => inWindow(message, window)).length,
      typeColumn: 'local_type'
    }),
    imageWatermark: async () => ({ count: state.count, maxLocalId: state.maxLocalId }),
    // 没有解密能力 → 每张图片都会被判成 image_missing，测试完全不碰真实图片。
    decryptService: () => ({ findImageFile, decryptImage: () => null }) as never,
    capability: async () => ({
      available: true,
      engine: 'windows-system-ocr',
      platform: 'win32',
      runtimeVersion: '1.2.0',
      language: 'zh-Hans-CN'
    }),
    recognize: async () => ({ success: true, text: '', language: 'zh-Hans-CN' })
  })

  return { service, databasePath, state, windows, listImageMessages, findImageFile }
}

const bindingIds = (databasePath: string): string[] => {
  const store = new ImageTextIndexStore(databasePath, ACCOUNT)
  const ids = [...store.getConversationOcr(CONVERSATION).keys()]
  store.close()
  return ids
}

const tierStates = (
  databasePath: string
): Partial<Record<ImageTextBackfillTier, ImageTextTierRunState>> => {
  const store = new ImageTextIndexStore(databasePath, ACCOUNT)
  const result = store.readBackfillState()
  store.close()
  return result.tierStates
}

const runPass = async (
  harness: HarnessResult,
  options?: Parameters<ImageTextIndexService['startPass']>[0]
): Promise<void> => {
  harness.service.startPass(options)
  await vi.waitFor(() => expect(harness.service.isRunning()).toBe(false), { timeout: 15_000 })
}

/** 合成数据集：今天 / 3 天前 / 15 天前 / 6 个月前 / 3 年前，各 10 张。 */
function syntheticDataset(anchorMs: number): {
  messages: chat.FormattedMessage[]
  byBucket: Map<string, number[]>
} {
  const buckets: Array<{ key: string; offsetDays: number }> = [
    { key: 'today', offsetDays: 0 },
    { key: '3d', offsetDays: 3 },
    { key: '15d', offsetDays: 15 },
    { key: '6mo', offsetDays: 183 },
    { key: '3y', offsetDays: 1095 }
  ]
  const messages: chat.FormattedMessage[] = []
  const byBucket = new Map<string, number[]>()
  let localId = 1
  for (const bucket of buckets) {
    const ids: number[] = []
    const baseSeconds = Math.floor((anchorMs - bucket.offsetDays * DAY_MS) / 1000) - 60
    for (let index = 0; index < 10; index += 1) {
      messages.push(imageMessage(localId, baseSeconds + index))
      ids.push(localId)
      localId += 1
    }
    byBucket.set(bucket.key, ids)
  }
  return { messages, byBucket }
}

describe('分段计划：唯一边界、不重不漏', () => {
  it('四段从新到旧、相邻且互不重叠', () => {
    const segments = buildImageTextBackfillSegments(ANCHOR_MS)
    expect(segments.map((segment) => segment.tier)).toEqual([
      'recent_7d',
      'recent_30d',
      'recent_1y',
      'archive'
    ])
    expect(segments[0].endMs).toBe(ANCHOR_MS)
    for (let index = 1; index < segments.length; index += 1) {
      // 上一段的上界必须等于下一段的下界：半开区间才既不重叠也不留缝。
      expect(segments[index].endMs).toBe(segments[index - 1].startMs)
    }
    expect(segments[2].startMs).toBe(
      ANCHOR_MS - IMAGE_TEXT_BACKFILL_WINDOW_DAYS.recent_1y * DAY_MS
    )
    // 归档段没有下界。
    expect(segments[3].startMs).toBe(Number.NEGATIVE_INFINITY)
  })

  it('边界那一秒只属于一段（两端同一套取整）', () => {
    const boundaryMs = ANCHOR_MS - 7 * DAY_MS
    const { beforeSecInclusive } = imageTextWindowToSeconds({ beforeMs: boundaryMs })
    const { sinceSec } = imageTextWindowToSeconds({ sinceMs: boundaryMs })
    // 上界段的"含"到 beforeSecInclusive，下界段从 sinceSec 起 —— 必须正好衔接。
    expect(sinceSec! - beforeSecInclusive!).toBe(1)
  })
})

describe('recent-first：合成数据集的真实处理顺序', () => {
  it('今天 / 3 天 → 15 天 → 6 个月前 → 3 年前，先新后旧', async () => {
    const harness = makeHarness({ messages: [] })
    const { messages, byBucket } = syntheticDataset(ANCHOR_MS)
    harness.state.messages = messages
    harness.state.count = messages.length
    harness.state.maxLocalId = Math.max(...messages.map((m) => Number(m.localId)))

    await runPass(harness)

    // 只有"有图片的分段"才会去读消息：今天+3 天 / 15 天 / 6 个月 / 3 年，共 4 次。
    expect(harness.windows).toHaveLength(4)
    const [first, second, third, fourth] = harness.windows
    expect(first).toEqual({ sinceMs: ANCHOR_MS - 7 * DAY_MS, beforeMs: ANCHOR_MS })
    expect(second).toEqual({ sinceMs: ANCHOR_MS - 30 * DAY_MS, beforeMs: ANCHOR_MS - 7 * DAY_MS })
    expect(third).toEqual({ sinceMs: ANCHOR_MS - 365 * DAY_MS, beforeMs: ANCHOR_MS - 30 * DAY_MS })
    expect(fourth).toEqual({ sinceMs: Number.NEGATIVE_INFINITY, beforeMs: ANCHOR_MS - 365 * DAY_MS })

    // 第一次读就拿到了"最近的图"—— 这正是用户要的价值。
    const ids = bindingIds(harness.databasePath)
    expect(ids).toHaveLength(50)
    const recentIds = [...byBucket.get('today')!, ...byBucket.get('3d')!]
    for (const id of recentIds) expect(ids).toContain(sourceMessageId(imageMessage(id, 0)))
    expect(Math.max(...byBucket.get('today')!)).toBeLessThan(Math.min(...byBucket.get('3y')!))
    for (const id of byBucket.get('3y')!) {
      expect(ids).toContain(sourceMessageId(imageMessage(id, 0)))
    }
  })
})

describe('断点续跑：不重复 OCR', () => {
  it('第一批被预算截断后，重启只补剩下的，已完成的不再走一遍', async () => {
    const harness = makeHarness({ messages: [] })
    const { messages } = syntheticDataset(ANCHOR_MS)
    harness.state.messages = messages
    harness.state.count = messages.length
    harness.state.maxLocalId = Math.max(...messages.map((m) => Number(m.localId)))

    // 第一轮：只允许处理 6 张 → 必然停在"最近图片"这一段中间。
    await runPass(harness, { messageLimit: 6 })
    expect(harness.findImageFile).toHaveBeenCalledTimes(6)
    expect(harness.windows).toHaveLength(1)
    let states = tierStates(harness.databasePath)
    // 该分段没跑完 → 不允许被标成 complete（否则剩下的图永远不会被处理）。
    expect(states.recent_7d).not.toBe('complete')

    // 第二轮：预算放开 → 先把最近这段的剩余 4 张补完，再继续往下。
    await runPass(harness)
    expect(harness.findImageFile).toHaveBeenCalledTimes(50)
    states = tierStates(harness.databasePath)
    expect(states.recent_7d).toBe('complete')
    expect(states.archive).toBe('complete')
    expect(bindingIds(harness.databasePath)).toHaveLength(50)
  })
})

describe('增量优先：历史分段跑着的时候新图片先处理', () => {
  it('新图片在下一次调度点被处理，而不是排到历史之后', async () => {
    let injected = false
    const harness = makeHarness({
      messages: [],
      onWindow: (window) => {
        // 第二轮窗口请求（recent_30d）之后，模拟"用户刚收到一张新图"。
        if (injected || window?.sinceMs === undefined) return
        if (window.beforeMs === ANCHOR_MS - 7 * DAY_MS) {
          injected = true
          harness.state.messages = [
            ...harness.state.messages,
            imageMessage(999, Math.floor((ANCHOR_MS + 5_000) / 1000))
          ]
          harness.state.count += 1
          harness.state.maxLocalId = 999
          harness.state.now = ANCHOR_MS + 5_000
        }
      }
    })
    const { messages } = syntheticDataset(ANCHOR_MS)
    harness.state.messages = messages
    harness.state.count = messages.length
    harness.state.maxLocalId = Math.max(...messages.map((m) => Number(m.localId)))

    await runPass(harness)

    const newMessageId = sourceMessageId(imageMessage(999, 0))
    expect(bindingIds(harness.databasePath)).toContain(newMessageId)
    /**
     * 新图片必须在"更老的分段"之前被处理。
     *
     * 增量补齐对"插入序涨了"的会话是**不设时间窗**读取的（这样才接得住晚到的旧时间消息），
     * 所以这里找的是"没有任何时间边界的那个窗口"，它必须早于 1 年 / 归档分段。
     */
    const sweepWindowIndex = harness.windows.findIndex(
      (window) => window.sinceMs === undefined && window.beforeMs === undefined
    )
    const yearWindowIndex = harness.windows.findIndex(
      (window) => window?.beforeMs === ANCHOR_MS - 30 * DAY_MS
    )
    expect(sweepWindowIndex).toBeGreaterThanOrEqual(0)
    expect(yearWindowIndex).toBeGreaterThan(sweepWindowIndex)
  })
})

describe('兼容性：老索引不被降级，源侧有新增必须补上', () => {
  it('老版本已经全量建完且源侧无变化 → 保持完成，一个字都不读', async () => {
    const harness = makeHarness({ messages: [] })
    // 造一份"旧版本建完"的库：总数 3、三条 binding 全部 terminal、没有任何分段元数据。
    const store = new ImageTextIndexStore(harness.databasePath, ACCOUNT)
    store.writeCountedTotal({ total: 3, countedAt: ANCHOR_MS - 1000, complete: true })
    // 旧版本每跑完一个会话都会留下 scan_state —— 升级后正是靠它证明源侧没动过。
    store.writeScanState({
      conversationId: CONVERSATION,
      state: 'done',
      imageTotal: 3,
      imageProcessed: 3,
      maxLocalId: 3
    })
    for (let index = 1; index <= 3; index += 1) {
      store.putBinding({
        accountId: ACCOUNT,
        conversationId: CONVERSATION,
        messageId: `local:${index}`,
        createTime: ANCHOR_MS - 1000,
        imageIdentity: `sha256:${index}`,
        artifactKey: `sha256:${index}|legacy`,
        state: 'indexed',
        updatedAt: 1
      })
    }
    store.close()

    harness.state.messages = [imageMessage(1, 1000), imageMessage(2, 2000), imageMessage(3, 3000)]
    harness.state.count = 3
    harness.state.maxLocalId = 3

    await runPass(harness)

    // 源侧水位一致 → 一个字都不该读：用户已经拥有的东西不能被降级成"重新建立"。
    expect(harness.listImageMessages).not.toHaveBeenCalled()
    expect(harness.findImageFile).not.toHaveBeenCalled()
    const states = tierStates(harness.databasePath)
    expect(states.recent_7d).toBe('complete')
    expect(states.archive).toBe('complete')
  })

  it('老版本自称"已建完"但源侧已新增 → 必须补上新增，不能信库里的进度', async () => {
    const harness = makeHarness({ messages: [] })
    const store = new ImageTextIndexStore(harness.databasePath, ACCOUNT)
    // 库里自称 2/2 已完成（旧版本跑完时的状态）。
    store.writeCountedTotal({ total: 2, countedAt: ANCHOR_MS - 1000, complete: true })
    for (const localId of [1, 2]) {
      store.writeScanState({
        conversationId: CONVERSATION,
        state: 'done',
        imageTotal: 2,
        imageProcessed: 2,
        maxLocalId: 2
      })
      store.putBinding({
        accountId: ACCOUNT,
        conversationId: CONVERSATION,
        messageId: `local:${localId}`,
        createTime: ANCHOR_MS - 1000,
        imageIdentity: `sha256:old-${localId}`,
        artifactKey: `sha256:old-${localId}|legacy`,
        state: 'indexed',
        updatedAt: 1
      })
    }
    store.close()

    // 源侧现在是 3 张（插入序 1..3）—— 只看库里自称的进度会把它误判成"已完成"。
    harness.state.messages = [imageMessage(1, 1000), imageMessage(2, 2000), imageMessage(3, 3000)]
    harness.state.count = 3
    harness.state.maxLocalId = 3

    await runPass(harness)

    const ids = bindingIds(harness.databasePath)
    expect(ids).toHaveLength(3)
    expect(ids).toContain(sourceMessageId(imageMessage(3, 3000)))
    // 老的 terminal 结果必须被复用，不能重新 OCR。
    expect(harness.findImageFile).toHaveBeenCalledTimes(1)
  })
})

describe('时间范围覆盖度', () => {
  const coverageOf = (input: Partial<ImageTextIndexCoverage>): ImageTextIndexCoverage => ({
    totalImageMessages: 100,
    processed: 20,
    indexed: 18,
    empty: 2,
    missing: 0,
    failed: 0,
    runtimeUnavailable: 0,
    pending: 80,
    established: true,
    complete: false,
    systemicFailure: false,
    countedAt: ANCHOR_MS,
    tiers: [
      { tier: 'recent_7d', state: 'complete', startMs: ANCHOR_MS - 7 * DAY_MS, endMs: ANCHOR_MS },
      {
        tier: 'recent_30d',
        state: 'pending',
        startMs: ANCHOR_MS - 30 * DAY_MS,
        endMs: ANCHOR_MS - 7 * DAY_MS
      },
      {
        tier: 'recent_1y',
        state: 'pending',
        startMs: ANCHOR_MS - 365 * DAY_MS,
        endMs: ANCHOR_MS - 30 * DAY_MS
      },
      {
        tier: 'archive',
        state: 'pending',
        startMs: Number.NEGATIVE_INFINITY,
        endMs: ANCHOR_MS - 365 * DAY_MS
      }
    ],
    coveredToMs: ANCHOR_MS,
    ...input
  })

  it('A. 最近 7 天已完成 → 查询最近 24h 可以下确定性结论', () => {
    const coverage = coverageOf({})
    const range = { sinceMs: ANCHOR_MS - DAY_MS, beforeMs: ANCHOR_MS }
    const result = imageTextRangeCoverage(coverage, range)
    expect(result.state).toBe('complete')
    expect(result.hasUncovered).toBe(false)
    expect(describeImageTextRangeCoverage(coverage, range)).toContain('已覆盖该时间范围')
  })

  it('B. 更早历史未完成 → 全历史查询只能是 partial，并明确"不能排除尚未索引的图片"', () => {
    const coverage = coverageOf({})
    expect(imageTextRangeCoverage(coverage, {}).state).toBe('partial')
    expect(describeImageTextRangeCoverage(coverage, {})).toContain('不能排除尚未索引的图片')
  })

  it('C. 全部完成 → 任意范围都是 complete', () => {
    const coverage = coverageOf({
      processed: 100,
      indexed: 98,
      empty: 2,
      pending: 0,
      complete: true,
      tiers: coverageOf({}).tiers.map((entry) => ({ ...entry, state: 'complete' as const }))
    })
    expect(imageTextRangeCoverage(coverage, {}).state).toBe('complete')
    expect(
      imageTextRangeCoverage(coverage, { sinceMs: ANCHOR_MS - 900 * DAY_MS }).state
    ).toBe('complete')
  })

  it('D. 在更老的历史里被取消 → 最近一段仍可完整，全历史仍是 partial', () => {
    const coverage = coverageOf({})
    expect(
      imageTextRangeCoverage(coverage, {
        sinceMs: ANCHOR_MS - 3 * DAY_MS,
        beforeMs: ANCHOR_MS
      }).state
    ).toBe('complete')
    expect(imageTextRangeCoverage(coverage, {}).state).toBe('partial')
  })

  it('未建立时不得声称任何范围完整', () => {
    const coverage = coverageOf({ established: false, tiers: [], coveredToMs: null })
    expect(imageTextRangeCoverage(coverage, { sinceMs: ANCHOR_MS - DAY_MS }).state).toBe(
      'not_built'
    )
  })
})

describe('UI 文案与进度', () => {
  it('阶段文案是用户语言，不出现工程术语', () => {
    expect(imageTextPhaseLabel('recent_7d')).toBe('正在优先索引最近图片')
    expect(imageTextPhaseLabel('incremental')).toBe('正在优先索引最近图片')
    expect(imageTextPhaseLabel('recent_30d')).toBe('正在补齐最近 30 天')
    expect(imageTextPhaseLabel('recent_1y')).toBe('正在补齐近一年图片')
    expect(imageTextPhaseLabel('archive')).toBe('正在补齐更早图片')
    expect(imageTextPhaseLabel('complete')).toBe('图片文字索引已完成')
    const phases = ['incremental', 'recent_7d', 'recent_30d', 'recent_1y', 'archive', 'complete'] as const
    for (const phase of phases) {
      expect(imageTextPhaseLabel(phase)).not.toMatch(/Tier/i)
    }
  })

  it('阶段字段在运行中出现，且总进度仍以全量图片数为分母', async () => {
    const harness = makeHarness({ messages: [] })
    const { messages } = syntheticDataset(ANCHOR_MS)
    harness.state.messages = messages
    harness.state.count = messages.length
    harness.state.maxLocalId = Math.max(...messages.map((m) => Number(m.localId)))

    await runPass(harness, { messageLimit: 3 })
    const status = await harness.service.getStatus()
    // 总分母必须是全部图片消息，而不是"这一段处理了多少"。
    expect(status.progress.totalImageMessages).toBe(50)
    expect(status.progress.processed).toBeGreaterThan(0)
    expect(status.progress.percent).toBeLessThan(100)
    expect(status.coverage.tiers.map((entry) => entry.tier)).toEqual([
      'recent_7d',
      'recent_30d',
      'recent_1y',
      'archive'
    ])
  })
})
