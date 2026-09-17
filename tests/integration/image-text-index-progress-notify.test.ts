/**
 * 图片文字索引的**进度通知节流**契约。
 *
 * 背景：后台按 `BATCH_SIZE = 12` 推进，但 UI 不该感知 batch 大小 ——
 * 每批都推会让计数以「+12」的粒度跳动。
 *
 * 硬要求：
 *  1. 正常运行态最多每 `progressNotifyIntervalMs` 推一次**最新权威快照**；
 *  2. 状态变化（开始/暂停/继续/取消/完成/失败）**立即**推，不等窗口；
 *  3. 完成必须立即给出最终值；
 *  4. 同时最多一个 timer，pass 结束后不留残留定时器；
 *  5. 推的是快照，不是把窗口内几十个 delta 重放给 Renderer。
 *
 * 为了避免时序脆弱的测试，最关键的一条用**把窗口设得极大**来表达：
 * 如果节流正确，整遍 pass 里只应有「开始」和「完成」两次状态变化通知。
 */
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as chat from '../../src/main/services/chat-service'
import { ImageTextIndexService } from '../../src/main/services/image-text-index-service'
import type { ImageTextIndexStatus } from '../../src/shared/image-text-index'

const ACCOUNT = 'wxid_progress_notify_fixture'
const CONVERSATION = 'md5-progress-notify'
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'tm-progress-notify-'))
  roots.push(root)
  return root
}

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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 每张图 sleep 一点，让 pass 有可观测的持续时间。 */
function createService(options: { count: number; notifyIntervalMs: number; perImageMs?: number }): {
  service: ImageTextIndexService
  notifications: Array<{ at: number; processed: number; state: string }>
} {
  const databaseRoot = makeRoot()
  const messages = Array.from({ length: options.count }, (_, index) => imageMessage(index + 1))
  const perImageMs = options.perImageMs ?? 0

  const service = new ImageTextIndexService()
  service.bind({
    databaseRoot,
    progressNotifyIntervalMs: options.notifyIntervalMs,
    resolveAccountId: () => ACCOUNT,
    ocrConcurrency: 2,
    listContacts: async () => [{ md5: CONVERSATION, m_nsUsrName: 'notify', type: 'user' as const }],
    listMessages: async () => messages,
    countConversationImages: async () => ({ count: messages.length, typeColumn: 'local_type' }),
    imageWatermark: async () => ({ count: messages.length, maxLocalId: messages.length }),
    capability: async () => ({
      available: true,
      engine: 'windows-system-ocr',
      platform: 'win32',
      runtimeVersion: '1.2.0',
      language: 'zh-Hans-CN'
    }),
    decryptService: () =>
      ({
        findImageFile: (md5: string) => `C:/fake/${md5}.dat`,
        decryptImage: (path: string) => pngBytes(Number(/(\d+)\.dat$/.exec(String(path))?.[1] ?? 1))
      }) as never,
    recognize: async () => {
      if (perImageMs > 0) await sleep(perImageMs)
      return { success: true, text: 'TEXT', language: null }
    }
  })

  const notifications: Array<{ at: number; processed: number; state: string }> = []
  service.onStatusChange((status: ImageTextIndexStatus) => {
    notifications.push({
      at: Date.now(),
      processed: status.progress.processed,
      state: status.progress.state
    })
  })

  return { service, notifications }
}

const finish = async (service: ImageTextIndexService): Promise<void> => {
  await vi.waitFor(() => expect(service.isRunning()).toBe(false))
}

describe('进度通知节流', () => {
  it('窗口极大时，整遍 pass 只推「开始」和「完成」两次状态变化', async () => {
    // 240 张 = 20 个 batch。若每批都推会有 20+ 次通知；节流正确则只有状态变化。
    const { service, notifications } = createService({
      count: 240,
      notifyIntervalMs: 100_000,
      perImageMs: 2
    })

    await service.startPass()
    await finish(service)

    expect(notifications.map((n) => n.state)).toEqual(['running', 'completed'])
    // 完成必须带**最终值**，不能等下一次 5 秒 timer。
    expect(notifications[notifications.length - 1].processed).toBe(240)
    service.resetAccount()
  })

  it('窗口为 0 时不做节流（每次都推最新快照）', async () => {
    const { service, notifications } = createService({
      count: 240,
      notifyIntervalMs: 0,
      perImageMs: 2
    })

    await service.startPass()
    await finish(service)

    // 不节流 ⇒ 通知数应远多于「仅两次状态变化」，且处理量单调不减。
    expect(notifications.length).toBeGreaterThan(4)
    const processed = notifications.map((n) => n.processed)
    expect([...processed].sort((a, b) => a - b)).toEqual(processed)
    expect(processed[processed.length - 1]).toBe(240)
    service.resetAccount()
  })

  it('暂停立即推送，不等窗口', async () => {
    const { service, notifications } = createService({
      count: 600,
      notifyIntervalMs: 100_000,
      perImageMs: 4
    })

    void service.startPass()
    // 注意：窗口是 100 秒，**进度通知按设计不会来**，所以不能用通知当等待条件。
    await vi.waitFor(async () => {
      const status = await service.getStatus()
      expect(status.progress.processed).toBeGreaterThan(0)
    })
    service.pause()
    await finish(service)

    const pausedAt = notifications.findIndex((n) => n.state === 'paused')
    expect(pausedAt).toBeGreaterThanOrEqual(0)
    // 暂停之后不应再有「运行中」的进度推送（窗口是 100 秒，等不到）。
    expect(notifications.slice(pausedAt + 1).some((n) => n.state === 'running')).toBe(false)
    service.resetAccount()
  })

  it('pass 结束后不留残留 timer：不再产生额外通知', async () => {
    const { service, notifications } = createService({
      count: 120,
      notifyIntervalMs: 30,
      perImageMs: 1
    })

    await service.startPass()
    await finish(service)
    const afterFinish = notifications.length
    // 窗口只有 30ms，如果尾随 timer 没被清掉，这段时间里一定会再冒出通知。
    await sleep(200)
    expect(notifications.length).toBe(afterFinish)
    expect(notifications[notifications.length - 1].state).toBe('completed')
    service.resetAccount()
  })

  it('continue（重新 startPass）不会叠加出第二个 timer', async () => {
    const { service, notifications } = createService({
      count: 240,
      notifyIntervalMs: 30,
      perImageMs: 1
    })

    void service.startPass()
    await vi.waitFor(async () => {
      const status = await service.getStatus()
      expect(status.progress.processed).toBeGreaterThan(0)
    })
    service.pause()
    await finish(service)

    const pausedCount = notifications.length
    await service.resume()
    await finish(service)
    await sleep(200)

    // 恢复后应重新开始推送，但不应因"两个 interval 并存"而翻倍：
    // 第一遍以 paused 收尾、第二遍以 completed 收尾 ⇒ completed 恰好 1 次。
    expect(notifications.length).toBeGreaterThan(pausedCount)
    const completed = notifications.filter((n) => n.state === 'completed')
    expect(completed).toHaveLength(1)
    expect(notifications.filter((n) => n.state === 'paused')).toHaveLength(1)
    service.resetAccount()
  })

  it('速度与 ETA 只在窗口样本足够时给出，否则为 null', async () => {
    const { service } = createService({ count: 120, notifyIntervalMs: 0, perImageMs: 1 })
    await service.startPass()
    await finish(service)

    const status = await service.getStatus()
    // 这遍跑得太快，窗口跨度不足 ⇒ 必须如实为 null（UI 显示"计算中"），不许编数。
    expect(status.progress.speedPerSec).toBeNull()
    expect(status.progress.etaMs).toBeNull()
    service.resetAccount()
  })
})
