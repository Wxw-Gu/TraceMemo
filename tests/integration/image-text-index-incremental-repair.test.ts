/**
 * 两条**成本**契约（都在真机上被踩过）：
 *
 * 1. 「更新图片文字索引」必须是增量的。
 *    真机已经跑了 1 小时、留下 14,342 条 OCR 文本 + 31,126 条 empty 终态。
 *    OCR 是昂贵产物，Knowledge / FTS / binding 才是可重建派生层 ——
 *    更新时只能处理 new / pending / retryable，**已有终态一条都不许重算**。
 *
 * 2. 修索引问题不许重跑 OCR（Derived Index Repair）。
 *    只重建 L3（Knowledge 派生条目 / FTS），数据来源是已有 L1/L2；
 *    `ocrExecutions: 0` 是写进类型字面量的契约，不是"期望值"。
 */
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as chat from '../../src/main/services/chat-service'
import { ImageTextIndexService } from '../../src/main/services/image-text-index-service'
import {
  ImageTextIndexStore,
  getImageTextIndexDatabasePath
} from '../../src/main/services/image-text-index-store'

const ACCOUNT = 'wxid_incremental_fixture'
const CONVERSATION = 'md5-incremental'
const roots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'tm-image-incremental-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** 合法的 PNG 头（`detectSystemOcrImageFormat` 只认前 4 字节），尾部塞一个唯一序号。 */
function pngBytes(seed: number): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, seed & 0xff, (seed >> 8) & 0xff])
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

/** 假的派生库预热：写入 `count` 条已完成的 OCR 记录（成功终态）。 */
function seedTerminal(store: ImageTextIndexStore, count: number, state: 'indexed' | 'empty'): void {
  for (let index = 1; index <= count; index += 1) {
    const artifactKey = `seeded|${index}`
    store.putArtifact({
      accountId: ACCOUNT,
      artifactKey,
      imageIdentity: `sha256:seeded-${index}`,
      state,
      text: state === 'indexed' ? `TRACE_SEEDED_${index}` : '',
      charCount: state === 'indexed' ? 16 : 0,
      engine: 'windows-system-ocr',
      platform: 'win32',
      runtimeVersion: '1.2.0',
      language: 'zh-Hans-CN',
      createdAt: index,
      updatedAt: index
    })
    store.putBinding({
      accountId: ACCOUNT,
      conversationId: CONVERSATION,
      messageId: `local:${index}`,
      createTime: index,
      imageIdentity: `sha256:seeded-${index}`,
      artifactKey,
      state,
      updatedAt: index
    })
  }
}

describe('增量更新：已有终态直接复用，只对新增/未完成做 OCR', () => {
  it('已有 100 条终态 + 新增 10 张 + 2 条未完成 → OCR 只跑 12 次', async () => {
    const databaseRoot = makeRoot()
    const databasePath = getImageTextIndexDatabasePath(databaseRoot, ACCOUNT)
    const store = new ImageTextIndexStore(databasePath, ACCOUNT)
    seedTerminal(store, 100, 'indexed')
    // 2 条"未完成"：binding 状态不是终态 → 允许重试。
    for (const id of [111, 112]) {
      store.putBinding({
        accountId: ACCOUNT,
        conversationId: CONVERSATION,
        messageId: `local:${id}`,
        createTime: id,
        imageIdentity: '',
        artifactKey: `pending|${id}`,
        state: 'pending',
        updatedAt: id
      })
    }
    // 旧 checkpoint：当时该会话只有 100 张、水位 100。
    store.writeScanState({
      conversationId: CONVERSATION,
      state: 'done',
      imageTotal: 100,
      imageProcessed: 100,
      maxLocalId: 100
    })
    store.close()

    // 现在源数据变成 112 张（1..100 已有终态，101..110 全新，111..112 之前没跑完）。
    const messages = Array.from({ length: 112 }, (_, index) => imageMessage(index + 1))
    const recognize = vi.fn(async () => ({
      success: true,
      text: 'TRACE_FRESH_TEXT',
      language: 'zh-Hans-CN'
    }))
    const decryptImage = vi.fn((path: string) => {
      const seed = Number(String(path).replace(/\D/g, '')) || 0
      return pngBytes(seed)
    })

    const service = new ImageTextIndexService()
    service.bind({
      databaseRoot,
      resolveAccountId: () => ACCOUNT,
      listContacts: async () => [
        { md5: CONVERSATION, m_nsUsrName: 'incremental', type: 'user' as const }
      ],
      listMessages: async () => messages,
      countConversationImages: async () => ({ count: 112, typeColumn: 'local_type' }),
      imageWatermark: async () => ({ count: 112, maxLocalId: 112 }),
      capability: async () => ({
        available: true,
        engine: 'windows-system-ocr',
        platform: 'win32',
        runtimeVersion: '1.2.0',
        language: 'zh-Hans-CN'
      }),
      decryptService: () => ({ findImageFile: (md5) => `C:/fake/${md5}.dat`, decryptImage }) as never,
      recognize
    })

    await service.startPass()
    await vi.waitFor(() => expect(service.isRunning()).toBe(false))

    // 关键断言：12 次，而不是 112 次。
    expect(recognize).toHaveBeenCalledTimes(12)
    // 已有终态那 100 条连解密都不该碰。
    expect(decryptImage).toHaveBeenCalledTimes(12)

    const after = new ImageTextIndexStore(databasePath, ACCOUNT)
    // 100 条旧终态 + 100 个旧 artifact 一条不少，文本原样保留（不重算、不覆盖）。
    expect(after.countByState().indexed).toBe(112)
    expect(after.getArtifact('seeded|1')?.text).toBe('TRACE_SEEDED_1')
    expect(after.getArtifact('seeded|100')?.text).toBe('TRACE_SEEDED_100')
    after.close()
    service.resetAccount()
  })

  it('水位完全没变 → 整个会话直接跳过，OCR 一次都不调', async () => {
    const databaseRoot = makeRoot()
    const databasePath = getImageTextIndexDatabasePath(databaseRoot, ACCOUNT)
    const store = new ImageTextIndexStore(databasePath, ACCOUNT)
    seedTerminal(store, 20, 'empty')
    store.writeScanState({
      conversationId: CONVERSATION,
      state: 'done',
      imageTotal: 20,
      imageProcessed: 20,
      maxLocalId: 20
    })
    store.close()

    const recognize = vi.fn(async () => ({ success: true, text: 'X', language: null }))
    const service = new ImageTextIndexService()
    service.bind({
      databaseRoot,
      resolveAccountId: () => ACCOUNT,
      listContacts: async () => [
        { md5: CONVERSATION, m_nsUsrName: 'incremental', type: 'user' as const }
      ],
      listMessages: async () => Array.from({ length: 20 }, (_, index) => imageMessage(index + 1)),
      countConversationImages: async () => ({ count: 20, typeColumn: 'local_type' }),
      imageWatermark: async () => ({ count: 20, maxLocalId: 20 }),
      capability: async () => ({
        available: true,
        engine: 'windows-system-ocr',
        platform: 'win32',
        runtimeVersion: '1.2.0',
        language: null
      }),
      decryptService: () => ({ findImageFile: () => null, decryptImage: () => null }) as never,
      recognize
    })

    await service.startPass()
    await vi.waitFor(() => expect(service.isRunning()).toBe(false))

    expect(recognize).not.toHaveBeenCalled()
    service.resetAccount()
  })
})

describe('派生索引修复：只重建 L3，绝不重跑 OCR', () => {
  it('只重建"有 OCR 文本"的会话，且 recognize 一次都不被调用', async () => {
    const databaseRoot = makeRoot()
    const databasePath = getImageTextIndexDatabasePath(databaseRoot, ACCOUNT)
    const store = new ImageTextIndexStore(databasePath, ACCOUNT)
    seedTerminal(store, 3, 'indexed')
    // 另一个会话只有 empty（没有派生文本可修）→ 不该被重建，白读一遍 WCDB。
    store.putArtifact({
      accountId: ACCOUNT,
      artifactKey: 'empty-only|1',
      imageIdentity: 'sha256:empty-only',
      state: 'empty',
      text: '',
      charCount: 0,
      engine: 'windows-system-ocr',
      platform: 'win32',
      runtimeVersion: '1.2.0',
      language: null,
      createdAt: 1,
      updatedAt: 1
    })
    store.putBinding({
      accountId: ACCOUNT,
      conversationId: 'md5-empty-only',
      messageId: 'local:1',
      createTime: 1,
      imageIdentity: 'sha256:empty-only',
      artifactKey: 'empty-only|1',
      state: 'empty',
      updatedAt: 1
    })
    store.close()

    const recognize = vi.fn(async () => ({ success: true, text: 'X', language: null }))
    const onConversationIndexed = vi.fn(async () => undefined)
    const service = new ImageTextIndexService()
    service.bind({
      databaseRoot,
      resolveAccountId: () => ACCOUNT,
      recognize,
      onConversationIndexed
    })

    const result = await service.repairKnowledgeIndex()

    expect(result.skipped).toBe(false)
    expect(result.conversations).toBe(1)
    // 契约：修复路径的定义就是"不调 OCR"。类型上写死成字面量 0。
    expect(result.ocrExecutions).toBe(0)
    expect(recognize).not.toHaveBeenCalled()
    expect(onConversationIndexed).toHaveBeenCalledTimes(1)
    expect(onConversationIndexed).toHaveBeenCalledWith(CONVERSATION)
    service.resetAccount()
  })

  it('索引任务正在跑时拒绝并发修复（避免读到半程 binding）', async () => {
    const databaseRoot = makeRoot()
    const databasePath = getImageTextIndexDatabasePath(databaseRoot, ACCOUNT)
    const store = new ImageTextIndexStore(databasePath, ACCOUNT)
    seedTerminal(store, 1, 'indexed')
    store.close()

    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const service = new ImageTextIndexService()
    service.bind({
      databaseRoot,
      resolveAccountId: () => ACCOUNT,
      listContacts: async () => [
        { md5: CONVERSATION, m_nsUsrName: 'incremental', type: 'user' as const }
      ],
      listMessages: async () => [imageMessage(1)],
      countConversationImages: async () => ({ count: 1, typeColumn: 'local_type' }),
      imageWatermark: async () => ({ count: 1, maxLocalId: 1 }),
      capability: async () => ({
        available: true,
        engine: 'windows-system-ocr',
        platform: 'win32',
        runtimeVersion: '1.2.0',
        language: null
      }),
      decryptService: () => ({ findImageFile: () => null, decryptImage: () => null }) as never,
      // 卡住 pass，让 running 保持为真。
      interactiveIdle: () => gate
    })

    await service.startPass()
    await vi.waitFor(() => expect(service.isRunning()).toBe(true))

    const during = await service.repairKnowledgeIndex()
    expect(during.skipped).toBe(true)
    expect(during.conversations).toBe(0)

    release?.()
    await vi.waitFor(() => expect(service.isRunning()).toBe(false))
    service.resetAccount()
  })
})
