/**
 * 「图片文字索引」的 checkpoint（增量水位）与覆盖度契约。
 *
 * 这里覆盖的都是**不能用 UI 数字糊过去**的硬约束：
 * - 覆盖度必须在重启后依然诚实（派生库只知道处理过什么，不知道源数据一共多少）；
 * - 增量判据必须能发现「总数没变但集合变了」；
 * - 清理必须真的把文件删掉，删不掉要如实上报；
 * - 涉及图片的问题在索引未完成时，答案语义里必须带"不能因为没搜到就说没有"。
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as chat from '../../src/main/services/chat-service'
import { ImageTextIndexService } from '../../src/main/services/image-text-index-service'
import {
  ImageTextIndexStore,
  getImageTextIndexDatabasePath
} from '../../src/main/services/image-text-index-store'
import { buildImageOcrCoverage } from '../../src/main/services/local-query-api-service'
import type { ImageTextIndexCoverage } from '../../src/shared/image-text-index'

const ACCOUNT = 'wxid_fixture_account'
const CONVERSATION = 'conversation-md5-fixture'
const roots: string[] = []

function makeDatabaseRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'tm-image-text-index-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      // 测试收尾尽力而为。
    }
  }
})

/** 只带图片索引需要的字段；其余字段与本测试无关。 */
function imageMessage(localId: number, createTime: number): chat.FormattedMessage {
  return {
    localId: String(localId),
    createTime,
    content: '[图片]',
    contentData: { type: 'image', md5: `md5-${localId}`, datName: `dat-${localId}` }
  } as unknown as chat.FormattedMessage
}

type Harness = {
  service: ImageTextIndexService
  databaseRoot: string
  listMessages: ReturnType<typeof vi.fn>
  watermark: { count: number; maxLocalId: number }
  databasePath: string
}

function makeHarness(options: { messages?: chat.FormattedMessage[] } = {}): Harness {
  const databaseRoot = makeDatabaseRoot()
  const listMessages = vi.fn(async () => options.messages ?? [])
  const watermark = { count: 0, maxLocalId: 0 }
  const service = new ImageTextIndexService()
  service.bind({
    databaseRoot,
    resolveAccountId: () => ACCOUNT,
    resolveAccountRoot: () => 'C:/fixture/account',
    listContacts: async () => [
      { md5: CONVERSATION, m_nsUsrName: 'fixture', type: 'group' as const }
    ],
    listMessages,
    countConversationImages: async () => ({ count: watermark.count, typeColumn: 'local_type' }),
    imageWatermark: async () => ({ ...watermark }),
    // 没有解密服务 → 每张图片都会被判成 image_missing。这样测试完全不碰真实图片。
    decryptService: () => ({ findImageFile: () => null, decryptImage: () => null }) as never,
    capability: async () => ({
      available: true,
      engine: 'windows-system-ocr',
      platform: 'win32',
      runtimeVersion: '1.2.0',
      language: 'zh-Hans-CN'
    }),
    recognize: async () => ({ success: true, text: '', language: 'zh-Hans-CN' })
  })
  return {
    service,
    databaseRoot,
    listMessages,
    watermark,
    databasePath: getImageTextIndexDatabasePath(databaseRoot, ACCOUNT)
  }
}

describe('增量水位：只比条数会漏掉「等量替换」', () => {
  it('水位（条数 + 最大插入序）都没变时才跳过，不读 WCDB', async () => {
    const harness = makeHarness({ messages: [imageMessage(10, 1000), imageMessage(20, 2000)] })
    harness.watermark.count = 2
    harness.watermark.maxLocalId = 20

    await harness.service.startPass()
    // 走到完成态需要等内部 promise 收敛。
    await vi.waitFor(() => expect(harness.service.isRunning()).toBe(false))
    expect(harness.listMessages).toHaveBeenCalledTimes(1)

    // 第二遍：水位完全一致 → 跳过，不再读会话消息。
    await harness.service.startPass()
    await vi.waitFor(() => expect(harness.service.isRunning()).toBe(false))
    expect(harness.listMessages).toHaveBeenCalledTimes(1)
  })

  it('总数相同但最大插入序前进 → 必须重扫（撤回一张旧图 + 新增一张新图）', async () => {
    const harness = makeHarness({ messages: [imageMessage(10, 1000), imageMessage(20, 2000)] })
    harness.watermark.count = 2
    harness.watermark.maxLocalId = 20

    await harness.service.startPass()
    await vi.waitFor(() => expect(harness.service.isRunning()).toBe(false))
    expect(harness.listMessages).toHaveBeenCalledTimes(1)

    // 集合变了、条数没变：localId 10 被撤回，新增 localId 30。
    harness.listMessages.mockImplementation(async () => [
      imageMessage(20, 2000),
      imageMessage(30, 3000)
    ])
    harness.watermark.maxLocalId = 30

    await harness.service.startPass()
    await vi.waitFor(() => expect(harness.service.isRunning()).toBe(false))
    // 只看 count 的实现会在这里静默跳过 —— 那正是会漏掉新图片的洞。
    expect(harness.listMessages).toHaveBeenCalledTimes(2)
  })

  it('水位不可用（数据库不支持该聚合）时一律重扫，宁可慢也不漏', async () => {
    const harness = makeHarness({ messages: [imageMessage(10, 1000)] })
    harness.watermark.count = 1
    const service = new ImageTextIndexService()
    const listMessages = vi.fn(async () => [imageMessage(10, 1000)])
    service.bind({
      databaseRoot: harness.databaseRoot,
      resolveAccountId: () => ACCOUNT,
      listContacts: async () => [{ md5: CONVERSATION, m_nsUsrName: 'fixture', type: 'group' }],
      listMessages,
      countConversationImages: async () => ({ count: 1, typeColumn: 'local_type' }),
      // 关键：不提供 imageWatermark
      decryptService: () => ({ findImageFile: () => null, decryptImage: () => null }) as never,
      capability: async () => ({
        available: true,
        engine: 'windows-system-ocr',
        platform: 'win32',
        runtimeVersion: null,
        language: null
      })
    })

    await service.startPass()
    await vi.waitFor(() => expect(service.isRunning()).toBe(false))
    await service.startPass()
    await vi.waitFor(() => expect(service.isRunning()).toBe(false))
    expect(listMessages).toHaveBeenCalledTimes(2)
  })
})

describe('覆盖度诚实性', () => {
  it('重启后仍是 partial：分母来自落盘统计，不会退化成 processed', async () => {
    const { databaseRoot, databasePath } = makeHarness()
    // 先按「已建立过索引」写库：总数 100，实际只处理了 30 条。
    const store = new ImageTextIndexStore(databasePath, ACCOUNT)
    store.writeCountedTotal({ total: 100, countedAt: 1_700_000_000_000, complete: true })
    for (let index = 0; index < 30; index += 1) {
      store.putBinding({
        accountId: ACCOUNT,
        conversationId: CONVERSATION,
        messageId: `local:${index}`,
        createTime: index,
        imageIdentity: `sha256:${index}`,
        artifactKey: `sha256:${index}|fake`,
        state: 'indexed',
        updatedAt: index
      })
    }
    store.close()

    // 全新 service 实例 = 模拟应用重启（内存计数器归零）。
    const service = new ImageTextIndexService()
    service.bind({ databaseRoot, resolveAccountId: () => ACCOUNT })
    const status = await service.getStatus()

    expect(status.coverage.totalImageMessages).toBe(100)
    expect(status.coverage.processed).toBe(30)
    expect(status.coverage.established).toBe(true)
    // 修复前这里会因为 total 退化成 processed 而变成 true（把 30% 谎报成 100%）。
    expect(status.coverage.complete).toBe(false)
    expect(status.coverage.countedAt).toBe(1_700_000_000_000)
  })

  it('统计时有会话没数上 → 分母不完整，不允许声称 complete', async () => {
    const { databaseRoot, databasePath } = makeHarness()
    const store = new ImageTextIndexStore(databasePath, ACCOUNT)
    store.writeCountedTotal({ total: 10, countedAt: 1, complete: false })
    store.putBinding({
      accountId: ACCOUNT,
      conversationId: CONVERSATION,
      messageId: 'local:1',
      createTime: 1,
      imageIdentity: 'sha256:1',
      artifactKey: 'sha256:1|fake',
      state: 'indexed',
      updatedAt: 1
    })
    store.close()

    const service = new ImageTextIndexService()
    service.bind({ databaseRoot, resolveAccountId: () => ACCOUNT })
    const status = await service.getStatus()
    expect(status.coverage.processed).toBe(1)
    expect(status.coverage.complete).toBe(false)
  })

  it('从未统计过 → 不算已建立，且查询路径不为看覆盖度凭空建库', async () => {
    const { databaseRoot, databasePath } = makeHarness()
    const service = new ImageTextIndexService()
    service.bind({ databaseRoot, resolveAccountId: () => ACCOUNT })
    expect(service.getCoverageSnapshot()).toBeNull()
    expect(existsSync(databasePath)).toBe(false)
  })
})

describe('清理：删得掉才算成功', () => {
  it('清理后派生库文件消失，覆盖度回到未建立', async () => {
    const { service, databasePath } = makeHarness()
    // 建一份有内容的派生数据（建库 + 写 artifact/binding/水位 + 落盘总数）。
    const store = new ImageTextIndexStore(databasePath, ACCOUNT)
    store.writeCountedTotal({ total: 5, countedAt: 1, complete: true })
    store.putArtifact({
      accountId: ACCOUNT,
      artifactKey: 'k',
      imageIdentity: 'sha256:x',
      state: 'indexed',
      text: 'fixture',
      charCount: 7,
      engine: 'windows-system-ocr',
      platform: 'win32',
      runtimeVersion: '1.2.0',
      language: 'zh-Hans-CN',
      createdAt: 1,
      updatedAt: 1
    })
    store.close()
    expect(existsSync(databasePath)).toBe(true)

    const result = await service.clear()
    expect(result.removed).toBe(true)
    expect(existsSync(databasePath)).toBe(false)

    const status = await service.getStatus()
    expect(status.coverage.established).toBe(false)
    expect(status.coverage.totalImageMessages).toBe(0)
    expect(status.coverage.countedAt).toBeNull()
  })
})

describe('查询层：覆盖度必须是独立维度且带零结果诚实性', () => {
  const coverageOf = (input: Partial<ImageTextIndexCoverage>): ImageTextIndexCoverage => ({
    totalImageMessages: 0,
    processed: 0,
    indexed: 0,
    empty: 0,
    missing: 0,
    failed: 0,
    pending: 0,
    established: false,
    complete: false,
    countedAt: null,
    ...input
  })

  it('partial：必须明确「不能因为没搜到就回答没有」并给出真实比例', () => {
    const built = buildImageOcrCoverage(
      coverageOf({
        totalImageMessages: 100,
        processed: 30,
        indexed: 28,
        empty: 2,
        established: true,
        countedAt: 1_700_000_000_000
      })
    )
    expect(built?.state).toBe('partial')
    expect(built?.totalImageMessages).toBe(100)
    expect(built?.processed).toBe(30)
    expect(built?.summary).toContain('30')
    expect(built?.summary).toContain('100')
    expect(built?.summary).toContain('不能因为没搜到就回答')
  })

  it('complete：不附加零结果约束，但仍带上统计时刻', () => {
    const built = buildImageOcrCoverage(
      coverageOf({
        totalImageMessages: 100,
        processed: 100,
        indexed: 90,
        empty: 10,
        established: true,
        complete: true,
        countedAt: 1_700_000_000_000
      })
    )
    expect(built?.state).toBe('complete')
    expect(built?.summary).not.toContain('不能因为没搜到就回答')
  })

  it('not_built：说明图片里的文字目前搜不到，且同样禁止凭零结果下"没有"', () => {
    const built = buildImageOcrCoverage(coverageOf({}))
    expect(built?.state).toBe('not_built')
    expect(built?.summary).toContain('尚未建立')
    expect(built?.summary).toContain('不能因为没搜到就回答')
  })

  it('没有覆盖度（库都不存在）时不下发该字段，不制造假维度', () => {
    expect(buildImageOcrCoverage(null)).toBeUndefined()
  })
})

describe('图片数量统计：必须区分「0 张」与「统计失败」', () => {
  function bindCounting(
    service: ImageTextIndexService,
    databaseRoot: string,
    probe: () => Promise<{ count: number | null; typeColumn: string | null; error?: string }>
  ): void {
    service.bind({
      databaseRoot,
      resolveAccountId: () => ACCOUNT,
      listContacts: async () => [
        { md5: 'conv-a', m_nsUsrName: 'a', type: 'group' as const },
        { md5: 'conv-b', m_nsUsrName: 'b', type: 'group' as const }
      ],
      countConversationImages: probe
    })
  }

  it('真的 0 张：scanned=2 / failed=0，可以放心说 0', async () => {
    const service = new ImageTextIndexService()
    bindCounting(service, makeDatabaseRoot(), async () => ({
      count: 0,
      typeColumn: 'local_type'
    }))

    const result = await service.countImageMessages()
    expect(result.totalImageMessages).toBe(0)
    expect(result.scannedConversations).toBe(2)
    expect(result.failedConversations).toBe(0)
    expect(result.typeColumn).toBe('local_type')
    expect(result.error).toBeUndefined()
  })

  it('统计全部失败：不得表现为 0 张，且必须给出原因', async () => {
    const service = new ImageTextIndexService()
    bindCounting(service, makeDatabaseRoot(), async () => ({
      count: null,
      typeColumn: null,
      error: '读取消息分片失败'
    }))

    const result = await service.countImageMessages()
    expect(result.totalImageMessages).toBe(0)
    // 关键区分：一个会话都没数成。
    expect(result.scannedConversations).toBe(0)
    expect(result.failedConversations).toBe(2)
    expect(result.error).toBe('读取消息分片失败')
    // 统计失败 → 分母不成立 → 不允许声称已建立覆盖。
    const status = await service.getStatus()
    expect(status.coverage.established).toBe(false)
    expect(status.coverage.complete).toBe(false)
    expect(status.coverage.countedAt).not.toBeNull()
  })

  it('部分失败：总数偏小，coverage 不允许声称 complete', async () => {
    const service = new ImageTextIndexService()
    let call = 0
    bindCounting(service, makeDatabaseRoot(), async () => {
      call += 1
      return call === 1
        ? { count: 10, typeColumn: 'local_type' }
        : { count: null, typeColumn: null, error: '图片消息统计查询失败' }
    })

    const result = await service.countImageMessages()
    expect(result.totalImageMessages).toBe(10)
    expect(result.scannedConversations).toBe(1)
    expect(result.failedConversations).toBe(1)

    const status = await service.getStatus()
    expect(status.coverage.totalImageMessages).toBe(10)
    expect(status.coverage.complete).toBe(false)
  })

  it('探测到的类型列名会向上透出（列名不一致时是唯一线索）', async () => {
    const service = new ImageTextIndexService()
    bindCounting(service, makeDatabaseRoot(), async () => ({
      count: 3,
      typeColumn: 'msg_type'
    }))

    const result = await service.countImageMessages()
    expect(result.typeColumn).toBe('msg_type')
  })
})
