import { vi } from 'vitest'
import type { ImageTextIndexStatus } from '../../../src/shared/image-text-index'

/**
 * 默认的「未建立」快照。
 *
 * 与主进程 `getStatus()` 在派生库不存在时返回的形状逐字段一致 ——
 * 测试 fake 要是自己编一个形状，就测不出真实的字段缺失。
 */
export function notBuiltImageTextIndexStatus(): ImageTextIndexStatus {
  return {
    progress: {
      state: 'idle',
      totalImageMessages: 0,
      processed: 0,
      indexed: 0,
      empty: 0,
      missing: 0,
      failed: 0,
      pending: 0,
      percent: 0,
      updatedAt: 0,
      cancellable: false,
      paused: false
    },
    coverage: {
      totalImageMessages: 0,
      processed: 0,
      indexed: 0,
      empty: 0,
      missing: 0,
      failed: 0,
      pending: 0,
      established: false,
      complete: false,
      countedAt: null
    },
    storage: { indexedImages: 0, ocrTextCount: 0, totalBytes: 0, updatedAt: null },
    counting: false
  }
}

/**
 * Ask-WeChat 相关工作区测试用的「图片文字索引」桥接 fake。
 *
 * 真实 preload 一定暴露这些方法；测试里的 `window.api` 是手写对象字面量，
 * 漏掉任何一个都会让卡片在挂载期抛错，并连带**整个工作区**渲染失败
 * （一个次要侧栏卡片不该有能力搞挂主界面）。
 */
export function makeImageTextIndexApi(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    getImageTextIndexStatus: vi.fn().mockResolvedValue(notBuiltImageTextIndexStatus()),
    countImageMessages: vi.fn().mockResolvedValue({
      totalImageMessages: 0,
      scannedConversations: 0,
      durationMs: 0
    }),
    startImageTextIndex: vi.fn().mockResolvedValue({ started: true, state: 'running' }),
    pauseImageTextIndex: vi.fn().mockResolvedValue({ paused: true, state: 'paused' }),
    resumeImageTextIndex: vi.fn().mockResolvedValue({ started: true, state: 'running' }),
    cancelImageTextIndex: vi.fn().mockResolvedValue({ cancellable: true, cancelled: true }),
    clearImageTextIndex: vi.fn().mockResolvedValue({ removed: true, removedBytes: 0 }),
    resetImageTextIndexFailures: vi.fn().mockResolvedValue({ reset: 0 }),
    repairImageTextIndex: vi
      .fn()
      .mockResolvedValue({ conversations: 0, ocrExecutions: 0, durationMs: 0, skipped: false }),
    onImageTextIndexStatus: vi.fn(() => () => undefined),
    ...overrides
  }
}
