import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AISearchWorkspace } from '../../src/renderer/src/components/search/AISearchWorkspace'
import {
  SEARCH_CACHE_KEY,
  SEARCH_HISTORY_KEY
} from '../../src/renderer/src/components/search/searchUtils'
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

  it('passes the selected Evidence contact and timestamp to the conversation jump callback', async () => {
    const onOpenEvidence = vi.fn()
    const item = makePipelineEvidence(1, aiSearchContact)
    api.runAiSearch.mockResolvedValue(makeSearchResult({ evidence: [item] }))
    renderWorkspace({ onOpenEvidence })
    await submitQuery()
    await screen.findByText('E1 · 发送者 1')

    await userEvent.click(screen.getByRole('button', { name: '跳转到原聊天 ↗' }))
    expect(onOpenEvidence).toHaveBeenCalledWith(aiSearchContact, Math.floor(item.timestamp / 1000))
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

  it.each([
    ['unavailable', '未建立'],
    ['building', '建立中'],
    ['syncing', '增量同步'],
    ['ready', '已同步'],
    ['error', '异常']
  ] as const)('renders Knowledge state %s as %s', async (state, label) => {
    api.getKnowledgeStatus.mockResolvedValue({
      ...readyKnowledgeStatus,
      state,
      lastError: state === 'error' ? 'Worker 异常' : undefined
    })
    renderWorkspace()

    expect(await screen.findAllByText(new RegExp(`Knowledge ${label}`))).not.toHaveLength(0)
    if (state === 'error') expect(screen.getByText('Worker 异常')).toBeInTheDocument()
  })

  it('starts Knowledge indexing and reflects the returned status', async () => {
    api.getKnowledgeStatus.mockResolvedValue({ ...readyKnowledgeStatus, state: 'unavailable' })
    api.startKnowledgeIndex.mockResolvedValue({ ...readyKnowledgeStatus, state: 'syncing' })
    const onNotice = vi.fn()
    renderWorkspace({ onNotice })
    await screen.findByText('Knowledge 未建立')
    await userEvent.click(screen.getByRole('button', { name: '建立本地知识库' }))

    expect(api.startKnowledgeIndex).toHaveBeenCalledOnce()
    expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('开始同步'))
    expect(await screen.findByText('Knowledge 增量同步')).toBeInTheDocument()
  })

  it('unsubscribes Knowledge and Progress listeners on unmount', () => {
    const view = renderWorkspace()
    view.unmount()
    expect(knowledgeUnsubscribe).toHaveBeenCalledOnce()
    expect(progressUnsubscribe).toHaveBeenCalledOnce()
  })
})
