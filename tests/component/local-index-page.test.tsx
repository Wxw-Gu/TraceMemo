import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalIndexPage } from '../../src/renderer/src/features/settings/pages/LocalIndexPage'

const NOW = Date.now()
const DAY = 24 * 60 * 60 * 1000

const knowledgeStatus = (overrides: Record<string, unknown> = {}) => ({
  accountId: 'acct',
  state: 'ready',
  indexedMessageCount: 2_517_181,
  indexedChunkCount: 9000,
  sourceMessageCount: 2_517_181,
  processedMessages: 2_517_181,
  totalMessages: 2_517_181,
  estimatedRemainingMs: null,
  databaseBytes: 6.4 * 1024 ** 3,
  walBytes: 0,
  shmBytes: 0,
  indexLatestAt: NOW,
  sourceLatestAt: NOW,
  ...overrides
})

const imageStatus = (overrides: Record<string, unknown> = {}) => ({
  progress: {
    state: 'idle',
    processed: 349_263,
    totalImageMessages: 349_263,
    percent: 100,
    indexed: 57_078,
    empty: 74_816,
    missing: 184_805,
    failed: 8
  },
  coverage: {
    // `established` / `complete` 是状态判定的两个开关
    // （`imageTextCoverageState`：!established→not_built，complete 才→complete）。
    // 漏任一个，卡片都会停在别的分支上。
    established: true,
    complete: true,
    indexed: 57_078,
    empty: 74_816,
    missing: 184_805,
    failed: 8,
    processed: 349_263,
    totalImageMessages: 349_263,
    systemicFailure: false,
    tiers: []
  },
  storage: {},
  counting: false,
  ...overrides
})

let api: Record<string, ReturnType<typeof vi.fn>>

beforeEach(() => {
  api = {
    getKnowledgeStatus: vi.fn().mockResolvedValue(knowledgeStatus()),
    onKnowledgeStatus: vi.fn(() => () => undefined),
    startKnowledgeIndex: vi.fn().mockResolvedValue(knowledgeStatus({ state: 'syncing' })),
    cancelKnowledgeIndex: vi.fn().mockResolvedValue({ cancellable: true, cancelled: true }),
    getImageTextIndexStatus: vi.fn().mockResolvedValue(imageStatus()),
    onImageTextIndexStatus: vi.fn(() => () => undefined),
    countImageMessages: vi.fn().mockResolvedValue({
      totalImageMessages: 349_263,
      scannedConversations: 1375,
      failedConversations: 0
    }),
    startImageTextIndex: vi.fn().mockResolvedValue(imageStatus()),
    pauseImageTextIndex: vi.fn().mockResolvedValue(imageStatus()),
    resumeImageTextIndex: vi.fn().mockResolvedValue(imageStatus()),
    cancelImageTextIndex: vi.fn().mockResolvedValue(imageStatus()),
    resetImageTextIndexFailures: vi.fn().mockResolvedValue(imageStatus()),
    repairImageTextIndex: vi.fn().mockResolvedValue(imageStatus())
  }
  ;(window as unknown as { api: Record<string, unknown> }).api = api
})

const renderPage = (dbReady = true) =>
  render(<LocalIndexPage dbReady={dbReady} onNotice={vi.fn()} />)

describe('LocalIndexPage · 信息层级', () => {
  it('页面标题与两处索引卡片都在', async () => {
    renderPage()

    expect(screen.getByRole('heading', { name: '本地索引' })).toBeTruthy()
    await waitFor(() => expect(screen.getByRole('heading', { name: '聊天记录索引' })).toBeTruthy())
    expect(screen.getByRole('heading', { name: '图片文字索引' })).toBeTruthy()
  })

  it('聊天记录索引显示三个核心数字', async () => {
    renderPage()

    await waitFor(() => expect(screen.getByText('2,517,181')).toBeTruthy())
    expect(screen.getByText('已收录消息')).toBeTruthy()
    expect(screen.getByText('6.4 GB')).toBeTruthy()
    expect(screen.getByText('占用空间')).toBeTruthy()
    expect(screen.getByText('最后更新')).toBeTruthy()
  })

  it('图片文字索引显示四个 metric', async () => {
    renderPage()

    await waitFor(() => expect(screen.getByText('57,078')).toBeTruthy())
    expect(screen.getByText('已识别文字')).toBeTruthy()
    expect(screen.getByText('74,816')).toBeTruthy()
    expect(screen.getByText('无文字图片')).toBeTruthy()
    expect(screen.getByText('184,805')).toBeTruthy()
    expect(screen.getByText('图片已清理')).toBeTruthy()
    expect(screen.getByText('8')).toBeTruthy()
    expect(screen.getByText('识别失败')).toBeTruthy()
  })
})

describe('LocalIndexPage · 状态徽章', () => {
  it('索引追平时显示「可用 · 已追至最新」', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('可用 · 已追至最新')).toBeTruthy())
  })

  it('索引落后时显示「可用 · 待追新」', async () => {
    api.getKnowledgeStatus.mockResolvedValue(
      knowledgeStatus({ indexLatestAt: NOW - 3 * DAY, sourceLatestAt: NOW })
    )
    renderPage()

    await waitFor(() => expect(screen.getByText('可用 · 待追新')).toBeTruthy())
  })

  it('图片索引完成后显示「已完成」', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('已完成')).toBeTruthy())
  })
})

describe('LocalIndexPage · 运行态与进度', () => {
  it('图片索引运行中：显示进度条与暂停/取消，不再显示主操作按钮', async () => {
    api.getImageTextIndexStatus.mockResolvedValue(
      imageStatus({
        progress: {
          state: 'running',
          processed: 184_235,
          totalImageMessages: 349_263,
          percent: 52,
          indexed: 1_000,
          empty: 500,
          missing: 0,
          failed: 0
        }
      })
    )
    renderPage()

    expect(await screen.findByRole('progressbar')).toBeTruthy()
    expect(screen.getByText('184,235 / 349,263')).toBeTruthy()
    expect(screen.getByRole('button', { name: '暂停' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '取消' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '更新索引' })).toBeNull()
  })
})

describe('LocalIndexPage · 操作绑定与禁用', () => {
  it('「同步最新记录」仍然走原来的 startKnowledgeIndex', async () => {
    renderPage()
    const button = await screen.findByRole('button', { name: '同步最新记录' })

    const user = userEvent.setup()
    await user.click(button)

    await waitFor(() => expect(api.startKnowledgeIndex).toHaveBeenCalled())
  })

  it('数据库未连接时主按钮禁用并给出提示', async () => {
    renderPage(false)

    await waitFor(() => expect(screen.getByText('请先连接微信数据，然后再建立聊天记录索引。')).toBeTruthy())
    expect((screen.getByRole('button', { name: '同步最新记录' }) as HTMLButtonElement).disabled).toBe(
      true
    )
  })

  it('「···」菜单里的修复动作仍绑定原逻辑', async () => {
    renderPage()
    const more = await screen.findByRole('button', { name: '更多操作' })

    const user = userEvent.setup()
    await user.click(more)
    await user.click(await screen.findByText('图片内容搜不到？修复搜索索引'))

    await waitFor(() => expect(api.repairImageTextIndex).toHaveBeenCalled())
  })
})
