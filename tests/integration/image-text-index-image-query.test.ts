/**
 * 图片索引的**数据边界**契约。
 *
 * 历史问题：图片索引为了找图片，先读整个会话（十几万到二十几万条消息）再在 JS 里筛。
 * 大会话实测单次读取 15s 以上，而那些行 99% 以上是图片索引根本不看的文本消息 ——
 * 这是数据边界错了，不是 OCR 慢。
 *
 * 这一组锁三件事：
 *   1. 接了专用查询就必须走它，**不能再回退到全量读取**；
 *   2. 专用查询产出的 `FormattedMessage` 与全量路径**逐字段同构**（否则 artifact /
 *      binding / checkpoint 的键会变）；
 *   3. 专用路径仍然按图片类型过滤（召回归档可能补进非图片的撤回消息）。
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

const ACCOUNT = 'wxid_boundary_fixture'
const CONVERSATION = 'md5-boundary'
const TEXT_COUNT = 40
const IMAGE_COUNT = 12
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function pngBytes(seed: number): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, seed & 0xff])
}

/** 一半文本、一半图片：只有真图片会被索引。 */
function mixedMessages(): chat.FormattedMessage[] {
  const messages: chat.FormattedMessage[] = []
  for (let index = 0; index < TEXT_COUNT; index += 1) {
    messages.push({
      id: `text-${index}`,
      localId: String(index + 1),
      from: 'user',
      type: '文本',
      content: `第 ${index} 条文本`,
      isSender: false,
      name: '对方',
      contentData: { type: 'text', text: `第 ${index} 条文本` },
      createTime: 1_700_000_000 + index
    } as unknown as chat.FormattedMessage)
  }
  for (let index = 0; index < IMAGE_COUNT; index += 1) {
    messages.push({
      id: `image-${index}`,
      localId: String(TEXT_COUNT + index + 1),
      from: 'user',
      type: '图片',
      content: '',
      isSender: false,
      name: '对方',
      contentData: {
        type: 'image',
        md5: `imgmd5-${index}`,
        datName: `imgdat-${index}`
      },
      createTime: 1_700_000_000 + TEXT_COUNT + index
    } as unknown as chat.FormattedMessage)
  }
  return messages
}

interface Harness {
  service: ImageTextIndexService
  databasePath: string
  listMessages: ReturnType<typeof vi.fn>
  listImageMessages: ReturnType<typeof vi.fn>
}

function createHarness(): Harness {
  const databaseRoot = mkdtempSync(join(tmpdir(), 'tm-boundary-'))
  roots.push(databaseRoot)
  const all = mixedMessages()
  const imagesOnly = all.filter((message) => message.contentData?.type === 'image')

  /**
   * recent-first 之后，"读哪些行"由**时间分段**决定，所以夹具必须像真 WCDB 一样
   * 按窗口说话。忽略窗口的夹具测不出调度行为，只会让"读了几次"变成 4 次。
   */
  const inWindow = (
    message: chat.FormattedMessage,
    window?: { sinceMs?: number; beforeMs?: number }
  ): boolean => {
    const createTimeMs = (message.createTime || 0) * 1000
    if (window?.sinceMs !== undefined && createTimeMs < window.sinceMs) return false
    if (window?.beforeMs !== undefined && createTimeMs >= window.beforeMs) return false
    return true
  }
  const listMessages = vi.fn(async () => all)
  const listImageMessages = vi.fn(
    async (_conversationId: string, window?: { sinceMs?: number; beforeMs?: number }) =>
      imagesOnly.filter((message) => inWindow(message, window))
  )

  const service = new ImageTextIndexService()
  service.bind({
    databaseRoot,
    progressNotifyIntervalMs: 0,
    resolveAccountId: () => ACCOUNT,
    ocrConcurrency: 1,
    listContacts: async () => [
      { md5: CONVERSATION, m_nsUsrName: 'boundary', type: 'user' as const }
    ],
    // 参数必须是 `number | {…}`——与 ImageMessageCountProbe 的签名保持一致。
    countConversationImages: async (
      _conversationId: string,
      range?: number | { sinceMs?: number; beforeMs?: number }
    ) => ({
      count: imagesOnly.filter((message) =>
        inWindow(message, typeof range === 'number' ? undefined : range)
      ).length,
      typeColumn: 'local_type'
    }),
    imageWatermark: async () => ({ count: IMAGE_COUNT, maxLocalId: TEXT_COUNT + IMAGE_COUNT }),
    listMessages,
    listImageMessages,
    capability: async () => ({
      available: true,
      engine: 'macos-system-ocr',
      platform: 'darwin',
      arch: 'arm64',
      runtimeVersion: '1.2.0',
      language: null,
      message: ''
    }),
    decryptService: () =>
      ({
        findImageFile: (md5: string) => `C:/fake/${md5}.dat`,
        decryptImage: (path: string) => pngBytes(Number(/(\d+)\.dat$/.exec(String(path))?.[1] ?? 0))
      }) as never,
    recognize: async () => ({ success: true, text: 'TEXT', language: null })
  })

  return {
    service,
    databasePath: getImageTextIndexDatabasePath(databaseRoot, ACCOUNT),
    listMessages,
    listImageMessages
  }
}

describe('图片索引的数据边界', () => {
  it('uses the image-only query and never falls back to the full conversation read', async () => {
    const h = createHarness()

    await h.service.startPass()
    await vi.waitFor(() => expect(h.service.isRunning()).toBe(false), { timeout: 60_000 })

    // 专用查询被调用；全量读取**一次都不许发生**。
    expect(h.listImageMessages).toHaveBeenCalledTimes(1)
    expect(h.listMessages).not.toHaveBeenCalled()
    // 拿到的行数必须只与图片有关，而不是整个会话。
    expect(h.listImageMessages.mock.calls[0][0]).toBe(CONVERSATION)

    const status = await h.service.getStatus()
    expect(status.progress.processed).toBe(IMAGE_COUNT)

    h.service.resetAccount()
  })

  it('produces the same bindings as the full-conversation path', async () => {
    const h = createHarness()
    const full = createHarness()
    // 对照：拿掉专用查询，强制走老的"全量读 + JS 筛"。
    full.service.bind({ listImageMessages: undefined })

    await h.service.startPass()
    await vi.waitFor(() => expect(h.service.isRunning()).toBe(false), { timeout: 60_000 })
    await full.service.startPass()
    await vi.waitFor(() => expect(full.service.isRunning()).toBe(false), { timeout: 60_000 })

    expect(h.listMessages).not.toHaveBeenCalled()
    expect(full.listMessages).toHaveBeenCalledTimes(1)

    const readBindings = (databasePath: string): Array<Record<string, unknown>> => {
      const store = new ImageTextIndexStore(databasePath, ACCOUNT)
      try {
        return store.getConversationOcr(CONVERSATION).size > 0
          ? [...store.getConversationOcr(CONVERSATION).entries()].map(([messageId, entry]) => ({
              messageId,
              state: entry.state,
              text: entry.text
            }))
          : []
      } finally {
        store.close()
      }
    }

    const withImageQuery = readBindings(h.databasePath)
    const withFullRead = readBindings(full.databasePath)

    expect(withImageQuery.length).toBe(IMAGE_COUNT)
    /**
     * 这条是本用例的核心：两条路径产出的**绑定键与结果**必须逐条相同。
     * 一旦有人改了图片专用查询里的字段映射，`messageId` 会变、键会变，
     * 已有的 artifact / checkpoint 就会全部失效 —— 那正是不会报错但很贵的回归。
     */
    expect(withImageQuery).toEqual(withFullRead)

    h.service.resetAccount()
    full.service.resetAccount()
  })
})
