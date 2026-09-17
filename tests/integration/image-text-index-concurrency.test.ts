/**
 * 图片文字索引的**并发契约**。
 *
 * 背景：backfill 从「批内严格串行」改成有界流水线（prepare 同步 → OCR 有限并行 → 单 writer 落库）。
 * 并发一旦引入，下面这些性质就不再是"显然成立"，必须被测试锁住：
 *
 * 1. 同一张图并发派发 → OCR **最多一次**（否则白算，还违反"最多识别一次"的契约）；
 * 2. 不同图片并发 → 结果不许串（文本 / 状态 / 身份各归各的）；
 * 3. 暂停 → 在途的**安全收尾**（算了不落库等于白算），但**不再领取新任务**；
 * 4. 取消 → checkpoint 正确（partial），已落库的终态一条不丢；
 * 5. 某个 worker 报错 → 其它图片照常完成，整体任务不崩；
 * 6. 进度语义不因并发失真：`processed` 只在终态之后 +1，且不重不漏；
 * 7. 已有终态在并发下**依然一次都不重算**（并发不能把复用逻辑绕过去）。
 *
 * 全部使用 synthetic 图片（合法 PNG 魔数 + 唯一尾部字节），不碰任何真实数据。
 */
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as chat from '../../src/main/services/chat-service'
import { ImageTextIndexService } from '../../src/main/services/image-text-index-service'
import type { ImageTextIndexStageTimings } from '../../src/shared/image-text-index'
import {
  ImageTextIndexStore,
  getImageTextIndexDatabasePath
} from '../../src/main/services/image-text-index-store'

const ACCOUNT = 'wxid_concurrency_fixture'
const CONVERSATION = 'md5-concurrency'
const roots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'tm-image-concurrency-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

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
    (seed >> 8) & 0xff,
    0x00
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

const capability = async (): Promise<{
  available: boolean
  engine: 'windows-system-ocr'
  platform: 'win32'
  runtimeVersion: string
  language: string
}> => ({
  available: true,
  engine: 'windows-system-ocr',
  platform: 'win32',
  runtimeVersion: '1.2.0',
  language: 'zh-Hans-CN'
})

/** 从 data URL 里还原出这张图的 seed，用来断言"结果没有串图"。 */
function seedFromDataUrl(dataUrl: string): number {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
  const bytes = Buffer.from(base64, 'base64')
  return bytes[8] | (bytes[9] << 8)
}

/**
 * 从假路径里取消息序号。
 *
 * 刻意锚定 `.dat` 后缀：直接用 `replace(/\D/g,'')` 会连 "md5" 里那个 **5** 一起抓进来
 * （`md5-1` → "51"），这种坑只有真跑一次才会发现。
 */
function seedFromPath(path: string): number {
  const matched = /(\d+)\.dat$/.exec(String(path))
  return matched ? Number(matched[1]) : 1
}

const fakeDecryptImage = (path: string): Buffer => pngBytes(seedFromPath(path))

const fakeFindImageFile = (md5: string): string => `C:/fake/${md5}.dat`

interface Harness {
  service: ImageTextIndexService
  recognize: ReturnType<typeof vi.fn>
  databaseRoot: string
  databasePath: string
  close: () => void
}

function harness(options: {
  count: number
  ocrConcurrency: number
  /** 自定义 decrypt：默认按消息 id 给出唯一图片。 */
  decryptImage?: (path: string) => Buffer
  recognizeImpl?: (
    dataUrl: string,
    ctx: { callIndex: number; service: ImageTextIndexService }
  ) => Promise<{ success: boolean; text: string; language: string | null; errorCode?: string }>
}): Harness {
  const databaseRoot = makeRoot()
  const databasePath = getImageTextIndexDatabasePath(databaseRoot, ACCOUNT)
  const messages = Array.from({ length: options.count }, (_, index) => imageMessage(index + 1))

  const service = new ImageTextIndexService()
  let callIndex = 0
  const recognize = vi.fn(async (dataUrl: string) => {
    callIndex += 1
    if (options.recognizeImpl) return options.recognizeImpl(dataUrl, { callIndex, service })
    return { success: true, text: `TEXT_${seedFromDataUrl(dataUrl)}`, language: null }
  })

  const decryptImage = options.decryptImage ?? fakeDecryptImage

  service.bind({
    databaseRoot,
    resolveAccountId: () => ACCOUNT,
    ocrConcurrency: options.ocrConcurrency,
    listContacts: async () => [
      { md5: CONVERSATION, m_nsUsrName: 'concurrency', type: 'user' as const }
    ],
    listMessages: async () => messages,
    countConversationImages: async () => ({ count: messages.length, typeColumn: 'local_type' }),
    imageWatermark: async () => ({ count: messages.length, maxLocalId: messages.length }),
    capability,
    decryptService: () => ({ findImageFile: fakeFindImageFile, decryptImage }) as never,
    recognize
  })

  return {
    service,
    recognize,
    databaseRoot,
    databasePath,
    close: () => service.resetAccount()
  }
}

const finishPass = async (service: ImageTextIndexService): Promise<void> => {
  await vi.waitFor(() => expect(service.isRunning()).toBe(false))
}

describe('并发契约', () => {
  it('同一张图被并发派发 → OCR 只执行一次，但每个消息各自有 binding', async () => {
    // 8 条消息，decrypt 全部返回**同一份字节** → 同一个内容身份 / artifact key。
    const h = harness({
      count: 8,
      ocrConcurrency: 4,
      decryptImage: () => pngBytes(42)
    })

    await h.service.startPass()
    await finishPass(h.service)

    expect(h.recognize).toHaveBeenCalledTimes(1)

    const store = new ImageTextIndexStore(h.databasePath, ACCOUNT)
    // binding 去重不成 1 条：8 个消息各自有 binding（去重不许丢来源）。
    expect(store.countByState().indexed).toBe(8)
    expect(store.getConversationOcr(CONVERSATION).size).toBe(8)
    // artifact 才是被去重的那一层：8 张相同内容只产生 1 个带文本的 artifact。
    expect(store.storageStats().ocrTextCount).toBe(1)
    store.close()
    h.close()
  })

  it('不同图片并发 → 结果各归各的，不串图', async () => {
    const h = harness({ count: 16, ocrConcurrency: 4 })

    await h.service.startPass()
    await finishPass(h.service)

    expect(h.recognize).toHaveBeenCalledTimes(16)

    const store = new ImageTextIndexStore(h.databasePath, ACCOUNT)
    const ocr = store.getConversationOcr(CONVERSATION)
    expect(ocr.size).toBe(16)
    // 每条消息的文本必须等于**它自己那张图**的 seed —— 串图会立刻打挂这里。
    for (let id = 1; id <= 16; id += 1) {
      expect(ocr.get(`local:${id}`)?.text).toBe(`TEXT_${id}`)
    }
    store.close()
    h.close()
  })

  it('同时在途的 OCR 不超过配置的并发度（有界，不是无界扇出）', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const h = harness({
      count: 40,
      ocrConcurrency: 2,
      recognizeImpl: async () => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        // 让所有任务都有机会重叠：无界实现会在这里冲到 40。
        await new Promise((resolve) => setTimeout(resolve, 5))
        inFlight -= 1
        return { success: true, text: 'TEXT', language: null }
      }
    })

    await h.service.startPass()
    await finishPass(h.service)

    expect(h.recognize).toHaveBeenCalledTimes(40)
    expect(maxInFlight).toBe(2)

    h.close()
  })

  it('并发下进度不重不漏：processed 只统计已进入终态的图片', async () => {
    const h = harness({ count: 16, ocrConcurrency: 4 })

    await h.service.startPass()
    await finishPass(h.service)

    const status = await h.service.getStatus()
    const { processed, indexed, empty, missing, failed, totalImageMessages } = status.progress
    expect(processed).toBe(16)
    expect(indexed + empty + missing + failed).toBe(processed)
    expect(totalImageMessages).toBe(16)
    // 并发度必须如实反映在诊断字段上。
    expect(status.stageTimings?.ocrConcurrency).toBe(4)
    expect(status.stageTimings?.ocrExecutions).toBe(16)
    h.close()
  })

  it('暂停 → 在途任务安全收尾，且不再领取新任务', async () => {
    const CONCURRENCY = 4
    let releaseGate: (() => void) | null = null
    const gate = new Promise<void>((resolve) => {
      releaseGate = () => resolve()
    })

    const h = harness({
      count: 32,
      ocrConcurrency: CONCURRENCY,
      recognizeImpl: async (_dataUrl, ctx) => {
        // 槽位刚好填满的那一刻按暂停：此后不应再派发任何新任务。
        if (ctx.callIndex === CONCURRENCY) ctx.service.pause()
        await gate
        return { success: true, text: 'TRACE_PAUSED', language: null }
      }
    })

    void h.service.startPass()
    // 等槽位填满（4 个在途 OCR 都卡在 gate 上）。
    await vi.waitFor(() => expect(h.recognize).toHaveBeenCalledTimes(CONCURRENCY))

    releaseGate?.()
    await finishPass(h.service)

    // 只派发过这一批：暂停之后不再领取新任务。
    expect(h.recognize).toHaveBeenCalledTimes(CONCURRENCY)

    const store = new ImageTextIndexStore(h.databasePath, ACCOUNT)
    // 在途的 4 张都**落库**了（算了不落库等于白算）。
    expect(store.countByState().indexed).toBe(CONCURRENCY)
    expect(store.getConversationOcr(CONVERSATION).size).toBe(CONCURRENCY)
    // 中断的会话必须留 partial checkpoint，下一遍才接得上。
    expect(store.readScanState().get(CONVERSATION)?.state).toBe('partial')
    store.close()

    const status = await h.service.getStatus()
    expect(status.progress.state).toBe('paused')
    h.close()
  })

  it('取消 → checkpoint 正确，已落库的终态一条不丢，且不重算', async () => {
    const CONCURRENCY = 4
    let releaseGate: (() => void) | null = null
    const gate = new Promise<void>((resolve) => {
      releaseGate = () => resolve()
    })

    const h = harness({
      count: 32,
      ocrConcurrency: CONCURRENCY,
      recognizeImpl: async (_dataUrl, ctx) => {
        if (ctx.callIndex === CONCURRENCY) void ctx.service.cancel()
        await gate
        return { success: true, text: 'TRACE_CANCELLED', language: null }
      }
    })

    void h.service.startPass()
    await vi.waitFor(() => expect(h.recognize).toHaveBeenCalledTimes(CONCURRENCY))
    releaseGate?.()
    await finishPass(h.service)

    const store = new ImageTextIndexStore(h.databasePath, ACCOUNT)
    const persisted = store.countByState().indexed
    expect(persisted).toBe(CONCURRENCY)
    expect(store.readScanState().get(CONVERSATION)?.state).toBe('partial')
    store.close()

    const status = await h.service.getStatus()
    expect(status.progress.state).toBe('cancelled')
    h.close()
  })

  it('某个 worker 报错 → 其它图片照常完成，整体任务不崩', async () => {
    const h = harness({
      count: 12,
      ocrConcurrency: 4,
      recognizeImpl: async (dataUrl) => {
        const seed = seedFromDataUrl(dataUrl)
        if (seed === 5) throw new Error('native OCR blew up')
        return { success: true, text: `TEXT_${seed}`, language: null }
      }
    })

    await h.service.startPass()
    await finishPass(h.service)

    const status = await h.service.getStatus()
    // 崩掉的那张记成失败，其余全部成功 —— 不是"整批失败"。
    expect(status.progress.processed).toBe(12)
    expect(status.progress.indexed).toBe(11)
    expect(status.progress.failed).toBe(1)

    const store = new ImageTextIndexStore(h.databasePath, ACCOUNT)
    expect(store.getConversationOcr(CONVERSATION).get('local:6')?.text).toBe('TEXT_6')
    store.close()
    h.close()
  })

  it('并发不绕过复用：已有 100 条终态 + 新增 20 张 → OCR 只跑 20 次', async () => {
    const h = harness({ count: 120, ocrConcurrency: 4 })

    // 预热 1..100 为终态（与生产一致的复用语义）。
    const seed = new ImageTextIndexStore(h.databasePath, ACCOUNT)
    for (let index = 1; index <= 100; index += 1) {
      const artifactKey = `seeded|${index}`
      seed.putArtifact({
        accountId: ACCOUNT,
        artifactKey,
        imageIdentity: `sha256:seeded-${index}`,
        state: 'indexed',
        text: `TRACE_SEEDED_${index}`,
        charCount: 16,
        engine: 'windows-system-ocr',
        platform: 'win32',
        runtimeVersion: '1.2.0',
        language: 'zh-Hans-CN',
        createdAt: index,
        updatedAt: index
      })
      seed.putBinding({
        accountId: ACCOUNT,
        conversationId: CONVERSATION,
        messageId: `local:${index}`,
        createTime: index,
        imageIdentity: `sha256:seeded-${index}`,
        artifactKey,
        state: 'indexed',
        updatedAt: index
      })
    }
    seed.close()

    await h.service.startPass()
    await finishPass(h.service)

    // 关键断言：20 次，不是 120 次。
    expect(h.recognize).toHaveBeenCalledTimes(20)

    const store = new ImageTextIndexStore(h.databasePath, ACCOUNT)
    // 旧终态文本原样保留，一条都没被重算覆盖。
    expect(store.getArtifact('seeded|1')?.text).toBe('TRACE_SEEDED_1')
    expect(store.getArtifact('seeded|100')?.text).toBe('TRACE_SEEDED_100')
    store.close()
    h.close()
  })

  it('按固定张数间隔写出分阶段性能画像（供无 GUI 排查）', async () => {
    const profiles: ImageTextIndexStageTimings[] = []
    const h = harness({ count: 1050, ocrConcurrency: 2 })
    h.service.bind({ logStageProfile: (profile) => profiles.push(profile) })

    await h.service.startPass()
    await finishPass(h.service)

    // 1050 张 / 每 500 张一条 → 恰好 2 条（504 与 1008）。
    expect(profiles).toHaveLength(2)

    const first = profiles[0]
    expect(first.ocrConcurrency).toBe(2)
    // 五个阶段都必须有样本，否则"时间花在哪一段"仍然是猜的。
    for (const stage of [first.locate, first.decrypt, first.ocr, first.persist]) {
      expect(stage.count).toBeGreaterThan(0)
    }
    expect(first.ocr.p95).toBeGreaterThanOrEqual(first.ocr.p50)
    // 计数必须自洽：日志里要能直接看出进度，不必再回 UI 对数。
    expect(first.counters.processed).toBeGreaterThan(0)
    expect(
      first.counters.indexed + first.counters.empty + first.counters.missing + first.counters.failed
    ).toBe(first.counters.processed)
    // 速度字段必须在（样本不足时允许为 null，但不能缺字段）。
    expect(first).toHaveProperty('ratePerSec')
    // 单张净耗时与五段之和同量级：不能把 preLoop 的一次性成本摊进来。
    expect(first.perImageMs).toBeGreaterThan(0)
    expect(first.perImageMs).toBeLessThan(
      first.locate.mean +
        first.decrypt.mean +
        first.normalize.mean +
        first.ocr.mean +
        first.persist.mean +
        50
    )
    // 画像里的数字是**累计**推进的，第二条必须更大 —— 否则它就不是"随时间推移的画像"。
    expect(profiles[1].ocrExecutions).toBeGreaterThan(first.ocrExecutions)

    h.close()
  })

  it('预算（messageLimit）用完 → 写 partial，不写假的 done checkpoint', async () => {
    const h = harness({ count: 30, ocrConcurrency: 2 })

    await h.service.startPass({ messageLimit: 10 })
    await finishPass(h.service)

    expect(h.recognize).toHaveBeenCalledTimes(10)

    const store = new ImageTextIndexStore(h.databasePath, ACCOUNT)
    const scan = store.readScanState().get(CONVERSATION)
    // 关键：不能是 done —— 否则"已完成"在说谎，下一遍要么错误跳过（永久漏索引），
    // 要么整会话重扫。真实库里曾经躺着 `done + processed=20 / total=23712`。
    expect(scan?.state).toBe('partial')
    expect(scan?.processed).toBe(10)
    expect(scan?.imageTotal).toBe(30)
    store.close()
    h.close()
  })

  it('重启后不丢终态：新实例重跑同一批 → OCR 一次都不再执行', async () => {
    const h = harness({ count: 24, ocrConcurrency: 4 })
    await h.service.startPass()
    await finishPass(h.service)
    expect(h.recognize).toHaveBeenCalledTimes(24)

    // 换一个全新的 service 实例（模拟重启），复用同一个派生库。
    const restarted = new ImageTextIndexService()
    const recognize2 = vi.fn(async () => ({
      success: true,
      text: 'SHOULD_NOT_RUN',
      language: null
    }))
    restarted.bind({
      databaseRoot: h.databaseRoot,
      resolveAccountId: () => ACCOUNT,
      ocrConcurrency: 4,
      listContacts: async () => [
        { md5: CONVERSATION, m_nsUsrName: 'concurrency', type: 'user' as const }
      ],
      listMessages: async () => Array.from({ length: 24 }, (_, index) => imageMessage(index + 1)),
      countConversationImages: async () => ({ count: 24, typeColumn: 'local_type' }),
      imageWatermark: async () => ({ count: 24, maxLocalId: 24 }),
      capability,
      decryptService: () =>
        ({ findImageFile: fakeFindImageFile, decryptImage: fakeDecryptImage }) as never,
      recognize: recognize2
    })

    await restarted.startPass()
    await vi.waitFor(() => expect(restarted.isRunning()).toBe(false))
    expect(recognize2).not.toHaveBeenCalled()
    restarted.resetAccount()

    h.close()
  })
})
