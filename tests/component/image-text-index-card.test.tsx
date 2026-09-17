/**
 * 「图片文字索引」卡片的用户可见行为。
 *
 * 这些断言对应的是产品需求里**写死的**交互契约，不是实现细节：
 * - 未建立时先给出检测到的图片消息数量，而不是一个空洞的按钮；
 * - 点击建立**必须先弹确认**，不允许立刻全量开跑；
 * - 确认弹窗要写清本机执行、原图不会因识别而自动上传、可暂停、实际可识别数量取决于本地文件；
 * - 进度只给真实数字（processed/total、识别出文字、没有文字、图片已清理、失败、百分比）；
 * - 暂停 / 继续 / 取消三个动作都在，且暂停后能继续；
 * - 重启后进度来自主进程快照（这里用「首帧就是 paused 快照」模拟）；
 * - 操作区是**单列堆叠**：这张卡最多并列 3 个操作，横向排会撑破窄侧栏。
 */
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ImageTextIndexCard } from '../../src/renderer/src/components/search/ImageTextIndexCard'
import type { ImageTextIndexStatus } from '../../src/shared/image-text-index'

function status(overrides: Partial<ImageTextIndexStatus> = {}): ImageTextIndexStatus {
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
    counting: false,
    ...overrides
  }
}

const notBuilt = status()

const running = status({
  progress: {
    state: 'running',
    totalImageMessages: 12_483,
    processed: 3842,
    indexed: 2917,
    empty: 412,
    missing: 378,
    failed: 135,
    pending: 8641,
    percent: 30.8,
    updatedAt: 1,
    cancellable: true,
    paused: false
  },
  coverage: {
    totalImageMessages: 12_483,
    processed: 3842,
    indexed: 2917,
    empty: 412,
    missing: 378,
    failed: 135,
    pending: 8641,
    established: true,
    complete: false,
    countedAt: 1
  }
})

const paused = status({
  ...running,
  progress: { ...running.progress, state: 'paused', cancellable: false, paused: true }
})

/** 取消：进度全部保留，但状态是 cancelled 而不是 paused。 */
const cancelled = status({
  ...running,
  progress: { ...running.progress, state: 'cancelled', cancellable: false, paused: false },
  coverage: { ...running.coverage, established: true }
})

/** 已建立但未完成：这张状态下操作区最多并列 3 个按钮（更新 / 重新统计 / 修复）。 */
const establishedPartial = status({
  ...running,
  progress: { ...running.progress, state: 'idle', cancellable: false },
  coverage: { ...running.coverage, established: true }
})

const api = {
  getImageTextIndexStatus: vi.fn(),
  countImageMessages: vi.fn(),
  startImageTextIndex: vi.fn(),
  pauseImageTextIndex: vi.fn(),
  resumeImageTextIndex: vi.fn(),
  cancelImageTextIndex: vi.fn(),
  resetImageTextIndexFailures: vi.fn(),
  repairImageTextIndex: vi.fn(),
  onImageTextIndexStatus: vi.fn(() => () => undefined)
}

let pushStatus: ((next: ImageTextIndexStatus) => void) | undefined

beforeEach(() => {
  vi.clearAllMocks()
  pushStatus = undefined
  api.getImageTextIndexStatus.mockResolvedValue(notBuilt)
  api.countImageMessages.mockResolvedValue({
    totalImageMessages: 12_483,
    scannedConversations: 42,
    durationMs: 30
  })
  api.startImageTextIndex.mockResolvedValue({ started: true, state: 'running' })
  api.pauseImageTextIndex.mockResolvedValue({ paused: true, state: 'paused' })
  api.resumeImageTextIndex.mockResolvedValue({ started: true, state: 'running' })
  api.cancelImageTextIndex.mockResolvedValue({ cancellable: true, cancelled: true })
  api.onImageTextIndexStatus.mockImplementation((callback: (next: ImageTextIndexStatus) => void) => {
    pushStatus = callback
    return () => undefined
  })
  Object.defineProperty(window, 'api', { configurable: true, value: api })
})

async function renderCard(): Promise<{ onNotice: ReturnType<typeof vi.fn> }> {
  const onNotice = vi.fn()
  await act(async () => {
    render(<ImageTextIndexCard dbReady onNotice={onNotice} />)
  })
  return { onNotice }
}

describe('图片文字索引卡片', () => {
  it('未建立时给出检测到的图片消息数量，而不是一个空洞的按钮', async () => {
    await renderCard()
    expect(screen.getByTestId('image-text-index-state').textContent).toBe('未建立')
    expect(screen.getByTestId('image-text-index-count').textContent).toBe('12,483')
    expect(screen.getByTestId('image-text-index-start').textContent).toBe('建立图片文字索引')
  })

  it('点击建立先弹确认，并把范围、隐私与不可控因素写清楚，确认前不启动', async () => {
    await renderCard()
    await userEvent.click(screen.getByTestId('image-text-index-start'))

    // Radix 的 AlertDialog 用的是 role="alertdialog"（不是 "dialog"）。
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toContain('12,483')
    expect(dialog.textContent).toContain('仅在本机进行识别')
    expect(dialog.textContent).toContain('不会因为本地识别而自动上传')
    expect(dialog.textContent).toContain('可以暂停并稍后继续')
    expect(dialog.textContent).toContain('取决于本地图片文件是否仍然存在')
    // 确认之前绝不允许开跑。
    expect(api.startImageTextIndex).not.toHaveBeenCalled()

    await userEvent.click(screen.getByTestId('image-text-index-confirm'))
    await vi.waitFor(() => expect(api.startImageTextIndex).toHaveBeenCalledTimes(1))
  })

  it('索引进度只给真实数字，并提供暂停与取消', async () => {
    api.getImageTextIndexStatus.mockResolvedValue(running)
    await renderCard()

    expect(screen.getByTestId('image-text-index-state').textContent).toBe('建立中 · 30.8%')
    expect(screen.getByTestId('image-text-index-progress').textContent).toBe('3,842 / 12,483')
    const passLine = screen.getByText(/识别出文字 2,917/)
    expect(passLine.textContent).toContain('识别出文字 2,917')
    expect(passLine.textContent).toContain('没有文字 412')
    expect(passLine.textContent).toContain('图片已清理 378')
    expect(passLine.textContent).toContain('失败 135')
    // 底层实现细节绝不外泄。
    expect(document.body.textContent).not.toMatch(/HRESULT|0x[0-9A-Fa-f]{8}/)

    await userEvent.click(screen.getByTestId('image-text-index-pause'))
    expect(api.pauseImageTextIndex).toHaveBeenCalledTimes(1)

    await userEvent.click(screen.getByTestId('image-text-index-cancel'))
    expect(api.cancelImageTextIndex).toHaveBeenCalledTimes(1)
  })

  it('运行中给出窗口速度与 ETA，而不是历史平均', async () => {
    api.getImageTextIndexStatus.mockResolvedValue({
      ...running,
      progress: {
        ...running.progress,
        speedPerSec: 38,
        etaMs: 2 * 60 * 60 * 1000 + 25 * 60 * 1000
      }
    })
    await renderCard()

    const rate = screen.getByTestId('image-text-index-rate')
    expect(rate.textContent).toContain('约 38.0 张/秒')
    expect(rate.textContent).toContain('2 小时 25 分')
    // 用户界面不出现开发指标。
    expect(rate.textContent).not.toMatch(/p50|p95|percentile/i)
  })

  it('速度样本不足时如实说「计算中」，不编数字', async () => {
    // 默认的 running 夹具没有 speedPerSec / etaMs（主进程给 null 的情形）。
    api.getImageTextIndexStatus.mockResolvedValue({
      ...running,
      progress: { ...running.progress, speedPerSec: null, etaMs: null }
    })
    await renderCard()

    const rate = screen.getByTestId('image-text-index-rate')
    expect(rate.textContent).toContain('当前速度：计算中')
    expect(rate.textContent).toContain('预计剩余：计算中')
  })

  it('暂停后可以继续，进度仍来自主进程快照', async () => {
    api.getImageTextIndexStatus.mockResolvedValue(paused)
    await renderCard()

    expect(screen.getByTestId('image-text-index-state').textContent).toBe('已暂停 · 30.8%')
    await userEvent.click(screen.getByTestId('image-text-index-resume'))
    expect(api.resumeImageTextIndex).toHaveBeenCalledTimes(1)
  })

  /**
   * 「取消」之后的入口曾经是缺失的：状态落回「部分完成」、按钮只剩「更新图片文字索引」，
   * 用户既看不出自己中断过，也找不到继续的地方 —— 于是以为进度丢了。
   * 取消和暂停一样保留 checkpoint，所以必须给同样的「继续」。
   */
  it('取消之后仍然能继续：状态说「已取消」，「继续」入口还在', async () => {
    api.getImageTextIndexStatus.mockResolvedValue(cancelled)
    await renderCard()

    expect(screen.getByTestId('image-text-index-state').textContent).toMatch(/^已取消 · /)
    const resume = screen.getByTestId('image-text-index-resume')
    expect(resume.textContent).toBe('继续')
    // 「更新图片文字索引」和「继续」是同一件事，不能同时抢位。
    expect(screen.queryByTestId('image-text-index-start')).toBeNull()
    // 已经取消了，没有东西可再取消。
    expect(screen.queryByTestId('image-text-index-cancel')).toBeNull()

    await userEvent.click(resume)
    expect(api.resumeImageTextIndex).toHaveBeenCalledTimes(1)
  })

  it('主进程推送真实进度后，卡片跟着更新（重启后恢复的进度同一条路径）', async () => {
    await renderCard()
    expect(screen.getByTestId('image-text-index-state').textContent).toBe('未建立')

    await act(async () => {
      pushStatus?.(running)
    })
    expect(screen.getByTestId('image-text-index-state').textContent).toBe('建立中 · 30.8%')
    expect(screen.getByTestId('image-text-index-progress').textContent).toBe('3,842 / 12,483')
  })

  it('统计失败时显示「无法统计」而不是 0，并给出原因', async () => {
    api.countImageMessages.mockResolvedValue({
      totalImageMessages: 0,
      scannedConversations: 0,
      failedConversations: 7,
      typeColumn: null,
      error: '读取消息分片失败',
      durationMs: 5
    })
    await renderCard()

    const value = screen.getByTestId('image-text-index-count')
    expect(value.textContent).toBe('无法统计')
    // 这是最关键的一条：绝不能把"数不出来"显示成 0。
    expect(value.textContent).not.toBe('0')

    const error = screen.getByTestId('image-text-index-count-error')
    expect(error.textContent).toContain('读取消息分片失败')
    expect(error.textContent).toContain('不代表账号里没有图片')
    // 「重新统计」入口已收掉：进度改用流水线真实走过的集合之后，
    // 重算那个预估值不再影响任何东西，留着只会多一个看不懂的按钮。
    // 断言按**用户可见文案**而不是已删除的 testid —— 对已移除 testid 断言
    // 「不存在」是恒真的，删掉按钮之后它就再也测不出任何东西。
    expect(screen.queryByText('重新统计')).not.toBeInTheDocument()
  })

  /**
   * 操作区布局契约：主按钮与「更多」各占一行。
   *
   * 修复类操作（修复搜索索引 / 重试失败的图片）收进了「更多」菜单 ——
   * 平铺出来时，用户看到的是几个都在说「索引」的按钮，只能靠猜哪个该点。
   *
   * jsdom 不做真实排版，所以这里锁的是**能推出该结果的结构**：
   * 两个按钮是同一个操作容器的直接子元素，且该容器带单列堆叠修饰类
   * （共享的栅格类 + `ai-search-image-index-actions`，后者把 grid 覆盖成 flex column）。
   * 一旦有人在按钮外面套一层 wrapper、或去掉修饰类，这个测试就会失败。
   */
  it('操作区只留主按钮与「更多」：同一容器的直接子元素，顺序为 更新 / 更多', async () => {
    api.getImageTextIndexStatus.mockResolvedValue(establishedPartial)
    api.countImageMessages.mockResolvedValue({
      totalImageMessages: 12_483,
      scannedConversations: 42,
      failedConversations: 1,
      typeColumn: 'local_type',
      durationMs: 30
    })
    await renderCard()

    const start = screen.getByTestId('image-text-index-start')
    const more = screen.getByTestId('image-text-index-more')

    expect(start.textContent).toBe('更新图片文字索引')
    expect(more.textContent).toBe('更多')

    const container = start.parentElement
    expect(container).toBe(more.parentElement)
    expect(container?.classList.contains('ai-search-knowledge-actions')).toBe(true)
    expect(container?.classList.contains('ai-search-image-index-actions')).toBe(true)

    // 直接子元素 == 独占一行；顺序断言同时锁住视觉顺序。
    expect(Array.from(container?.children ?? [])).toEqual([start, more])
  })

  it('部分会话统计失败时给出真实数字并提示偏小', async () => {
    api.countImageMessages.mockResolvedValue({
      totalImageMessages: 420,
      scannedConversations: 30,
      failedConversations: 2,
      typeColumn: 'local_type',
      durationMs: 9
    })
    await renderCard()

    expect(screen.getByTestId('image-text-index-count').textContent).toBe('420')
    expect(screen.getByTestId('image-text-index-count-error').textContent).toContain(
      '2 个会话未能统计'
    )
  })

  it('真的没有图片时才显示 0，且不出现失败提示', async () => {
    api.countImageMessages.mockResolvedValue({
      totalImageMessages: 0,
      scannedConversations: 12,
      failedConversations: 0,
      typeColumn: 'local_type',
      durationMs: 4
    })
    await renderCard()

    expect(screen.getByTestId('image-text-index-count').textContent).toBe('0')
    expect(screen.queryByTestId('image-text-index-count-error')).not.toBeInTheDocument()
    // 同上：按文案断言，避免对已删除的 testid 做恒真断言。
    expect(screen.queryByText('重新统计')).not.toBeInTheDocument()
  })
})

/**
 * 派生索引修复按钮的存在意义就是"别为修一个索引问题重跑几万张图"。
 *
 * 因此这里断言的重点是**措辞**：用户看到"修复"两个字必须能确信
 * 不会又要等一小时 —— 否则这个按钮没人敢点，功能等于不存在。
 */
describe('图片文字索引卡片 — 修复图片搜索索引', () => {
  const established = status({
    progress: {
      state: 'idle',
      totalImageMessages: 45_740,
      processed: 45_508,
      indexed: 14_342,
      empty: 31_126,
      missing: 38,
      failed: 2,
      pending: 232,
      percent: 99.5,
      updatedAt: 1,
      cancellable: false,
      paused: false
    },
    coverage: {
      totalImageMessages: 45_740,
      processed: 45_508,
      indexed: 14_342,
      empty: 31_126,
      missing: 38,
      failed: 2,
      pending: 232,
      established: true,
      complete: false,
      countedAt: 1,
      runtimeUnavailable: 0,
      systemicFailure: false
    }
  } as Partial<ImageTextIndexStatus>)

  it('已建立且空闲时，修复入口收在「更多」里，点击后才调用主进程', async () => {
    api.getImageTextIndexStatus.mockResolvedValue(established)
    api.repairImageTextIndex.mockResolvedValue({
      conversations: 12,
      ocrExecutions: 0,
      durationMs: 800,
      skipped: false
    })
    const { onNotice } = await renderCard()

    // 修复类操作不再平铺在操作区，必须先展开「更多」。
    expect(screen.queryByTestId('image-text-index-repair')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('image-text-index-more'))

    const item = await screen.findByTestId('image-text-index-repair')
    expect(item.textContent).toContain('修复搜索索引')
    expect(api.repairImageTextIndex).not.toHaveBeenCalled()

    await userEvent.click(item)

    expect(api.repairImageTextIndex).toHaveBeenCalledTimes(1)
    // 提示语必须讲清楚"没有重新识别"，否则用户会以为又要跑几万张图。
    expect(String(onNotice.mock.calls.at(-1)?.[0])).toContain('没有重新识别任何图片')
    expect(String(onNotice.mock.calls.at(-1)?.[0])).toContain('12')
  })

  it('索引正在跑时不提供修复入口（并发重建会读到半程状态）', async () => {
    api.getImageTextIndexStatus.mockResolvedValue(running)
    await renderCard()

    expect(screen.queryByTestId('image-text-index-more')).not.toBeInTheDocument()
    expect(screen.queryByTestId('image-text-index-repair')).not.toBeInTheDocument()
  })

  it('主进程拒绝并发修复时如实告知，不谎称已修复', async () => {
    api.getImageTextIndexStatus.mockResolvedValue(established)
    api.repairImageTextIndex.mockResolvedValue({
      conversations: 0,
      ocrExecutions: 0,
      durationMs: 0,
      skipped: true
    })
    const { onNotice } = await renderCard()

    await userEvent.click(screen.getByTestId('image-text-index-more'))
    await userEvent.click(await screen.findByTestId('image-text-index-repair'))

    expect(String(onNotice.mock.calls.at(-1)?.[0])).toContain('正在进行中')
  })
})
