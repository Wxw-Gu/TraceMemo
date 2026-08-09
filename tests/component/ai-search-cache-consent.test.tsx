import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AISearchWorkspace } from '../../src/renderer/src/components/search/AISearchWorkspace'
import {
  SEARCH_CACHE_KEY,
  buildSearchCacheKey
} from '../../src/renderer/src/components/search/searchUtils'

const api = {
  getSettings: vi.fn(),
  getAppLogPath: vi.fn(),
  getKnowledgeStatus: vi.fn(),
  onKnowledgeStatus: vi.fn(),
  onAiSearchProgress: vi.fn(),
  getAiSearchProviderStatus: vi.fn(),
  authorizeAiSearchExternalProvider: vi.fn(),
  runAiSearch: vi.fn(),
  cancelAiSearch: vi.fn()
}

describe('AISearchWorkspace cache privacy boundary', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    vi.clearAllMocks()
    Object.defineProperty(window, 'api', { configurable: true, value: api })
    api.getSettings.mockResolvedValue({ settings: { debugEnabled: false } })
    api.getAppLogPath.mockResolvedValue('')
    api.getKnowledgeStatus.mockResolvedValue({
      state: 'ready',
      processedMessages: 1,
      totalMessages: 1
    })
    api.onKnowledgeStatus.mockReturnValue(() => undefined)
    api.onAiSearchProgress.mockReturnValue(() => undefined)
    api.getAiSearchProviderStatus.mockResolvedValue({
      configured: true,
      requiresConsent: true,
      providerId: 'remote-provider',
      recipient: 'https://remote.example.test/v1'
    })
    api.cancelAiSearch.mockResolvedValue({ cancelled: true })
  })

  it('uses a local cache hit without opening a remote Provider consent dialog or making an AI request', async () => {
    const query = '最近聊过健身吗？'
    localStorage.setItem(
      SEARCH_CACHE_KEY,
      JSON.stringify([
        {
          version: 3,
          key: buildSearchCacheKey('global', '', '30d', query),
          createdAt: Date.now(),
          answer: '缓存结果',
          evidence: [],
          senderNames: {},
          messageCount: 1
        }
      ])
    )
    const onNotice = vi.fn()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(
      <AISearchWorkspace
        contacts={[]}
        selectedContact={null}
        dbReady
        aiModelConfig={{
          configured: true,
          providerName: 'Remote Provider',
          model: 'model',
          modelName: 'Model',
          status: 'connected'
        }}
        onSelectContact={vi.fn()}
        onOpenEvidence={vi.fn()}
        onOpenAISettings={vi.fn()}
        onNotice={onNotice}
      />
    )

    await userEvent.type(screen.getByRole('textbox'), query)
    await userEvent.click(screen.getByRole('button', { name: /开始分析/ }))

    await waitFor(() => expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('检索缓存')))
    expect(confirm).not.toHaveBeenCalled()
    expect(api.getAiSearchProviderStatus).not.toHaveBeenCalled()
    expect(api.authorizeAiSearchExternalProvider).not.toHaveBeenCalled()
    expect(api.runAiSearch).not.toHaveBeenCalled()
  })

  it('does not reuse a result cached before the current identity-resolution contract', async () => {
    const query = '技术交流群最近聊了啥'
    localStorage.setItem(
      'wxe_ai_search_cache_v10',
      JSON.stringify([
        {
          version: 2,
          key: buildSearchCacheKey('global', '', '7d', query),
          createdAt: Date.now(),
          answer: '旧的全局关键词答案',
          evidence: [],
          senderNames: {},
          messageCount: 2
        }
      ])
    )
    render(
      <AISearchWorkspace
        contacts={[]}
        selectedContact={null}
        dbReady
        aiModelConfig={{
          configured: true,
          providerName: 'Remote Provider',
          model: 'model',
          modelName: 'Model',
          status: 'connected'
        }}
        onSelectContact={vi.fn()}
        onOpenEvidence={vi.fn()}
        onOpenAISettings={vi.fn()}
        onNotice={vi.fn()}
      />
    )

    await userEvent.type(screen.getByRole('textbox'), query)
    await userEvent.click(screen.getByRole('button', { name: /开始分析/ }))

    await screen.findByRole('dialog', { name: '确认发送本次搜索资料' })
    expect(screen.queryByText('旧的全局关键词答案')).not.toBeInTheDocument()
    expect(api.runAiSearch).not.toHaveBeenCalled()
  })

  it('keeps a cached result visible when refresh is cancelled and restores it after the workspace remounts', async () => {
    const query = '最近聊过健身吗？'
    localStorage.setItem(
      SEARCH_CACHE_KEY,
      JSON.stringify([
        {
          version: 3,
          key: buildSearchCacheKey('global', '', '30d', query),
          createdAt: Date.now(),
          answer: '可恢复的缓存结果',
          evidence: [],
          senderNames: {},
          messageCount: 1
        }
      ])
    )
    const props = {
      contacts: [],
      selectedContact: null,
      dbReady: true,
      aiModelConfig: {
        configured: true,
        providerName: 'Remote Provider',
        model: 'model',
        modelName: 'Model',
        status: 'connected' as const
      },
      onSelectContact: vi.fn(),
      onOpenEvidence: vi.fn(),
      onOpenAISettings: vi.fn(),
      onNotice: vi.fn()
    }
    const first = render(<AISearchWorkspace {...props} />)
    await userEvent.type(screen.getByRole('textbox'), query)
    await userEvent.click(screen.getByRole('button', { name: /开始分析/ }))
    await screen.findByText('可恢复的缓存结果')

    await userEvent.click(screen.getByRole('button', { name: '刷新数据' }))
    await screen.findByRole('dialog', { name: '确认发送本次搜索资料' })
    await userEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.getByText('可恢复的缓存结果')).toBeInTheDocument()
    expect(api.runAiSearch).not.toHaveBeenCalled()

    first.unmount()
    render(<AISearchWorkspace {...props} />)
    expect(await screen.findByText('可恢复的缓存结果')).toBeInTheDocument()
  })

  it('cancels before starting a remote AI Search and never opens a native confirmation window', async () => {
    const onNotice = vi.fn()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(
      <AISearchWorkspace
        contacts={[]}
        selectedContact={null}
        dbReady
        aiModelConfig={{
          configured: true,
          providerName: 'Remote Provider',
          model: 'model',
          modelName: 'Model',
          status: 'connected'
        }}
        onSelectContact={vi.fn()}
        onOpenEvidence={vi.fn()}
        onOpenAISettings={vi.fn()}
        onNotice={onNotice}
      />
    )

    await userEvent.type(screen.getByRole('textbox'), '最近聊过健身吗？')
    await userEvent.click(screen.getByRole('button', { name: /开始分析/ }))
    await screen.findByRole('dialog', { name: '确认发送本次搜索资料' })
    await userEvent.click(screen.getByRole('button', { name: '取消' }))

    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('已取消本次 AI Search'))
    )
    expect(confirm).not.toHaveBeenCalled()
    expect(api.authorizeAiSearchExternalProvider).not.toHaveBeenCalled()
    expect(api.runAiSearch).not.toHaveBeenCalled()
  })

  it('scrolls to and flashes the matching Evidence card when an inline citation is clicked', async () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView
    })
    api.getAiSearchProviderStatus.mockResolvedValue({ configured: true, requiresConsent: false })
    api.runAiSearch.mockResolvedValue({
      requestId: 'evidence-navigation',
      status: 'completed',
      answer: '请查看这条证据 [E7]。',
      plan: { intent: 'global_topic_search' },
      knowledge: { indexedMessageCount: 8, indexedChunkCount: 1, totalMessages: 8 },
      candidateEvidenceCount: 8,
      contextEvidenceCount: 8,
      evidence: Array.from({ length: 8 }, (_, index) => ({
        id: `E${index + 1}`,
        conversationId: 'fixture-contact',
        conversationName: '测试会话',
        conversationType: 'user',
        messageId: `message-${index + 1}`,
        sender: `发送者 ${index + 1}`,
        senderId: `sender-${index + 1}`,
        timestamp: 1_785_900_000_000 + index,
        text: `证据 ${index + 1}`
      })),
      aggregation: {
        messageCount: 8,
        peopleCount: 1,
        conversationCount: 1,
        people: [],
        conversations: []
      },
      agent: { mode: 'agent', toolCalls: 1, trace: [] },
      timings: {},
      elapsedMs: 1
    } as never)
    render(
      <AISearchWorkspace
        contacts={[]}
        selectedContact={null}
        dbReady
        aiModelConfig={{
          configured: true,
          providerName: 'Local Provider',
          model: 'model',
          modelName: 'Model',
          status: 'connected'
        }}
        onSelectContact={vi.fn()}
        onOpenEvidence={vi.fn()}
        onOpenAISettings={vi.fn()}
        onNotice={vi.fn()}
      />
    )

    await userEvent.type(screen.getByRole('textbox'), '最近聊过健身吗？')
    await userEvent.click(screen.getByRole('button', { name: /开始分析/ }))
    await userEvent.click(await screen.findByRole('button', { name: '[E7]' }))

    const card = screen.getByText('E7 · 发送者 7').closest('article')
    await waitFor(() => expect(card).toHaveClass('focus-flash'))
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'nearest' })
  })

  it('keeps the submitted result title stable while drafting a new question and clears it from 新问题', async () => {
    api.getAiSearchProviderStatus.mockResolvedValue({ configured: true, requiresConsent: false })
    api.runAiSearch.mockResolvedValue({
      requestId: 'new-question',
      status: 'completed',
      answer: 'first answer',
      plan: { intent: 'global_topic_search' },
      knowledge: { indexedMessageCount: 1, indexedChunkCount: 1, totalMessages: 1 },
      candidateEvidenceCount: 1,
      contextEvidenceCount: 1,
      evidence: [],
      aggregation: {
        messageCount: 1,
        peopleCount: 1,
        conversationCount: 1,
        people: [],
        conversations: []
      },
      agent: { mode: 'agent', toolCalls: 1, trace: [] },
      timings: {},
      elapsedMs: 1
    } as never)
    render(
      <AISearchWorkspace
        contacts={[]}
        selectedContact={null}
        dbReady
        aiModelConfig={{
          configured: true,
          providerName: 'Local Provider',
          model: 'model',
          modelName: 'Model',
          status: 'connected'
        }}
        onSelectContact={vi.fn()}
        onOpenEvidence={vi.fn()}
        onOpenAISettings={vi.fn()}
        onNotice={vi.fn()}
      />
    )

    const input = screen.getByRole('textbox')
    await userEvent.type(input, 'first question')
    await userEvent.click(screen.getByRole('button', { name: /开始分析/ }))
    await screen.findByRole('heading', { name: 'first question' })

    await userEvent.clear(input)
    await userEvent.type(input, 'second question')
    expect(screen.getByRole('heading', { name: 'first question' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '新问题' }))
    expect(screen.queryByRole('heading', { name: 'first question' })).not.toBeInTheDocument()
    expect(input).toHaveValue('')
  })

  it('disables and guards analysis while the knowledge base is synchronizing', async () => {
    api.getKnowledgeStatus.mockResolvedValue({
      state: 'syncing',
      processedMessages: 20,
      totalMessages: 100
    })
    const onNotice = vi.fn()
    render(
      <AISearchWorkspace
        contacts={[]}
        selectedContact={null}
        dbReady
        aiModelConfig={{
          configured: true,
          providerName: 'Local Provider',
          model: 'model',
          modelName: 'Model',
          status: 'connected'
        }}
        onSelectContact={vi.fn()}
        onOpenEvidence={vi.fn()}
        onOpenAISettings={vi.fn()}
        onNotice={onNotice}
      />
    )

    await userEvent.type(screen.getByRole('textbox'), '同步时不能分析')
    const button = await screen.findByRole('button', { name: /同步中，暂不可分析/ })
    expect(button).toBeDisabled()
    const form = screen.getByRole('textbox').closest('form')
    expect(form).not.toBeNull()
    fireEvent.submit(form as HTMLFormElement)

    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith('知识库正在同步，请等待同步完成后再开始分析')
    )
    expect(api.getAiSearchProviderStatus).not.toHaveBeenCalled()
    expect(api.runAiSearch).not.toHaveBeenCalled()
  })

  it('submits with Enter and keeps Shift+Enter available for a new line', async () => {
    api.getAiSearchProviderStatus.mockResolvedValue({ configured: true, requiresConsent: false })
    api.runAiSearch.mockResolvedValue({
      requestId: 'enter-submit',
      status: 'completed',
      answer: 'answer',
      plan: { intent: 'global_topic_search' },
      knowledge: { indexedMessageCount: 1, indexedChunkCount: 1, totalMessages: 1 },
      candidateEvidenceCount: 0,
      contextEvidenceCount: 0,
      evidence: [],
      aggregation: {
        messageCount: 0,
        peopleCount: 0,
        conversationCount: 0,
        people: [],
        conversations: []
      },
      agent: { mode: 'agent', toolCalls: 1, trace: [] },
      timings: {},
      elapsedMs: 1
    } as never)
    render(
      <AISearchWorkspace
        contacts={[]}
        selectedContact={null}
        dbReady
        aiModelConfig={{
          configured: true,
          providerName: 'Local Provider',
          model: 'model',
          modelName: 'Model',
          status: 'connected'
        }}
        onSelectContact={vi.fn()}
        onOpenEvidence={vi.fn()}
        onOpenAISettings={vi.fn()}
        onNotice={vi.fn()}
      />
    )

    const input = screen.getByRole('textbox')
    await userEvent.type(input, 'Enter submit question')
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(api.runAiSearch).not.toHaveBeenCalled()

    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(api.runAiSearch).toHaveBeenCalledOnce())
  })

  it('cancels an active analysis and ignores its late result', async () => {
    api.getAiSearchProviderStatus.mockResolvedValue({ configured: true, requiresConsent: false })
    let resolveSearch: ((value: unknown) => void) | undefined
    api.runAiSearch.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSearch = resolve
        })
    )
    const onNotice = vi.fn()
    render(
      <AISearchWorkspace
        contacts={[]}
        selectedContact={null}
        dbReady
        aiModelConfig={{
          configured: true,
          providerName: 'Local Provider',
          model: 'model',
          modelName: 'Model',
          status: 'connected'
        }}
        onSelectContact={vi.fn()}
        onOpenEvidence={vi.fn()}
        onOpenAISettings={vi.fn()}
        onNotice={onNotice}
      />
    )

    await userEvent.type(screen.getByRole('textbox'), '这个请求稍后才返回')
    await userEvent.click(screen.getByRole('button', { name: /开始分析/ }))
    const cancelButton = await screen.findByRole('button', { name: /取消分析/ })
    const requestId = api.runAiSearch.mock.calls[0][0].requestId as string
    await userEvent.click(cancelButton)

    expect(api.cancelAiSearch).toHaveBeenCalledWith(requestId)
    expect(onNotice).toHaveBeenCalledWith('已取消本次分析')
    expect(screen.getByRole('button', { name: /开始分析/ })).toBeEnabled()

    resolveSearch?.({ requestId, status: 'completed', answer: '不应显示的迟到结果' })
    await waitFor(() => expect(screen.queryByText('不应显示的迟到结果')).not.toBeInTheDocument())
    expect(localStorage.getItem(SEARCH_CACHE_KEY) || '').not.toContain('不应显示的迟到结果')
  })
})
