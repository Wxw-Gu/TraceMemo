/**
 * 硬条件：清理图片文字索引必须让 **Knowledge 里已经产生的 OCR 派生文字**一起失效。
 *
 * 背景：OCR 文本经 normalizer 的固定前缀 `图片文字：` 拼进 `searchableText`，
 * 再进 chunks / FTS。所以"清理成功"不能只等于"派生 SQLite 删掉了" ——
 * 用户执行设置里的「清理图片文字索引」之后，`search_messages` 必须搜不到那些图片文字，
 * 同时**普通文字消息必须一条不少地留着**。
 *
 * 本文件分两部分：
 * - A：Knowledge 侧的失效机制本身成立（内容变了 / 消息被移除都会被重建替换）；
 * - B：生产路径真的触发了它（`imageTextIndexService.clear()` 会逐会话重建）。
 */
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_KNOWLEDGE_CHUNKER,
  type KnowledgeFtsConfig,
  type KnowledgeSourceMessage
} from '../../src/shared/knowledge'
import { KnowledgeStore } from '../../src/main/knowledge/knowledge-store'
import { ImageTextIndexService } from '../../src/main/services/image-text-index-service'
import { getImageTextIndexDatabasePath } from '../../src/main/services/image-text-index-store'
import type * as chat from '../../src/main/services/chat-service'

const ACCOUNT = 'fixture-account-image-ocr'
const CONVERSATION = 'conversation-image-ocr'
const OCR_TOKEN = 'TRACE_IMAGE_OCR_UNIQUE_2026'
const PLAIN_TEXT = '普通聊天内容保留'
const IMAGE_MESSAGE_ID = 'local:9001'
const TEXT_MESSAGE_ID = 'local:9002'

const fts: KnowledgeFtsConfig = {
  profileId: 'test-trigram-external-full',
  tokenizer: 'trigram',
  contentMode: 'external',
  detail: 'full',
  columnsize: 1
}

const roots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'wxe-image-ocr-invalidation-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function textMessage(): KnowledgeSourceMessage {
  return {
    accountId: ACCOUNT,
    conversationId: CONVERSATION,
    messageId: TEXT_MESSAGE_ID,
    createTime: Date.UTC(2026, 8, 1, 10, 0),
    senderId: 'fixture-member-1',
    senderName: '张三',
    kind: 'text',
    text: PLAIN_TEXT
  }
}

/** 带 OCR 派生文本的图片消息（这是 OCR 索引建立后的状态）。 */
function imageMessageWithOcr(caption?: string): KnowledgeSourceMessage {
  return {
    accountId: ACCOUNT,
    conversationId: CONVERSATION,
    messageId: IMAGE_MESSAGE_ID,
    createTime: Date.UTC(2026, 8, 1, 10, 5),
    senderId: 'fixture-member-2',
    senderName: '李四',
    kind: 'image',
    ...(caption ? { text: caption } : {}),
    imageOcrText: OCR_TOKEN,
    imageOcrState: 'indexed'
  }
}

/** 同一张图片，但 OCR 派生文本已经不存在（= 派生库被清掉后 resolver 拿不到东西）。 */
function imageMessageWithoutOcr(caption?: string): KnowledgeSourceMessage {
  return {
    accountId: ACCOUNT,
    conversationId: CONVERSATION,
    messageId: IMAGE_MESSAGE_ID,
    createTime: Date.UTC(2026, 8, 1, 10, 5),
    senderId: 'fixture-member-2',
    senderName: '李四',
    kind: 'image',
    ...(caption ? { text: caption } : {})
  }
}

function searchTokens(store: KnowledgeStore, text: string): string[] {
  return store.search({ accountId: ACCOUNT, text, limit: 20 }).map((item) => item.messageId)
}

function evidenceFor(store: KnowledgeStore, text: string) {
  return store.search({ accountId: ACCOUNT, text, limit: 20 })
}

async function indexConversation(
  store: KnowledgeStore,
  messages: KnowledgeSourceMessage[]
): Promise<void> {
  await store.index({
    conversations: [{ conversationId: CONVERSATION, completeSnapshot: true, messages }],
    chunker: DEFAULT_KNOWLEDGE_CHUNKER
  })
}

describe('Knowledge 侧的失效机制：OCR 派生文字必须能真的消失', () => {
  it('图片消息仍然存在、只是 OCR 文本没了 → 旧 OCR 文字搜不到，普通文字不受影响', async () => {
    const store = new KnowledgeStore(makeRoot(), ACCOUNT, fts)

    // 1) 建立图片 OCR 派生记录 + 完成索引
    await indexConversation(store, [textMessage(), imageMessageWithOcr()])

    // 2) 必须能搜到，并且命中的是**原始图片消息**
    const before = evidenceFor(store, OCR_TOKEN)
    expect(before.length).toBeGreaterThan(0)
    expect(before[0].messageId).toBe(IMAGE_MESSAGE_ID)
    expect(before[0].sourceKind).toBe('image')

    // 3) OCR 文本被清掉（模拟「清理图片文字索引」后重建）
    await indexConversation(store, [textMessage(), imageMessageWithoutOcr()])

    // 4) 旧 OCR 文字必须彻底搜不到
    expect(searchTokens(store, OCR_TOKEN)).toEqual([])

    // 5) 普通文字消息必须仍然命中 —— 不能清掉普通 Knowledge
    expect(searchTokens(store, PLAIN_TEXT)).toContain(TEXT_MESSAGE_ID)

    store.close()
  })

  it('无文字图片消息在 OCR 清掉后被整体移除 → 旧 OCR 文字同样搜不到', async () => {
    const store = new KnowledgeStore(makeRoot(), ACCOUNT, fts)

    // 这条图片消息除了 OCR 文本之外没有任何内容；OCR 一清，它就不该再进索引。
    await indexConversation(store, [textMessage(), imageMessageWithOcr()])
    expect(searchTokens(store, OCR_TOKEN).length).toBeGreaterThan(0)

    await indexConversation(store, [textMessage()])

    expect(searchTokens(store, OCR_TOKEN)).toEqual([])
    expect(searchTokens(store, PLAIN_TEXT)).toContain(TEXT_MESSAGE_ID)

    store.close()
  })

  it('OCR 文本变化（state 仍是 indexed）也必须让旧文本失效', async () => {
    const store = new KnowledgeStore(makeRoot(), ACCOUNT, fts)

    await indexConversation(store, [textMessage(), imageMessageWithOcr()])
    expect(searchTokens(store, OCR_TOKEN).length).toBeGreaterThan(0)

    // 同一个 state（indexed），内容换成了另一段文字 —— 例如换了 OCR 运行时后重新识别。
    const replaced = {
      ...imageMessageWithOcr(),
      imageOcrText: 'TRACE_IMAGE_OCR_REPLACED_2026'
    }
    await indexConversation(store, [textMessage(), replaced])

    expect(searchTokens(store, OCR_TOKEN)).toEqual([])
    expect(searchTokens(store, 'TRACE_IMAGE_OCR_REPLACED_2026')).toContain(IMAGE_MESSAGE_ID)

    store.close()
  })
})

describe('生产路径：清理必须逐会话重建 Knowledge', () => {
  function imageMessage(localId: number, conversationId: string): chat.FormattedMessage {
    return {
      localId: String(localId),
      createTime: 1_700_000_000 + localId,
      content: '[图片]',
      contentData: { type: 'image', md5: `md5-${localId}`, datName: `dat-${localId}` },
      sessionId: conversationId
    } as unknown as chat.FormattedMessage
  }

  it('clear() 对每个有 OCR 派生文本的会话都触发一次重建，而不是清空整个 Knowledge', async () => {
    const databaseRoot = makeRoot()
    const conversations = ['conv-alpha', 'conv-beta']
    const onConversationIndexed = vi.fn(async () => undefined)

    const service = new ImageTextIndexService()
    service.bind({
      databaseRoot,
      resolveAccountId: () => ACCOUNT,
      listContacts: async () =>
        conversations.map((md5) => ({ md5, m_nsUsrName: md5, type: 'group' as const })),
      listMessages: async (conversationId) => [imageMessage(1, conversationId)],
      countConversationImages: async () => ({ count: 1, typeColumn: 'local_type' }),
      imageWatermark: async () => ({ count: 1, maxLocalId: 1 }),
      // 没有解密服务 → 图片判为 image_missing；这不影响"这条会话有没有 OCR 绑定"。
      decryptService: () => ({ findImageFile: () => null, decryptImage: () => null }) as never,
      capability: async () => ({
        available: true,
        engine: 'windows-system-ocr',
        platform: 'win32',
        runtimeVersion: '1.2.0',
        language: 'zh-Hans-CN'
      }),
      onConversationIndexed
    })

    await service.startPass()
    await vi.waitFor(() => expect(service.isRunning()).toBe(false))

    /**
     * 这个 fixture **刻意没有解密服务** ⇒ 所有图片都落成 `image_missing`，没有一条
     * 可搜索的 OCR 文字。所以本遍**不应该**叫醒 Knowledge：
     * 索引侧没有可搜索内容变化，重建纯属白读一遍 WCDB。
     * （"有文字 ⇒ 必须重建"由 image-text-index-store-cache 的门控用例覆盖。）
     */
    const databasePath = getImageTextIndexDatabasePath(databaseRoot, ACCOUNT)
    expect(onConversationIndexed).toHaveBeenCalledTimes(0)

    onConversationIndexed.mockClear()
    const result = await service.clear()

    expect(result.removed).toBe(true)
    // 关键：清理必须重建这两个会话，否则 Knowledge 里还留着图片文字。
    expect(onConversationIndexed).toHaveBeenCalledTimes(2)
    expect(onConversationIndexed.mock.calls.map((call) => call[0]).sort()).toEqual(
      [...conversations].sort()
    )
    expect(service.lastInvalidatedConversations).toBe(2)
    expect(databasePath).toBeTruthy()
  })

  it('prepareForCacheClear() 同样会做失效（"清理全部"路径不能漏）', async () => {
    const databaseRoot = makeRoot()
    const onConversationIndexed = vi.fn(async () => undefined)

    const service = new ImageTextIndexService()
    service.bind({
      databaseRoot,
      resolveAccountId: () => ACCOUNT,
      listContacts: async () => [
        { md5: CONVERSATION, m_nsUsrName: CONVERSATION, type: 'group' as const }
      ],
      listMessages: async () => [imageMessage(1, CONVERSATION)],
      countConversationImages: async () => ({ count: 1, typeColumn: 'local_type' }),
      imageWatermark: async () => ({ count: 1, maxLocalId: 1 }),
      decryptService: () => ({ findImageFile: () => null, decryptImage: () => null }) as never,
      capability: async () => ({
        available: true,
        engine: 'windows-system-ocr',
        platform: 'win32',
        runtimeVersion: '1.2.0',
        language: 'zh-Hans-CN'
      }),
      onConversationIndexed
    })

    await service.startPass()
    await vi.waitFor(() => expect(service.isRunning()).toBe(false))
    onConversationIndexed.mockClear()

    await service.prepareForCacheClear()

    expect(onConversationIndexed).toHaveBeenCalledWith(CONVERSATION)
  })

  it('派生库里没有 OCR 绑定时，清理不触发任何无意义的重建', async () => {
    const databaseRoot = makeRoot()
    const onConversationIndexed = vi.fn(async () => undefined)
    const service = new ImageTextIndexService()
    service.bind({
      databaseRoot,
      resolveAccountId: () => ACCOUNT,
      onConversationIndexed
    })

    const result = await service.clear()
    expect(result.removed).toBe(true)
    expect(onConversationIndexed).not.toHaveBeenCalled()
  })
})
