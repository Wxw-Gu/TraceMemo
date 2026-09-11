import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AISearchWorkspace } from '../../src/renderer/src/components/search/AISearchWorkspace'
import {
  SEARCH_CACHE_KEY,
  SEARCH_HISTORY_KEY
} from '../../src/renderer/src/components/search/searchUtils'
import { decodeMessageRef } from '../../src/shared/local-query-api'
import {
  aiSearchContact,
  aiSearchGroup,
  makeCacheRecord,
  makePipelineEvidence,
  makeSearchResult
} from './support/ai-search-fixtures'

const api = {
  getSettings: vi.fn(),
  getAppLogPath: vi.fn(),
  getKnowledgeStatus: vi.fn(),
  onKnowledgeStatus: vi.fn(),
  onAiSearchProgress: vi.fn(),
  getAiSearchProviderStatus: vi.fn(),
  authorizeAiSearchExternalProvider: vi.fn(),
  runAiSearch: vi.fn(),
  cancelAiSearch: vi.fn(),
  startKnowledgeIndex: vi.fn(),
  writeAppLog: vi.fn(),
  revealAppLog: vi.fn(),
  copyText: vi.fn()
}

const readyKnowledgeStatus = {
  accountId: 'fixture-account',
  state: 'ready' as const,
  indexedMessageCount: 20,
  indexedChunkCount: 4,
  sourceMessageCount: 20,
  processedMessages: 20,
  totalMessages: 20,
  estimatedRemainingMs: null,
  databaseBytes: 128,
  walBytes: 64,
  shmBytes: 32
}

let progressListener: ((progress: Record<string, unknown>) => void) | undefined
let knowledgeUnsubscribe: ReturnType<typeof vi.fn>
let progressUnsubscribe: ReturnType<typeof vi.fn>

const makeProps = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  contacts: [aiSearchContact, aiSearchGroup],
  selectedContact: aiSearchContact,
  dbReady: true,
  aiModelConfig: {
    configured: true,
    providerName: 'Fixture Provider',
    model: 'fixture-model',
    modelName: 'Fixture Model',
    status: 'connected' as const
  },
  onSelectContact: vi.fn(),
  onOpenEvidence: vi.fn(),
  onOpenAISettings: vi.fn(),
  onNotice: vi.fn(),
  ...overrides
})

const renderWorkspace = (overrides: Record<string, unknown> = {}): ReturnType<typeof render> =>
  render(<AISearchWorkspace {...(makeProps(overrides) as never)} />)

const submitQuery = async (query = '测试搜索问题'): Promise<ReturnType<typeof userEvent.setup>> => {
  const user = userEvent.setup()
  await user.type(screen.getByRole('textbox'), query)
  await user.click(screen.getByRole('button', { name: /开始分析/ }))
  return user
}

const emitProgress = async (progress: Record<string, unknown>): Promise<void> => {
  await act(async () => {
    progressListener?.(progress)
  })
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  vi.clearAllMocks()
  progressListener = undefined
  knowledgeUnsubscribe = vi.fn()
  progressUnsubscribe = vi.fn()
  Object.defineProperty(window, 'api', { configurable: true, value: api })

  api.getSettings.mockResolvedValue({ settings: { debugEnabled: false } })
  api.getAppLogPath.mockResolvedValue('')
  api.getKnowledgeStatus.mockResolvedValue(readyKnowledgeStatus)
  api.onKnowledgeStatus.mockImplementation(() => knowledgeUnsubscribe)
  api.onAiSearchProgress.mockImplementation((listener: typeof progressListener) => {
    progressListener = listener
    return progressUnsubscribe
  })
  api.getAiSearchProviderStatus.mockResolvedValue({
    configured: true,
    requiresConsent: false
  })
  api.authorizeAiSearchExternalProvider.mockResolvedValue({ success: true })
  api.cancelAiSearch.mockResolvedValue({ cancelled: true })
  api.startKnowledgeIndex.mockResolvedValue(readyKnowledgeStatus)
  api.writeAppLog.mockResolvedValue(undefined)
  api.revealAppLog.mockResolvedValue(undefined)
  api.copyText.mockResolvedValue({ success: true })
  api.runAiSearch.mockResolvedValue(makeSearchResult())
})

describe('AISearchWorkspace regression coverage before decomposition', () => {
  it('preserves conversation scope, conversationId, range and the UI time override in a Search Request', async () => {
    renderWorkspace()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /当前会话/ }))
    await user.click(screen.getByRole('button', { name: '近 30 天' }))
    await submitQuery('我和测试会话最近聊了什么')

    await screen.findByText('测试搜索答案')
    expect(api.runAiSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '我和测试会话最近聊了什么',
        scope: 'conversation',
        conversationId: aiSearchContact.md5,
        range: '30d',
        timeRangeOverride: expect.objectContaining({
          label: '近 30 天',
          source: 'user_selected'
        })
      })
    )
  })

  it('guards duplicate submissions while the current Search Request is still running', async () => {
    let resolveSearch: ((value: unknown) => void) | undefined
    api.runAiSearch.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSearch = resolve
        })
    )
    renderWorkspace()
    const user = await submitQuery()
    const form = screen.getByRole('textbox').closest('form') as HTMLFormElement
    fireEvent.submit(form)
    fireEvent.submit(form)
    expect(api.runAiSearch).toHaveBeenCalledOnce()

    resolveSearch?.(makeSearchResult({ requestId: api.runAiSearch.mock.calls[0][0].requestId }))
    await screen.findByText('测试搜索答案')
    expect(screen.getByRole('button', { name: '新问题' })).toBeInTheDocument()
    void user
  })

  it('keeps result actions and model settings callbacks unchanged after UI migration', async () => {
    const onOpenAISettings = vi.fn()
    const user = userEvent.setup()
    const view = renderWorkspace({ onOpenAISettings })
    await submitQuery()
    await screen.findByText('测试搜索答案')

    await user.click(screen.getByRole('button', { name: '复制摘要' }))
    expect(api.copyText).toHaveBeenCalledWith('测试搜索答案')

    view.rerender(
      <AISearchWorkspace
        {...(makeProps({
          onOpenAISettings,
          aiModelConfig: {
            configured: false,
            providerName: '',
            model: '',
            modelName: '',
            status: 'unconfigured' as const
          }
        }) as never)}
      />
    )
    await user.click(screen.getByRole('button', { name: '配置模型' }))
    expect(onOpenAISettings).toHaveBeenCalledOnce()
  })

  it('exposes the diagnostics action as an expanded control and keeps log access unchanged', async () => {
    api.getSettings.mockResolvedValue({ settings: { debugEnabled: true } })
    api.getAppLogPath.mockResolvedValue('/fixture/app.log')
    renderWorkspace()
    const user = userEvent.setup()
    const diagnostics = await screen.findByRole('button', { name: '诊断日志' })

    expect(diagnostics).toHaveAttribute('aria-expanded', 'false')
    await user.click(diagnostics)
    expect(diagnostics).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('/fixture/app.log')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '打开日志文件夹' }))
    expect(api.revealAppLog).toHaveBeenCalledOnce()
  })

  it('renders a failed retrieval without producing a Summary', async () => {
    api.runAiSearch.mockResolvedValue(
      makeSearchResult({
        status: 'failed',
        error: 'Knowledge Worker 失败',
        errorStage: 'knowledge_searching'
      })
    )
    renderWorkspace()
    await submitQuery()

    expect(await screen.findByText('Knowledge Worker 失败')).toBeInTheDocument()
    expect(screen.queryByText('测试搜索答案')).not.toBeInTheDocument()
  })

  it('renders an AI failure as partial evidence without treating it as a successful Summary', async () => {
    api.runAiSearch.mockResolvedValue(
      makeSearchResult({
        status: 'ai_failed',
        error: 'Provider 返回 429',
        evidence: [makePipelineEvidence(1)]
      })
    )
    renderWorkspace()
    await submitQuery()

    expect(await screen.findByText('证据已找到，但 AI 暂时无法生成回答')).toBeInTheDocument()
    expect(screen.getByText('E1 · 发送者 1')).toBeInTheDocument()
    expect(screen.queryByText('测试搜索答案')).not.toBeInTheDocument()
  })

  it.each([
    ['no_evidence', '近 30 天内没有找到与问题相关的聊天消息。'],
    ['retrieval_incomplete', '证据已就绪'],
    ['failed', '本地检索失败'],
    ['ai_failed', '证据已找到，但 AI 暂时无法生成回答']
  ] as const)('does not persist History or Cache for %s', async (status, expectedText) => {
    api.runAiSearch.mockResolvedValue(
      makeSearchResult({
        status,
        error: status === 'no_evidence' ? '应被忽略' : expectedText,
        evidence: [makePipelineEvidence(1)]
      })
    )
    renderWorkspace()
    await submitQuery(`${status} 问题`)

    expect(await screen.findByText(expectedText)).toBeInTheDocument()
    expect(localStorage.getItem(SEARCH_HISTORY_KEY)).toBeNull()
    expect(localStorage.getItem(SEARCH_CACHE_KEY)).toBeNull()
    expect(sessionStorage.length).toBe(0)
  })

  it('applies common Evidence state before rejecting a completed result without an answer', async () => {
    api.runAiSearch.mockResolvedValue({
      ...makeSearchResult({ evidence: [makePipelineEvidence(1)] }),
      answer: undefined
    })
    renderWorkspace()
    await submitQuery('缺少回答')

    expect(await screen.findByText('搜索任务未返回回答')).toBeInTheDocument()
    expect(screen.getByText('E1 · 发送者 1')).toBeInTheDocument()
    expect(localStorage.getItem(SEARCH_HISTORY_KEY)).toBeNull()
    expect(localStorage.getItem(SEARCH_CACHE_KEY)).toBeNull()
  })

  it('keeps an explicitly empty Evidence Collection separate from Final Evidence', async () => {
    api.runAiSearch.mockResolvedValue(
      makeSearchResult({ evidence: [makePipelineEvidence(1)], evidenceCollection: [] })
    )
    renderWorkspace()
    await submitQuery('空浏览集合')

    expect(await screen.findByText('测试搜索答案')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'E1' })).toBeInTheDocument()
    expect(screen.queryByText('E1 · 发送者 1')).not.toBeInTheDocument()
    expect(screen.getByText('等待检索结果')).toBeInTheDocument()
  })

  it('handles an IPC rejection from the Search Worker as an insufficient result', async () => {
    api.runAiSearch.mockRejectedValue(new Error('Worker IPC 连接断开'))
    renderWorkspace()
    await submitQuery()

    expect(await screen.findByText('Worker IPC 连接断开')).toBeInTheDocument()
    expect(screen.getByText('检索反馈')).toBeInTheDocument()
  })

  it.each([0, 1, 8])('keeps stable E numbering for %s Final Evidence items', async (count) => {
    const evidence = Array.from({ length: count }, (_, index) => makePipelineEvidence(index + 1))
    api.runAiSearch.mockResolvedValue(makeSearchResult({ evidence }))
    renderWorkspace()
    await submitQuery(`证据数量 ${count}`)

    if (count === 0) {
      expect(await screen.findByText('等待检索结果')).toBeInTheDocument()
      return
    }
    await screen.findByText(`E1 · 发送者 1`)
    expect(screen.getByText(`E${count} · 发送者 ${count}`)).toBeInTheDocument()
    expect(screen.queryByText(`E${count + 1} · 发送者 ${count + 1}`)).not.toBeInTheDocument()
  })

  it('loads more Evidence from the current collection without calling runAiSearch again', async () => {
    const evidenceCollection = Array.from({ length: 9 }, (_, index) =>
      makePipelineEvidence(index + 1)
    )
    api.runAiSearch.mockResolvedValue(
      makeSearchResult({ evidence: evidenceCollection.slice(0, 8), evidenceCollection })
    )
    renderWorkspace()
    await submitQuery()
    await screen.findByText('E8 · 发送者 8')
    expect(api.runAiSearch).toHaveBeenCalledOnce()

    await userEvent.click(screen.getByRole('button', { name: '加载更多证据' }))
    expect(screen.getByText('E9 · 发送者 9')).toBeInTheDocument()
    expect(api.runAiSearch).toHaveBeenCalledOnce()
  })

  it('passes the whole Evidence item with a decodable stable reference to the conversation jump callback', async () => {
    const onOpenEvidence = vi.fn()
    const item = makePipelineEvidence(1, aiSearchContact)
    api.runAiSearch.mockResolvedValue(makeSearchResult({ evidence: [item] }))
    renderWorkspace({ onOpenEvidence })
    await submitQuery()
    await screen.findByText('E1 · 发送者 1')

    await userEvent.click(screen.getByRole('button', { name: '跳转到原聊天 ↗' }))

    // 跳转必须拿到**稳定身份**（messageRef），而不是只靠"会话 + 秒级时间戳"猜位置：
    // 秒级时间无法定位同秒多条消息，也会因为 contact.md5 是合成 key 而跳错会话。
    expect(onOpenEvidence).toHaveBeenCalledTimes(1)
    const passed = onOpenEvidence.mock.calls[0][0] as {
      messageRef?: string
      contact: { md5: string }
    }
    expect(passed.contact.md5).toBe(aiSearchContact.md5)
    expect(decodeMessageRef(passed.messageRef)).toEqual({
      conversationId: aiSearchContact.md5,
      messageId: item.messageId
    })
  })

  it('clears the previous request Evidence before a refreshed request completes', async () => {
    const firstEvidence = makePipelineEvidence(1)
    const secondEvidence = makePipelineEvidence(2)
    let resolveSecond: ((value: unknown) => void) | undefined
    api.runAiSearch
      .mockResolvedValueOnce(makeSearchResult({ evidence: [firstEvidence] }))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve
          })
      )
    renderWorkspace()
    const user = await submitQuery('第一轮问题')
    await screen.findByText('E1 · 发送者 1')
    await user.click(screen.getByRole('button', { name: '刷新数据' }))

    await waitFor(() => expect(api.runAiSearch).toHaveBeenCalledTimes(2))
    expect(screen.queryByText('E1 · 发送者 1')).not.toBeInTheDocument()
    resolveSecond?.(
      makeSearchResult({
        requestId: api.runAiSearch.mock.calls[1][0].requestId,
        evidence: [secondEvidence]
      })
    )
    expect(await screen.findByText('E2 · 发送者 2')).toBeInTheDocument()
  })

  it('updates Progress and Agent Trace for the active request only', async () => {
    let resolveSearch: ((value: unknown) => void) | undefined
    api.runAiSearch.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSearch = resolve
        })
    )
    renderWorkspace()
    await submitQuery()
    const requestId = api.runAiSearch.mock.calls[0][0].requestId as string

    await emitProgress({
      requestId,
      stage: 'search_plan_ready',
      status: 'running',
      message: '正在生成搜索计划',
      plan: makeSearchResult().plan,
      agentTrace: {
        sequence: 1,
        event: 'agentDecision',
        label: '使用受控检索'
      }
    })
    expect(screen.getByText('正在生成搜索计划')).toBeInTheDocument()
    expect(screen.getByText(/使用受控检索/)).toBeInTheDocument()

    await emitProgress({
      requestId: 'stale-request',
      stage: 'ai_generating',
      status: 'running',
      message: '不应显示的旧请求进度'
    })
    expect(screen.queryByText('不应显示的旧请求进度')).not.toBeInTheDocument()

    resolveSearch?.(makeSearchResult({ requestId, agentTrace: [] }))
    await screen.findByText('测试搜索答案')
    expect(screen.queryByText('不应显示的旧请求进度')).not.toBeInTheDocument()
  })

  it('clears Progress and Agent Trace when an active request is cancelled', async () => {
    api.runAiSearch.mockImplementation(() => new Promise(() => undefined))
    renderWorkspace()
    await submitQuery()
    const requestId = api.runAiSearch.mock.calls[0][0].requestId as string
    await emitProgress({
      requestId,
      stage: 'knowledge_searching',
      status: 'running',
      message: '正在读取知识库'
    })
    expect(screen.getByText('正在读取知识库')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /取消分析/ }))
    expect(api.cancelAiSearch).toHaveBeenCalledWith(requestId)
    expect(screen.queryByText('正在读取知识库')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /开始分析/ })).toBeEnabled()
  })

  it('requires consent before the provider request and authorizes successfully', async () => {
    api.getAiSearchProviderStatus.mockResolvedValue({
      configured: true,
      requiresConsent: true,
      providerId: 'remote-provider',
      providerName: 'Remote Provider',
      recipient: 'remote@example.test'
    })
    api.runAiSearch.mockResolvedValue(makeSearchResult())
    renderWorkspace()
    await submitQuery()
    expect(await screen.findByRole('dialog', { name: '确认发送本次搜索资料' })).toBeInTheDocument()
    expect(api.runAiSearch).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: '继续并发送' }))
    await screen.findByText('测试搜索答案')
    expect(api.authorizeAiSearchExternalProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'remote-provider',
        recipient: 'remote@example.test'
      })
    )
    expect(api.runAiSearch).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog', { name: '确认发送本次搜索资料' })).not.toBeInTheDocument()
  })

  it('settles duplicate consent submissions without starting duplicate provider flows', async () => {
    api.getAiSearchProviderStatus.mockResolvedValue({
      configured: true,
      requiresConsent: true,
      providerId: 'remote-provider',
      providerName: 'Remote Provider',
      recipient: 'remote@example.test'
    })
    api.runAiSearch.mockResolvedValue(makeSearchResult())
    renderWorkspace()
    const user = userEvent.setup()
    await user.type(screen.getByRole('textbox'), '重复授权问题')
    const form = screen.getByRole('textbox').closest('form') as HTMLFormElement

    fireEvent.submit(form)
    await screen.findByRole('dialog', { name: '确认发送本次搜索资料' })
    fireEvent.submit(form)
    await waitFor(() => expect(api.getAiSearchProviderStatus).toHaveBeenCalledTimes(2))
    await screen.findByRole('dialog', { name: '确认发送本次搜索资料' })

    await user.click(screen.getByRole('button', { name: '继续并发送' }))
    await screen.findByText('测试搜索答案')
    expect(api.authorizeAiSearchExternalProvider).toHaveBeenCalledOnce()
    expect(api.runAiSearch).toHaveBeenCalledOnce()
  })

  it('does not start Search when the user rejects consent', async () => {
    api.getAiSearchProviderStatus.mockResolvedValue({
      configured: true,
      requiresConsent: true,
      providerId: 'remote-provider',
      recipient: 'remote@example.test'
    })
    const onNotice = vi.fn()
    renderWorkspace({ onNotice })
    await submitQuery()
    await userEvent.click(screen.getByRole('button', { name: '取消' }))

    expect(api.authorizeAiSearchExternalProvider).not.toHaveBeenCalled()
    expect(api.runAiSearch).not.toHaveBeenCalled()
    expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('未执行检索'))
  })

  it('handles provider status errors without leaving a Consent Dialog or starting Search', async () => {
    api.getAiSearchProviderStatus.mockRejectedValue(new Error('Provider 状态读取失败'))
    const onNotice = vi.fn()
    renderWorkspace({ onNotice })
    await submitQuery()

    await waitFor(() => expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('未执行')))
    expect(api.authorizeAiSearchExternalProvider).not.toHaveBeenCalled()
    expect(api.runAiSearch).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: '确认发送本次搜索资料' })).not.toBeInTheDocument()
  })

  it('closes the consent resolver when the active Search is cancelled after authorization', async () => {
    api.getAiSearchProviderStatus.mockResolvedValue({
      configured: true,
      requiresConsent: true,
      providerId: 'remote-provider',
      recipient: 'remote@example.test'
    })
    api.runAiSearch.mockImplementation(() => new Promise(() => undefined))
    renderWorkspace()
    await submitQuery()
    await userEvent.click(screen.getByRole('button', { name: '继续并发送' }))
    await screen.findByRole('button', { name: /取消分析/ })
    await userEvent.click(screen.getByRole('button', { name: /取消分析/ }))

    expect(screen.queryByRole('dialog', { name: '确认发送本次搜索资料' })).not.toBeInTheDocument()
    expect(api.cancelAiSearch).toHaveBeenCalledOnce()
  })

  it('restores a cached history query with its original conversation scope and range', async () => {
    const query = '恢复群聊历史'
    localStorage.setItem(
      SEARCH_CACHE_KEY,
      JSON.stringify([
        makeCacheRecord({
          query,
          scope: 'conversation',
          contactMd5: aiSearchContact.md5,
          range: 'all',
          answer: '恢复后的答案',
          evidence: [makePipelineEvidence(1)]
        })
      ])
    )
    localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify([query]))
    renderWorkspace()
    await userEvent.click(screen.getByRole('button', { name: /历史提问/ }))
    await userEvent.click(screen.getByRole('button', { name: query }))

    expect(await screen.findByText('恢复后的答案')).toBeInTheDocument()
    expect(screen.getByText(/当前会话 · 测试会话/)).toBeInTheDocument()
    expect(screen.getByText('全部历史')).toBeInTheDocument()
    expect(api.runAiSearch).not.toHaveBeenCalled()
  })

  it('supports legacy cache records without an Evidence Collection and without Evidence', async () => {
    const query = '没有证据的缓存'
    localStorage.setItem(
      SEARCH_CACHE_KEY,
      JSON.stringify([makeCacheRecord({ query, answer: '只有摘要的缓存', evidence: [] })])
    )
    renderWorkspace()
    await submitQuery(query)

    expect(await screen.findByText('只有摘要的缓存')).toBeInTheDocument()
    expect(screen.getByText('等待检索结果')).toBeInTheDocument()
    expect(api.runAiSearch).not.toHaveBeenCalled()
  })

  it('does not reuse the previous successful result for a new query', async () => {
    api.runAiSearch
      .mockResolvedValueOnce(
        makeSearchResult({ answer: '第一轮答案', evidence: [makePipelineEvidence(1)] })
      )
      .mockResolvedValueOnce(
        makeSearchResult({ answer: '第二轮答案', evidence: [makePipelineEvidence(2)] })
      )
    renderWorkspace()
    const user = await submitQuery('第一轮问题')
    await screen.findByText('第一轮答案')
    await user.click(screen.getByRole('button', { name: '新问题' }))
    await user.type(screen.getByRole('textbox'), '第二轮问题')
    await user.click(screen.getByRole('button', { name: /开始分析/ }))

    await screen.findByText('第二轮答案')
    expect(screen.queryByText('第一轮答案')).not.toBeInTheDocument()
    expect(api.runAiSearch).toHaveBeenCalledTimes(2)
  })

  /**
   * Knowledge 状态语义矩阵。
   *
   * 必须把 FRESHNESS（追到源数据最新）与 COMPLETENESS（这一遍 pass 的进度）分开表达，
   * **不得**在落后时出现「已同步」。
   */
  const STALE_INDEX_AT = new Date('2026-08-26T11:37:24+08:00').getTime()
  const SOURCE_LATEST_AT = new Date('2026-09-11T11:57:24+08:00').getTime()
  const makePass = (phase: 'full' | 'catchup' | 'backfill' | 'idle') => ({
    phase,
    cancellable: phase !== 'idle',
    startedAt: SOURCE_LATEST_AT,
    scannedMessages: 120,
    indexedMessages: 20,
    processedConversations: 3,
    totalConversations: 10,
    skippedConversations: 1,
    catchupConversations: 4,
    backfillConversations: 6,
    backfillCompletedConversations: 2,
    mainLoopLagMs: 4
  })

  it.each([
    ['unavailable', '未建立', {}],
    ['building', '可用 · 正在补齐历史', {}],
    ['syncing', '可用 · 正在追新', { pass: makePass('catchup') }],
    ['syncing', '可用 · 正在补齐历史', { pass: makePass('full') }],
    // backfill（补历史缺口）与 full（首次建库）对用户是同一件事：都不是"追最新"。
    ['syncing', '可用 · 正在补齐历史', { pass: makePass('backfill') }],
    [
      'ready',
      '可用 · 待追新',
      { indexLatestAt: STALE_INDEX_AT, sourceLatestAt: SOURCE_LATEST_AT }
    ],
    [
      'ready',
      '可用 · 已追至最新',
      { indexLatestAt: SOURCE_LATEST_AT, sourceLatestAt: SOURCE_LATEST_AT }
    ],
    ['cancelled', '可用 · 同步已取消', {}],
    ['error', '可用 · 更新失败', {}]
  ] as const)('renders Knowledge state %s as %s', async (state, label, overrides) => {
    api.getKnowledgeStatus.mockResolvedValue({
      ...readyKnowledgeStatus,
      ...overrides,
      state,
      lastError: state === 'error' ? 'Worker 异常' : undefined
    })
    renderWorkspace()

    expect(await screen.findAllByText(new RegExp(`Knowledge ${label}`))).not.toHaveLength(0)
    if (state === 'error') expect(screen.getByText('Worker 异常')).toBeInTheDocument()
    // 无论哪种状态，「已同步」这种把两件事混为一谈的笼统说法都不允许出现。
    expect(screen.queryByText('已同步')).toBeNull()
  })

  it('never claims the index is up to date when freshness cannot be confirmed', async () => {
    // 两个边界时间缺失（老库 / 运行态未上报）时无法判断是否追平。
    // 安全侧是「待追新」——**不能**把"无法确认"说成「已追至最新」。
    api.getKnowledgeStatus.mockResolvedValue({
      ...readyKnowledgeStatus,
      indexLatestAt: null,
      sourceLatestAt: null
    })
    renderWorkspace()

    expect(await screen.findByText('Knowledge 可用 · 待追新')).toBeInTheDocument()
    expect(screen.queryByText(/可用 · 已追至最新/)).toBeNull()
    expect(screen.queryByText('已同步')).toBeNull()
  })

  it('does not claim usability when the derived index is unavailable', async () => {
    // 没有分片却残留了历史计数时，不能说「可用 · …」——那是两句真话拼成的假话。
    api.getKnowledgeStatus.mockResolvedValue({
      ...readyKnowledgeStatus,
      state: 'unavailable',
      indexedMessageCount: 0,
      indexedChunkCount: 0
    })
    renderWorkspace()

    expect(await screen.findByText('Knowledge 未建立')).toBeInTheDocument()
    expect(screen.queryByText(/可用 · /)).toBeNull()
  })

  it('starts Knowledge indexing and reflects the returned status', async () => {
    api.getKnowledgeStatus.mockResolvedValue({
      ...readyKnowledgeStatus,
      state: 'unavailable',
      indexedMessageCount: 0,
      indexedChunkCount: 0
    })
    api.startKnowledgeIndex.mockResolvedValue({
      ...readyKnowledgeStatus,
      state: 'syncing',
      pass: makePass('full')
    })
    const onNotice = vi.fn()
    renderWorkspace({ onNotice })
    await screen.findByText('Knowledge 未建立')
    await userEvent.click(screen.getByRole('button', { name: '建立本地知识库' }))

    expect(api.startKnowledgeIndex).toHaveBeenCalledOnce()
    expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('开始同步'))
    expect(await screen.findByText('Knowledge 可用 · 正在补齐历史')).toBeInTheDocument()
  })

  it('unsubscribes Knowledge and Progress listeners on unmount', () => {
    const view = renderWorkspace()
    view.unmount()
    expect(knowledgeUnsubscribe).toHaveBeenCalledOnce()
    expect(progressUnsubscribe).toHaveBeenCalledOnce()
  })
})

/**
 * Knowledge 卡片的布局契约（侧栏宽度不变，靠栅格而不是靠缩字号解决拥挤）。
 *
 * jsdom 不做布局计算，拿不到真实宽度，所以这里锁的是**布局所依赖的 DOM 契约**：
 * - 五段结构（HEADER / CURRENT PASS / DATABASE STATUS / CURRENT / ACTION）各自的可见性；
 * - 状态文案保持**单一文本节点**，换行只可能发生在「 · 」之后；
 * - 数值行是「label + value」成对结构，nowrap 挂在 value 上；
 * - 「取消同步」只在这一遍真的在跑时出现，且带不会被压扁的类。
 *
 * 刻意不写整份 CSS 快照：那种断言在调样式时全是噪声，也证明不了布局真的对。
 */
describe('Knowledge card layout contract', () => {
  const STALE_INDEX_AT = new Date('2026-08-26T11:37:24+08:00').getTime()
  const SOURCE_LATEST_AT = new Date('2026-09-11T11:57:24+08:00').getTime()

  const makePass = (phase: 'full' | 'catchup' | 'backfill' | 'idle') => ({
    phase,
    cancellable: phase !== 'idle',
    startedAt: SOURCE_LATEST_AT,
    scannedMessages: 2_400,
    indexedMessages: 1_200,
    processedConversations: 400,
    totalConversations: 4_800,
    skippedConversations: 200,
    catchupConversations: 4,
    backfillConversations: 6,
    backfillCompletedConversations: 2,
    mainLoopLagMs: 0
  })

  const status = (state: string, extra: Record<string, unknown> = {}): unknown => ({
    ...readyKnowledgeStatus,
    state,
    ...extra
  })

  const findStateLabel = async (): Promise<HTMLElement> =>
    await screen.findByTestId('knowledge-state-label')
  const queryPassSection = (): HTMLElement | null => screen.queryByTestId('knowledge-pass-progress')

  it('keeps the state label a single string that only wraps at 「 · 」', async () => {
    api.getKnowledgeStatus.mockResolvedValue(
      status('ready', { indexLatestAt: STALE_INDEX_AT, sourceLatestAt: SOURCE_LATEST_AT })
    )
    renderWorkspace()

    const label = await findStateLabel()
    // 卡片上的字符串必须与 label 函数逐字一致（侧栏外的详情行也用同一个函数）。
    // 折行位置由 CSS 的 word-break: keep-all 决定，DOM 里不做切分 —— 一旦被拆成
    // 多个元素，页面上就会出现「可用 · 正在」/「补齐历史」这种碎句。
    expect(label.textContent).toBe('可用 · 待追新')
    expect(label.childNodes).toHaveLength(1)
    expect(label).toHaveClass('ai-search-knowledge-state')
  })

  it('keeps the header as one grid row with kicker, state and status dot', async () => {
    api.getKnowledgeStatus.mockResolvedValue(
      status('ready', { indexLatestAt: SOURCE_LATEST_AT, sourceLatestAt: SOURCE_LATEST_AT })
    )
    renderWorkspace()

    const label = await findStateLabel()
    const heading = label.closest('.ai-search-knowledge-heading')
    expect(heading).not.toBeNull()
    expect(heading!.querySelector('.ai-search-knowledge-kicker')?.textContent).toBe('KNOWLEDGE BASE')
    expect(heading!.querySelector('.ai-search-knowledge-dot')).not.toBeNull()
  })

  it('shows the CURRENT PASS section only while a pass is really running', async () => {
    api.getKnowledgeStatus.mockResolvedValue(
      status('unavailable', { indexedMessageCount: 0, indexedChunkCount: 0 })
    )
    const view = renderWorkspace()
    await screen.findByText('Knowledge 未建立')
    expect(queryPassSection()).toBeNull()
    view.unmount()

    api.getKnowledgeStatus.mockResolvedValue(status('syncing', { pass: makePass('catchup') }))
    renderWorkspace()
    expect(await screen.findByTestId('knowledge-pass-progress')).toBeInTheDocument()
  })

  it('renders the real two counters instead of a denominator-less fake progress', async () => {
    api.getKnowledgeStatus.mockResolvedValue(status('syncing', { pass: makePass('catchup') }))
    renderWorkspace()

    const progress = await screen.findByTestId('knowledge-pass-progress')
    expect(progress.textContent).toBe(
      `本轮新增索引 ${(1_200).toLocaleString()} 条 · 本轮已扫描 ${(2_400).toLocaleString()} 条`
    )
    // 同样是一个文本节点 + CSS 折行：不能被拆成多个元素（否则「 · 」会甩到行首）。
    expect(progress.childNodes).toHaveLength(1)
  })

  it.each([
    ['catchup', '正在追最新消息：4 个会话有新内容'],
    ['backfill', '后台补齐历史：2 / 6 个久未更新的会话'],
    ['full', '正在建立索引：4,800 个会话']
  ] as const)('describes the %s pass inside CURRENT PASS', async (phase, expected) => {
    api.getKnowledgeStatus.mockResolvedValue(status('syncing', { pass: makePass(phase) }))
    renderWorkspace()

    expect(await screen.findByTestId('knowledge-pass-scope')).toHaveTextContent(expected)
  })

  it('keeps every database status row a label/value pair with a non-wrapping value', async () => {
    api.getKnowledgeStatus.mockResolvedValue(
      status('ready', { indexLatestAt: SOURCE_LATEST_AT, sourceLatestAt: SOURCE_LATEST_AT })
    )
    renderWorkspace()
    await findStateLabel()

    for (const text of ['已索引消息', '知识片段', '最新索引', '磁盘占用']) {
      const label = screen.getByText(text)
      expect(label).toHaveClass('ai-search-knowledge-label')
      const row = label.closest('.ai-search-knowledge-row')
      expect(row).not.toBeNull()
      // value 是 nowrap 的载体：数字一旦折行，这一行就不可读了。
      expect(row!.querySelector('.ai-search-knowledge-value')).not.toBeNull()
    }
  })

  it('gives the current conversation its own row and truncates the long name', async () => {
    api.getKnowledgeStatus.mockResolvedValue(
      status('syncing', { pass: makePass('catchup'), currentConversationId: aiSearchGroup.md5 })
    )
    renderWorkspace()
    await findStateLabel()

    const row = screen.getByText('当前会话').closest('.ai-search-knowledge-row')
    expect(row).not.toBeNull()
    // 群名 / 备注可以很长：必须省略而不是撑破侧栏。
    expect(row!.querySelector('.ai-search-knowledge-value')).toHaveClass(
      'ai-search-knowledge-value--truncate'
    )
  })

  it('drops the current-conversation row once nothing is running', async () => {
    api.getKnowledgeStatus.mockResolvedValue(
      status('ready', {
        indexLatestAt: SOURCE_LATEST_AT,
        sourceLatestAt: SOURCE_LATEST_AT,
        currentConversationId: aiSearchGroup.md5
      })
    )
    renderWorkspace()
    await findStateLabel()

    expect(screen.queryByText('当前会话')).toBeNull()
  })

  it('keeps the main-loop lag in its own labelled row when it is measured', async () => {
    api.getKnowledgeStatus.mockResolvedValue(
      status('syncing', { pass: { ...makePass('catchup'), mainLoopLagMs: 42 } })
    )
    renderWorkspace()
    await findStateLabel()

    const row = screen.getByText('界面卡顿峰值').closest('.ai-search-knowledge-row')
    expect(row).not.toBeNull()
    expect(row!.querySelector('.ai-search-knowledge-value')?.textContent).toBe('42ms')
  })

  it('keeps the cancel action on one line and only while running', async () => {
    api.getKnowledgeStatus.mockResolvedValue(
      status('ready', { indexLatestAt: SOURCE_LATEST_AT, sourceLatestAt: SOURCE_LATEST_AT })
    )
    const view = renderWorkspace()
    await findStateLabel()
    expect(screen.queryByTestId('knowledge-cancel-sync')).toBeNull()
    view.unmount()

    api.getKnowledgeStatus.mockResolvedValue(status('syncing', { pass: makePass('catchup') }))
    renderWorkspace()

    const cancel = await screen.findByTestId('knowledge-cancel-sync')
    expect(cancel).toHaveTextContent('取消同步')
    // 带 min-width 的类：按钮不会被主按钮挤到换行成「取消同」/「步」。
    expect(cancel).toHaveClass('ai-search-knowledge-cancel')
    expect(cancel.closest('.ai-search-knowledge-actions')).not.toBeNull()
  })

  it('keeps the cancelled state honest and free of a stale progress block', async () => {
    api.getKnowledgeStatus.mockResolvedValue(status('cancelled', { pass: makePass('idle') }))
    renderWorkspace()

    expect(await screen.findByText('Knowledge 可用 · 同步已取消')).toBeInTheDocument()
    expect(
      screen.getByText('上一遍同步被取消，已建立的索引仍然可用；下次同步会从断点继续。')
    ).toBeInTheDocument()
    // 取消之后不能残留一个假的"正在同步"。
    expect(queryPassSection()).toBeNull()
    expect(screen.queryByTestId('knowledge-cancel-sync')).toBeNull()
  })

  it('keeps the FRESH state free of the stale warning and the progress block', async () => {
    api.getKnowledgeStatus.mockResolvedValue(
      status('ready', { indexLatestAt: SOURCE_LATEST_AT, sourceLatestAt: SOURCE_LATEST_AT })
    )
    renderWorkspace()

    expect(await screen.findByText('Knowledge 可用 · 已追至最新')).toBeInTheDocument()
    expect(
      screen.getByText('后台增量同步不会影响原始微信聊天记录，也不会阻塞提问。')
    ).toBeInTheDocument()
    expect(screen.queryByText(/索引还没追上最新聊天/)).toBeNull()
    expect(queryPassSection()).toBeNull()
  })
})
