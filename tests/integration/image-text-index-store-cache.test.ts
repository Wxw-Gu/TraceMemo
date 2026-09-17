/**
 * 派生库句柄的**账号身份缓存契约**。
 *
 * `resolveAccountId()` 不是廉价 getter：main 把它绑定成同步 WCDB 查询。
 * 而 `ensureStore()` 在图片处理热路径上会被每张图片调用多次，所以身份解析
 * **必须**只发生常数次；否则它就成了每张图片的固定成本，且完全不随 OCR 并发改善。
 *
 * 这一组用例把契约钉住：
 *   1. 身份解析只发生常数次（不是每张图片一次）；
 *   2. 解析本身再慢，也只能让整遍多付一次；
 *   3. 切账号仍然换库 —— `resetAccount()` 是权威的失效信号；
 *   4. 解析失败（空结果）不被永久缓存；
 *   5. 进入流水线之前的一次性成本不算进单张净耗时。
 */
import { existsSync, mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as chat from '../../src/main/services/chat-service'
import { ImageTextIndexService } from '../../src/main/services/image-text-index-service'
import { getImageTextIndexDatabasePath } from '../../src/main/services/image-text-index-store'

const ACCOUNT = 'wxid_store_cache_fixture'
const IMAGES = 24
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 同步阻塞：模拟同步 WCDB 查询（不是 await，是实打实占住主线程）。 */
function blockFor(ms: number): void {
  const end = Date.now() + ms
  while (Date.now() < end) {
    /* busy */
  }
}

/** 合法 PNG 头 + 唯一尾部：不同 seed → 不同内容身份（sha256）。 */
function pngBytes(seed: number): Buffer {
  return Buffer.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    seed & 0xff,
    (seed >> 8) & 0xff
  ])
}

function imageMessage(localId: number): chat.FormattedMessage {
  return {
    id: String(localId),
    localId: String(localId),
    from: 'user',
    type: '图片',
    content: '',
    isSender: false,
    name: '对方',
    contentData: { type: 'image', md5: `md5-${localId}`, datName: `dat-${localId}` },
    createTime: 1_700_000_000 + localId
  } as unknown as chat.FormattedMessage
}

const seedFromPath = (path: string): number => Number(/(\d+)\.dat$/.exec(String(path))?.[1] ?? 1)

interface Harness {
  service: ImageTextIndexService
  databaseRoot: string
  /** 切换当前会话：让下一遍不被 checkpoint 跳过，用来验证"换库后重新处理"。 */
  setConversation: (conversationId: string) => void
  bindingCount: (accountId: string) => number
}

function createHarness(options: {
  resolveAccountId: () => string
  /** 注入到"每个会话一次"的前置路径上（countConversationImages / listMessages）。 */
  preLoopDelayMs?: number
  /** 注入到会话完成后的 Knowledge 重建回调（属于别的模块的成本）。 */
  onConversationIndexedDelayMs?: number
  /** OCR 返回的文字；空串 = 识别成"没有文字"（非可搜索结果）。 */
  recognizeText?: string
  ocrMs?: number
}): Harness {
  const databaseRoot = mkdtempSync(join(tmpdir(), 'tm-store-cache-'))
  roots.push(databaseRoot)
  const messages = Array.from({ length: IMAGES }, (_, index) => imageMessage(index + 1))
  let conversation = 'conv-initial'

  const service = new ImageTextIndexService()
  service.bind({
    databaseRoot,
    progressNotifyIntervalMs: 0,
    resolveAccountId: options.resolveAccountId,
    ocrConcurrency: 1,
    listContacts: async () => [
      { md5: conversation, m_nsUsrName: conversation, type: 'user' as const }
    ],
    countConversationImages: async () => {
      if (options.preLoopDelayMs) await sleep(options.preLoopDelayMs)
      return { count: messages.length, typeColumn: 'local_type' }
    },
    imageWatermark: async () => ({ count: messages.length, maxLocalId: messages.length }),
    listMessages: async () => {
      if (options.preLoopDelayMs) await sleep(options.preLoopDelayMs)
      return messages
    },
    capability: async () => ({
      available: true,
      engine: 'macos-system-ocr',
      platform: 'darwin',
      runtimeVersion: '1.2.0',
      language: null
    }),
    decryptService: () =>
      ({
        findImageFile: (md5: string) => `C:/fake/${md5}.dat`,
        decryptImage: (path: string) => pngBytes(seedFromPath(path))
      }) as never,
    recognize: async () => {
      if (options.ocrMs) await sleep(options.ocrMs)
      return { success: true, text: options.recognizeText ?? 'TEXT', language: null }
    },
    onConversationIndexed: async () => {
      if (options.onConversationIndexedDelayMs) await sleep(options.onConversationIndexedDelayMs)
    }
  })

  return {
    service,
    databaseRoot,
    setConversation: (conversationId) => {
      conversation = conversationId
    },
    bindingCount: (accountId) => {
      const path = getImageTextIndexDatabasePath(databaseRoot, accountId)
      if (!existsSync(path)) return 0
      const db = new DatabaseSync(path)
      try {
        const row = db.prepare('SELECT COUNT(*) AS n FROM image_ocr_bindings').get() as {
          n: number
        }
        return Number(row?.n ?? 0)
      } finally {
        db.close()
      }
    }
  }
}

const runPass = async (
  service: ImageTextIndexService,
  options: { sinceMs?: number } = {}
): Promise<void> => {
  await service.startPass(options)
  await vi.waitFor(() => expect(service.isRunning()).toBe(false), { timeout: 60_000 })
}

describe('派生库句柄的账号身份缓存', () => {
  it('caches account identity until reset', async () => {
    let resolveCalls = 0
    const h = createHarness({
      resolveAccountId: () => {
        resolveCalls += 1
        blockFor(30)
        return ACCOUNT
      },
      ocrMs: 5
    })

    await runPass(h.service)

    expect((await h.service.getStatus()).progress.processed).toBe(IMAGES)
    console.log(`[store-cache] 张数=${IMAGES} resolveAccountId 调用=${resolveCalls}`)
    // 每张图片都要重新解析的话，这里会是 2 × IMAGES 的量级。
    expect(resolveCalls).toBeLessThanOrEqual(3)

    h.service.resetAccount()
  })

  it('identity resolution cost is paid once per pass, not per image', async () => {
    const RESOLVE_MS = 30
    const OCR_MS = 5
    const slow = createHarness({
      resolveAccountId: () => {
        blockFor(RESOLVE_MS)
        return ACCOUNT
      },
      ocrMs: OCR_MS
    })
    const fast = createHarness({ resolveAccountId: () => ACCOUNT, ocrMs: OCR_MS })

    await runPass(fast.service)
    await runPass(slow.service)

    const fastPerImage = (await fast.service.getStatus()).stageTimings?.perImageMs ?? 0
    const slowPerImage = (await slow.service.getStatus()).stageTimings?.perImageMs ?? 0

    /**
     * 用**差值**断言而不是绝对阈值，避免锁住某台机器的速度：
     * 身份解析变慢 30ms，若只付一次，单张净耗时最多只涨这一点点；
     * 若每张都要付（甚至两次），差值会是 30ms 的倍数。
     */
    expect(slowPerImage - fastPerImage).toBeLessThan(RESOLVE_MS + 70)

    fast.service.resetAccount()
    slow.service.resetAccount()
  })

  it('invalidates store cache on reset', async () => {
    let account = 'account-A'
    const h = createHarness({ resolveAccountId: () => account })

    await runPass(h.service)
    expect(h.bindingCount('account-A')).toBe(IMAGES)
    expect(h.bindingCount('account-B')).toBe(0)

    // 切账号：换身份 + 显式失效（main 在全部切换路径上都会这样做）。
    account = 'account-B'
    h.setConversation('conv-B')
    h.service.resetAccount()
    await runPass(h.service)

    expect(h.bindingCount('account-B')).toBe(IMAGES)
    // A 的库不得被继续写入 —— 这就是"切账号必须换句柄"要防的串账号。
    expect(h.bindingCount('account-A')).toBe(IMAGES)

    h.service.resetAccount()
  })

  it('does not cache unresolved account identity', async () => {
    let account = ''
    let resolveCalls = 0
    const h = createHarness({
      resolveAccountId: () => {
        resolveCalls += 1
        return account
      }
    })

    // 微信还没就绪：解析结果为空 → 不建库、也不该把空结果记成"已解析"。
    await runPass(h.service)
    expect((await h.service.getStatus()).progress.state).toBe('error')
    const callsWhileUnresolved = resolveCalls
    expect(callsWhileUnresolved).toBeGreaterThan(0)

    // 数据就绪之后再跑：必须能重新解析出来（空结果没有被永久缓存）。
    account = ACCOUNT
    h.service.resetAccount()
    await runPass(h.service)
    expect((await h.service.getStatus()).progress.processed).toBe(IMAGES)
    expect(resolveCalls).toBeGreaterThan(callsWhileUnresolved)

    h.service.resetAccount()
  })

  it('pre-loop cost is excluded from per-image cost', async () => {
    const PRE_LOOP_MS = 400
    const withPreLoop = createHarness({
      resolveAccountId: () => ACCOUNT,
      preLoopDelayMs: PRE_LOOP_MS,
      ocrMs: 5
    })
    const control = createHarness({ resolveAccountId: () => ACCOUNT, ocrMs: 5 })

    const wallStartedAt = Date.now()
    await runPass(withPreLoop.service)
    const wallMs = Date.now() - wallStartedAt
    await runPass(control.service)

    const status = await withPreLoop.service.getStatus()
    const timings = status.stageTimings
    expect(timings).toBeDefined()
    if (!timings) return
    const processed = status.progress.processed
    expect(processed).toBe(IMAGES)

    const controlPerImage = (await control.service.getStatus()).stageTimings?.perImageMs ?? 0
    console.log(
      `[store-cache] 整遍 wall=${wallMs}ms 整遍/张=${(wallMs / processed).toFixed(1)}ms ` +
        `单张净=${timings.perImageMs}ms（对照 ${controlPerImage}ms）startup=${timings.preLoop.startupMs}ms`
    )

    // 前置成本必须被单独量出来（本用例在 countConversationImages 与 listMessages 各注入一次）。
    expect(timings.preLoop.startupMs).toBeGreaterThanOrEqual(PRE_LOOP_MS * 2 - 100)
    expect(timings.preLoop.countImageMessagesMs).toBeGreaterThanOrEqual(PRE_LOOP_MS - 100)
    expect(timings.preLoop.listMessagesMs).toBeGreaterThanOrEqual(PRE_LOOP_MS - 100)
    // 会话级准备必须覆盖 listMessages，否则"每会话一次"的成本会漏出去。
    expect(timings.preLoop.conversationSetupMs).toBeGreaterThanOrEqual(
      timings.preLoop.listMessagesMs
    )

    /**
     * 单张净耗时**不能**因为前置成本变贵而变贵 —— 用对照实例做差值断言，
     * 这样既锁住了语义，又不会锁住某台机器的速度。
     */
    expect(timings.perImageMs).toBeLessThan(controlPerImage + 60)
    // 反过来，"整遍 ÷ 张数"必然被前置成本抬高 —— 这正是它不能当成单张成本的原因。
    expect(wallMs / processed).toBeGreaterThan(timings.perImageMs * 5)

    withPreLoop.service.resetAccount()
    control.service.resetAccount()
  })
})

/**
 * 会话完成后等待 Knowledge 重建的成本（`onConversationIndexed`）。
 *
 * 这一段是**别的模块**的成本：Knowledge 会对同一个会话再全量读一遍消息并整篇写索引，
 * 而且如果此时有索引在跑还会先等它。它不在 batch 循环里。
 *
 * 这一组锁两件容易同时搞砸的事：
 *   1. 它必须被**单独量出来**（否则"单张很快、整遍很慢"无从归因）；
 *   2. 它**不能**被算进单张净耗时（否则单张数字会被别的模块污染）。
 */
describe('会话级 Knowledge 重建成本的归因', () => {
  it('attributes the Knowledge callback to preLoop, not to per-image cost', async () => {
    const INDEXED_MS = 300
    const slow = createHarness({
      resolveAccountId: () => ACCOUNT,
      onConversationIndexedDelayMs: INDEXED_MS,
      ocrMs: 5
    })
    const control = createHarness({ resolveAccountId: () => ACCOUNT, ocrMs: 5 })

    await runPass(control.service)
    await runPass(slow.service)

    const timings = (await slow.service.getStatus()).stageTimings
    expect(timings).toBeDefined()
    if (!timings) return
    const controlPerImage = (await control.service.getStatus()).stageTimings?.perImageMs ?? 0

    // 必须被单独量出来：本用例只跑了一个会话，回调延迟应完整落在该桶里。
    expect(timings.preLoop.onConversationIndexedMs).toBeGreaterThanOrEqual(INDEXED_MS - 60)
    console.log(
      `[store-cache] onConversationIndexedMs=${timings.preLoop.onConversationIndexedMs}ms ` +
        `单张净=${timings.perImageMs}ms（对照 ${controlPerImage}ms）`
    )

    /**
     * 用差值断言：回调再慢，单张净耗时也不该跟着涨。
     * 若有人把这段并进 `perImageMs`，这里会立刻红 —— 那正是"图片索引变慢"被误判成
     * "OCR 变慢"的起因。
     */
    expect(timings.perImageMs).toBeLessThan(controlPerImage + 60)

    slow.service.resetAccount()
    control.service.resetAccount()
  })
})

/**
 * 可观测性契约：**慢步骤必须自己说出"卡在哪一步"**。
 *
 * 背景：实测出现过"一次运行 81 分钟零落库"。没有这条日志时只能看到"没有进度"，
 * 无法区分"自己慢"和"被别的模块按住" —— 而这两者的修法完全不同。
 */
describe('慢步骤告警', () => {
  it('reports which step is blocking when it exceeds the threshold', async () => {
    const h = createHarness({
      resolveAccountId: () => ACCOUNT,
      onConversationIndexedDelayMs: 400
    })
    // 自己接管这一步：先证明它真的被调用了，再断言告警。
    const indexed = vi.fn(async () => {
      await sleep(400)
    })
    h.service.bind({ onConversationIndexed: indexed, slowStepWarnMs: 100 })

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await runPass(h.service)
      // 前提：这一步确实被调用了 —— 否则下面找不到告警的原因是错的。
      expect(indexed).toHaveBeenCalled()

      const lines = warn.mock.calls
        .map((call) => String(call[0] ?? ''))
        .filter((message) => message.includes('[ImageTextIndex] slow step='))

      // 必须报出被按住的那一步，并且带耗时。
      expect(lines.find((line) => line.includes('knowledge-index'))).toBeDefined()
      expect(lines.some((line) => /elapsedMs=\d+/.test(line))).toBe(true)
      // 只报步骤名与耗时，不得出现会话标识 / 内容。
      expect(lines.join(' ')).not.toContain('conv-initial')
    } finally {
      warn.mockRestore()
    }

    h.service.resetAccount()
  })

  it('stays quiet when every step is fast', async () => {
    const h = createHarness({ resolveAccountId: () => ACCOUNT, ocrMs: 1 })
    h.service.bind({ slowStepWarnMs: 100_000 })

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await runPass(h.service)
      expect(
        warn.mock.calls
          .map((call) => String(call[0] ?? ''))
          .filter((message) => message.includes('slow step='))
      ).toEqual([])
    } finally {
      warn.mockRestore()
    }

    h.service.resetAccount()
  })
})

/**
 * 画像触发的时间兜底。
 *
 * 只按处理量触发时，吞吐掉到个位数会让画像十几分钟才出一条 ——
 * 而那正是最需要画像的时刻。
 */
describe('画像的时间兜底触发', () => {
  it('emits a profile after the idle window even when the image count is far below the interval', async () => {
    const h = createHarness({ resolveAccountId: () => ACCOUNT, ocrMs: 30 })
    const profiles: unknown[] = []
    h.service.bind({
      logStageProfile: (profile) => profiles.push(profile),
      // 张数阈值仍是 500（默认），本用例只有 IMAGES 张 ⇒ 只能靠时间触发。
      stageProfileMaxIdleMs: 1
    })

    await runPass(h.service)

    expect(IMAGES).toBeLessThan(500)
    expect(profiles.length).toBeGreaterThan(0)

    h.service.resetAccount()
  })
})

/**
 * Knowledge 重建的门控：**没有可搜索内容变化就不要叫醒它。**
 *
 * 为什么这是硬要求：Knowledge 侧是"读整个会话 → 重分片整会话"，代价与消息数成正比，
 * 而且这一步在 `await` 路径上。图片索引走过的大多数会话里，被识别的图片要么没有文字、
 * 要么图片文件已被清理 —— 那些结果不改变可搜索内容，重建纯属白做，却会把索引按住十几秒。
 *
 * 这一组锁三件事：
 *   1. 全部结果都不可搜索（无文字 / 图片缺失）⇒ **不调用** Knowledge；
 *   2. 只要有**一条**识别出文字 ⇒ 必须调用（可搜索内容变了）；
 *   3. **已知终态直接跳过**的图片不得让会话被判成 dirty（用户明确要求的那条）。
 */
describe('Knowledge 重建门控', () => {
  const runOnceWith = async (options: {
    recognizeText?: string
  }): Promise<{ indexed: ReturnType<typeof vi.fn>; skipped: number }> => {
    const h = createHarness({
      resolveAccountId: () => ACCOUNT,
      ocrMs: 1,
      ...(options.recognizeText === undefined ? {} : { recognizeText: options.recognizeText })
    })
    const indexed = vi.fn(async () => undefined)
    h.service.bind({ onConversationIndexed: indexed })

    await runPass(h.service)
    const timings = (await h.service.getStatus()).stageTimings
    h.service.resetAccount()
    return { indexed, skipped: timings?.knowledgeIndexSkipped ?? -1 }
  }

  it('all non-searchable results → Knowledge is not woken up', async () => {
    const { indexed, skipped } = await runOnceWith({ recognizeText: '' })

    expect(indexed).not.toHaveBeenCalled()
    expect(skipped).toBe(1)
  })

  it('a single searchable result → Knowledge must be rebuilt', async () => {
    const { indexed, skipped } = await runOnceWith({ recognizeText: '识别出来的文字' })

    expect(indexed).toHaveBeenCalledTimes(1)
    expect(skipped).toBe(0)
  })

  it('images skipped as already-terminal do not mark the conversation dirty', async () => {
    const h = createHarness({ resolveAccountId: () => ACCOUNT, ocrMs: 1 })
    const indexed = vi.fn(async () => undefined)
    h.service.bind({ onConversationIndexed: indexed })

    // 第一遍：正常识别出文字 ⇒ 会调用一次。
    await runPass(h.service)
    expect(indexed).toHaveBeenCalledTimes(1)

    /**
     * 第二遍带时间窗 ⇒ **刻意绕过 checkpoint 跳过**（窗口模式下不做增量跳过），
     * 这样才会真的进到"逐张检查"这一步：所有图片都已是终态 ⇒ `fill()` 直接短路、
     * 不调 `settle()` ⇒ 会话不得被判成 dirty ⇒ 不得再叫 Knowledge。
     *
     * 若不带窗口，整个会话会被 checkpoint 整体跳过 —— 那也安全，但测不到这条规则。
     */
    await runPass(h.service, { sinceMs: 1 })
    expect(indexed).toHaveBeenCalledTimes(1)

    const timings = (await h.service.getStatus()).stageTimings
    expect(timings?.knowledgeIndexSkipped).toBeGreaterThanOrEqual(1)

    h.service.resetAccount()
  })
})

/**
 * 「可搜索 → 不可搜索」是否可能**经由 settle()** 发生。
 *
 * 为什么必须证明它：dirty 判定是 `state === 'indexed' && text.trim()`。
 * 如果存在一条路径能让一条**原本有 OCR 文字**的消息重新进 settle() 并落成
 * empty / image_missing / 空文字，那么旧的可搜索文字就会留在 Knowledge 里 —— 搜索能搜到、
 * 但索引已经"没有"那段文字，属于静默的 stale 结果。
 *
 * 结论：**不可达**。依据是全量穷举写入/删除面（见下两条用例）。
 */
describe('dirty 判定的安全边界', () => {
  it('an already-indexed message never re-enters settle() on a later pass', async () => {
    const h = createHarness({ resolveAccountId: () => ACCOUNT, ocrMs: 1 })
    const recognize = vi.fn(async () => ({ success: true, text: '识别出来的文字', language: null }))
    h.service.bind({ recognize })

    await runPass(h.service)
    const firstCalls = recognize.mock.calls.length
    expect(firstCalls).toBeGreaterThan(0)

    // 带时间窗 ⇒ 绕过 checkpoint 跳过，逼它逐张检查（否则整个会话被 skip，测不到这条规则）。
    await runPass(h.service, { sinceMs: 1 })

    /**
     * 关键断言：第二遍**一次 OCR 都不该发生**。
     * 只要 binding 是 `indexed`（终态）就会被 `fill()` 短路 —— 短路即不 settle，
     * 也就不可能把"有文字"改写成"没有文字"。
     */
    expect(recognize.mock.calls.length).toBe(firstCalls)

    h.service.resetAccount()
  })

  it('resetRetriableFailures leaves searchable results untouched', async () => {
    const h = createHarness({ resolveAccountId: () => ACCOUNT, ocrMs: 1 })
    await runPass(h.service)

    const before = (await h.service.getStatus()).coverage
    // 本用例识别出的全是"有文字"，所以 indexed === 全部绑定。
    expect(before.indexed).toBe(IMAGES)
    expect(before.failed).toBe(0)

    /**
     * 走生产路径复位失败记录（「修复图片搜索索引」用的就是它）。
     * 它按**可重试失败状态**删除；`indexed` 不在那个集合里 ⇒ 一条都不会被删。
     * 只要 binding 还在且是终态，那条消息就永远不会重新进 `settle()`。
     */
    const reset = await h.service.resetRetriableFailures()
    expect(reset.reset).toBe(0)

    const after = (await h.service.getStatus()).coverage
    expect(after.indexed).toBe(IMAGES)
    expect(after.processed).toBe(before.processed)

    h.service.resetAccount()
  })
})
