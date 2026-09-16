/**
 * 事故回归：**"4.5 万张全部失败，UI 却说已建立"** 这一整套语义。
 *
 * 真机现场（派生库实测）：
 *   total = 45,707 / 全部 binding = decrypt_failed 45,479 / artifacts = 0 行
 * 根因是解密服务在回填时不存在（只在 db:getImage 里懒加载），每张图都在
 * `processOne` 第一步就失败。这里把"不许再发生"的四件事钉死：
 *   1. 前置依赖缺失时必须**一条记录都不写**（preflight）；
 *   2. 处理过但一条没成功 = **异常**，不是"已建立"；
 *   3. 百分比不许四舍五入到 100（45,479 / 45,707）；
 *   4. 重置失败记录**不能**动已经成功的记录。
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
import {
  describeImageTextCoverage,
  imageTextCoverageState,
  imageTextProcessedPercent,
  type ImageTextIndexCoverage
} from '../../src/shared/image-text-index'

const ACCOUNT = 'wxid_incident_fixture'
const CONVERSATION = 'md5-incident'
const roots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'tm-image-incident-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function imageMessage(localId: number): chat.FormattedMessage {
  return {
    localId: String(localId),
    createTime: 1_700_000_000 + localId,
    content: '[图片]',
    contentData: { type: 'image', md5: `md5-${localId}`, datName: `dat-${localId}` }
  } as unknown as chat.FormattedMessage
}

function coverageOf(overrides: Partial<ImageTextIndexCoverage>): ImageTextIndexCoverage {
  return {
    totalImageMessages: 0,
    processed: 0,
    indexed: 0,
    empty: 0,
    missing: 0,
    failed: 0,
    runtimeUnavailable: 0,
    pending: 0,
    established: false,
    complete: false,
    systemicFailure: false,
    countedAt: null,
    ...overrides
  }
}

describe('事故语义：全失败不能叫"已建立"', () => {
  it('indexed/empty/missing 全为 0 而 failed 不为 0 → 异常，且 complete 必为 false', () => {
    const coverage = coverageOf({
      totalImageMessages: 45_707,
      processed: 45_479,
      failed: 45_479,
      pending: 228,
      established: true,
      countedAt: 1_789_516_520_246,
      complete: false, // 服务侧已经算出 false；这里验证状态与文案
      systemicFailure: true
    })

    expect(imageTextCoverageState(coverage)).toBe('failed')
    expect(describeImageTextCoverage(coverage)).toContain('当前异常')
    expect(describeImageTextCoverage(coverage)).not.toContain('已覆盖全部')
  })

  it('45,479 / 45,707 不能显示成 100%', () => {
    // Math.round(45479 / 45707 * 100) === 100 —— 这正是"仅完成 100%"的来源。
    expect(Math.round((45_479 / 45_707) * 100)).toBe(100)
    // 正确口径：保留 1 位小数，未完成时封顶 99.9。
    expect(imageTextProcessedPercent(45_479, 45_707)).toBe(99.5)
    expect(imageTextProcessedPercent(45_707, 45_707)).toBe(100)
    expect(imageTextProcessedPercent(0, 0)).toBe(0)
  })

  it('服务侧：一条都没成功时不给 complete，并把状态判成 failed', async () => {
    const databaseRoot = makeRoot()
    const databasePath = getImageTextIndexDatabasePath(databaseRoot, ACCOUNT)
    const store = new ImageTextIndexStore(databasePath, ACCOUNT)
    store.writeCountedTotal({ total: 100, countedAt: 1, complete: true })
    for (let index = 1; index <= 30; index += 1) {
      store.putBinding({
        accountId: ACCOUNT,
        conversationId: CONVERSATION,
        messageId: `local:${index}`,
        createTime: index,
        imageIdentity: '',
        artifactKey: `unavailable|${index}`,
        state: 'decrypt_failed',
        updatedAt: index
      })
    }
    store.close()

    const service = new ImageTextIndexService()
    service.bind({ databaseRoot, resolveAccountId: () => ACCOUNT })
    const status = await service.getStatus()

    expect(status.coverage.processed).toBe(30)
    expect(status.coverage.failed).toBe(30)
    expect(status.coverage.systemicFailure).toBe(true)
    expect(status.coverage.complete).toBe(false)
    expect(imageTextCoverageState(status.coverage)).toBe('failed')
    // 收干净句柄：Windows 上没关连接会让临时目录清理 EBUSY。
    service.resetAccount()
  })

  it('运行时不可用不计入 processed，并且阻断 complete', async () => {
    const databaseRoot = makeRoot()
    const databasePath = getImageTextIndexDatabasePath(databaseRoot, ACCOUNT)
    const store = new ImageTextIndexStore(databasePath, ACCOUNT)
    store.writeCountedTotal({ total: 10, countedAt: 1, complete: true })
    store.putBinding({
      accountId: ACCOUNT,
      conversationId: CONVERSATION,
      messageId: 'local:1',
      createTime: 1,
      imageIdentity: '',
      artifactKey: 'unavailable|1',
      state: 'decrypt_unavailable',
      updatedAt: 1
    })
    store.close()

    const service = new ImageTextIndexService()
    service.bind({ databaseRoot, resolveAccountId: () => ACCOUNT })
    const status = await service.getStatus()

    expect(status.coverage.runtimeUnavailable).toBe(1)
    expect(status.coverage.processed).toBe(0)
    expect(status.coverage.complete).toBe(false)
    service.resetAccount()
  })

  it('部分成功 + 部分图片缺失 → 仍然是正常的"部分完成"（不误判成异常）', () => {
    const coverage = coverageOf({
      totalImageMessages: 100,
      processed: 100,
      indexed: 60,
      empty: 20,
      missing: 20,
      established: true,
      countedAt: 1,
      complete: true,
      systemicFailure: false
    })
    expect(imageTextCoverageState(coverage)).toBe('complete')
    expect(describeImageTextCoverage(coverage)).toContain('已覆盖全部')
  })
})

describe('事故防线：前置依赖缺失时一条记录都不写', () => {
  it('解密服务不可用 → pass 直接报错，不写任何 binding', async () => {
    const databaseRoot = makeRoot()
    const databasePath = getImageTextIndexDatabasePath(databaseRoot, ACCOUNT)
    const service = new ImageTextIndexService()
    service.bind({
      databaseRoot,
      resolveAccountId: () => ACCOUNT,
      listContacts: async () => [
        { md5: CONVERSATION, m_nsUsrName: 'incident', type: 'group' as const }
      ],
      listMessages: async () => [imageMessage(1)],
      countConversationImages: async () => ({ count: 1, typeColumn: 'local_type' }),
      imageWatermark: async () => ({ count: 1, maxLocalId: 1 }),
      capability: async () => ({
        available: true,
        engine: 'windows-system-ocr',
        platform: 'win32',
        runtimeVersion: '1.2.0',
        language: 'zh-Hans-CN'
      }),
      // 关键：没有解密服务（本次事故的根因形态）
      decryptService: () => null
    })

    await service.startPass()
    await vi.waitFor(() => expect(service.isRunning()).toBe(false))

    const status = await service.getStatus()
    // 这一条就是整场事故的防线：宁可一次都不跑，也不要写 45,479 条假失败。
    expect(status.progress.state).toBe('error')
    expect(status.progress.lastError).toContain('解密服务')
    expect(status.coverage.processed).toBe(0)
    expect(status.coverage.failed).toBe(0)
    expect(status.coverage.runtimeUnavailable).toBe(0)

    const store = new ImageTextIndexStore(databasePath, ACCOUNT)
    expect(store.countByState()).toEqual({})
    store.close()
    service.resetAccount()
  })
})

describe('事故收尾：重置失败记录不能动成功记录', () => {
  it('只删失败绑定与它们的 checkpoint，indexed 一条不动', async () => {
    const databaseRoot = makeRoot()
    const databasePath = getImageTextIndexDatabasePath(databaseRoot, ACCOUNT)
    const store = new ImageTextIndexStore(databasePath, ACCOUNT)
    store.writeCountedTotal({ total: 3, countedAt: 1, complete: true })
    store.putArtifact({
      accountId: ACCOUNT,
      artifactKey: 'good|1',
      imageIdentity: 'sha256:good',
      state: 'indexed',
      text: 'TRACE_KEEP_ME',
      charCount: 13,
      engine: 'windows-system-ocr',
      platform: 'win32',
      runtimeVersion: '1.2.0',
      language: 'zh-Hans-CN',
      createdAt: 1,
      updatedAt: 1
    })
    store.putBinding({
      accountId: ACCOUNT,
      conversationId: CONVERSATION,
      messageId: 'local:1',
      createTime: 1,
      imageIdentity: 'sha256:good',
      artifactKey: 'good|1',
      state: 'indexed',
      updatedAt: 1
    })
    for (const id of [2, 3]) {
      store.putBinding({
        accountId: ACCOUNT,
        conversationId: CONVERSATION,
        messageId: `local:${id}`,
        createTime: id,
        imageIdentity: '',
        artifactKey: `bad|${id}`,
        state: 'decrypt_failed',
        updatedAt: id
      })
    }
    store.writeScanState({
      conversationId: CONVERSATION,
      state: 'done',
      imageTotal: 3,
      imageProcessed: 3,
      maxLocalId: 3
    })
    store.close()

    const service = new ImageTextIndexService()
    service.bind({ databaseRoot, resolveAccountId: () => ACCOUNT })
    const result = await service.resetRetriableFailures()
    expect(result.reset).toBe(2)

    // 成功记录与它的 artifact 必须原封不动。
    const after = new ImageTextIndexStore(databasePath, ACCOUNT)
    expect(after.countByState()).toEqual({ indexed: 1 })
    expect(after.getArtifact('good|1')?.text).toBe('TRACE_KEEP_ME')
    // checkpoint 也要清掉，否则下一轮会以"该会话已完成"直接跳过（点了重试却没反应）。
    expect(after.readScanState().size).toBe(0)
    after.close()
    service.resetAccount()
  })
})
