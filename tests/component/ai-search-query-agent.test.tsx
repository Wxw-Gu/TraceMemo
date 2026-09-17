import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AISearchWorkspace } from '../../src/renderer/src/components/search/AISearchWorkspace'
import { aiSearchContact, aiSearchGroup, makeSearchResult } from './support/ai-search-fixtures'
import { makeImageTextIndexApi } from './support/image-text-index-api'
import type {
  AskWechatQueryResult,
  AskWechatStats,
  QueryAgentProgressEvent
} from '../../src/shared/query-agent'
import type { AISearchWorkspaceProps } from '../../src/renderer/src/components/search/searchTypes'

type AnsweredResult = Extract<AskWechatQueryResult, { status: 'answered' }>

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
  copyText: vi.fn(),
  getAskWechatConfig: vi.fn(),
  runAskWechatQuery: vi.fn(),
  forgetAskWechatConversation: vi.fn(),
  onAskWechatProgress: vi.fn(),
  cancelKnowledgeIndex: vi.fn(),
  // 侧栏新增的「图片文字索引」卡片会读这些桥接。
  ...makeImageTextIndexApi()
}

const indexLatestAt = new Date('2026-09-11T11:57:24+08:00').getTime()

/** 主进程推来的**真实**进度事件（不是定时器伪进度）。 */
let askWechatProgressListener:
  | ((requestId: string, event: QueryAgentProgressEvent) => void)
  | undefined

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
  shmBytes: 32,
  indexLatestAt,
  sourceLatestAt: indexLatestAt
}

const diagnostics = {
  entry: 'desktop' as const,
  provider: 'Fixture Provider',
  model: 'Fixture Model',
  modelCallCount: 2,
  toolCallCount: 1,
  tools: ['query_messages'],
  totalMs: 1200,
  outcome: 'answered' as const
}

const makeProps = (): AISearchWorkspaceProps => ({
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
  onNotice: vi.fn()
})

const submitQuery = async (query: string): Promise<void> => {
  const user = userEvent.setup()
  await user.type(screen.getByRole('textbox'), query)
  await user.click(screen.getByRole('button', { name: /开始分析/ }))
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  vi.clearAllMocks()
  Object.defineProperty(window, 'api', { configurable: true, value: api })
  api.getSettings.mockResolvedValue({ settings: { debugEnabled: false } })
  api.getAppLogPath.mockResolvedValue('')
  api.getKnowledgeStatus.mockResolvedValue(readyKnowledgeStatus)
  api.onKnowledgeStatus.mockImplementation(() => vi.fn())
  api.onAiSearchProgress.mockImplementation(() => vi.fn())
  api.getAiSearchProviderStatus.mockResolvedValue({ configured: true, requiresConsent: false })
  api.authorizeAiSearchExternalProvider.mockResolvedValue({ success: true })
  api.cancelAiSearch.mockResolvedValue({ cancelled: true })
  api.startKnowledgeIndex.mockResolvedValue(readyKnowledgeStatus)
  api.writeAppLog.mockResolvedValue(undefined)
  api.revealAppLog.mockResolvedValue(undefined)
  api.copyText.mockResolvedValue({ success: true })
  api.forgetAskWechatConversation.mockResolvedValue(undefined)
  api.runAiSearch.mockResolvedValue(makeSearchResult())
  api.getAskWechatConfig.mockResolvedValue({ queryAgentEnabled: true })
  api.runAskWechatQuery.mockResolvedValue(answeredResult())
  api.onAskWechatProgress.mockImplementation(
    (listener: (requestId: string, event: QueryAgentProgressEvent) => void) => {
      askWechatProgressListener = listener
      return () => {
        askWechatProgressListener = undefined
      }
    }
  )
  api.cancelKnowledgeIndex.mockResolvedValue({ cancellable: false, cancelled: false })
})

const askStats = (): AskWechatStats => ({
  tools: ['query_messages'],
  reads: { messageCount: 10, matchedCount: 0, overviewSourceCount: 0, evidenceCount: 0 },
  scope: { kind: 'all' as const, label: '所有聊天记录' },
  modelCallCount: 2,
  toolCallCount: 1,
  totalMs: 3343
})

const answeredResult = (patch: Partial<AnsweredResult> = {}): AnsweredResult => ({
  engine: 'query-agent' as const,
  status: 'answered' as const,
  answer: '你们的第一次聊天是一条问候。',
  evidence: [],
  stats: askStats(),
  diagnostics,
  ...patch
})

describe('AISearchWorkspace — Query Agent 主路径', () => {
  it('Query Agent 开启时用它回答，不再调用 Legacy 检索', async () => {
    render(<AISearchWorkspace {...makeProps()} />)
    await submitQuery('我和 BOBO 第一次聊了什么')

    expect(await screen.findByText('你们的第一次聊天是一条问候。')).toBeTruthy()
    expect(api.runAskWechatQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: '我和 BOBO 第一次聊了什么' })
    )
    expect(api.runAiSearch).not.toHaveBeenCalled()
  })

  it('Query Agent 查 0 条时仍然是它回答，不触发 Legacy 二次检索', async () => {
    api.runAskWechatQuery.mockResolvedValue(
      answeredResult({ answer: '当前可读取的完整范围里没有找到相关记录。' })
    )
    render(<AISearchWorkspace {...makeProps()} />)
    await submitQuery('BOBO 给我发过文件吗')

    expect(await screen.findByText('当前可读取的完整范围里没有找到相关记录。')).toBeTruthy()
    expect(api.runAiSearch).not.toHaveBeenCalled()
  })

  it('Provider 不可用时给出明确文案，不静默回退成另一次检索', async () => {
    api.runAskWechatQuery.mockResolvedValue({
      engine: 'query-agent',
      status: 'provider_unavailable',
      message: '当前 AI 查询服务暂时不可用，请稍后再试。',
      diagnostics: { ...diagnostics, outcome: 'provider_failure' }
    })
    render(<AISearchWorkspace {...makeProps()} />)
    await submitQuery('BOBO 最近说过什么')

    expect(await screen.findByText('当前 AI 查询服务暂时不可用，请稍后再试。')).toBeTruthy()
    expect(api.runAiSearch).not.toHaveBeenCalled()
  })

  it('Runtime 不可恢复错误时接住主进程回退的 Legacy 结果', async () => {
    api.runAskWechatQuery.mockResolvedValue({
      engine: 'legacy',
      status: 'legacy',
      reason: 'runtime_error',
      result: makeSearchResult({ answer: 'Legacy 兜底答案' })
    })
    render(<AISearchWorkspace {...makeProps()} />)
    await submitQuery('BOBO 最近说过什么')

    expect(await screen.findByText('Legacy 兜底答案')).toBeTruthy()
  })

  it('Query Agent 关闭时仍走 Legacy 检索（可回退）', async () => {
    api.getAskWechatConfig.mockResolvedValue({ queryAgentEnabled: false })
    render(<AISearchWorkspace {...makeProps()} />)
    await submitQuery('我和测试会话最近聊了什么')

    expect(await screen.findByText('测试搜索答案')).toBeTruthy()
    expect(api.runAskWechatQuery).not.toHaveBeenCalled()
    expect(api.runAiSearch).toHaveBeenCalled()
  })

  it('preload 契约缺失（测试 / 旧版本）时安全回退 Legacy', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ...api, getAskWechatConfig: undefined, runAskWechatQuery: undefined }
    })
    render(<AISearchWorkspace {...makeProps()} />)
    await submitQuery('我和测试会话最近聊了什么')

    expect(await screen.findByText('测试搜索答案')).toBeTruthy()
    expect(api.runAiSearch).toHaveBeenCalled()
  })
})

describe('AISearchWorkspace — 搜索范围 / 时间 UI / 真实统计与证据', () => {
  it('Query Agent 开启时保留搜索范围、隐藏时间范围，并提示时间写在问题里', async () => {
    render(<AISearchWorkspace {...makeProps()} />)

    expect(await screen.findByText('搜索范围')).toBeTruthy()
    // 开关是异步解析的：等提示出现，说明 Query Agent 已生效
    expect(await screen.findByText(/时间直接写在问题里/)).toBeTruthy()
    expect(screen.getAllByText('所有聊天记录').length).toBeGreaterThan(0)
    expect(screen.getByText('群聊专属')).toBeTruthy()
    expect(screen.getByText('单聊专属')).toBeTruthy()
    // 时间范围控件在 Query Agent 主路径下移除
    expect(screen.queryByText('时间范围')).toBeNull()
    expect(screen.queryByText('不限时间')).toBeNull()
    expect(screen.queryByText('近 30 天')).toBeNull()
    expect(screen.getByText('时间由问题决定')).toBeTruthy()
  })

  it('Query Agent 关闭时恢复 Legacy 的时间范围控件', async () => {
    api.getAskWechatConfig.mockResolvedValue({ queryAgentEnabled: false })
    render(<AISearchWorkspace {...makeProps()} />)

    expect(await screen.findByText('时间范围')).toBeTruthy()
    expect(screen.getByText('不限时间')).toBeTruthy()
    expect(screen.queryByText(/时间直接写在问题里/)).toBeNull()
  })

  it('把界面选择的搜索范围传给 Query Agent', async () => {
    render(<AISearchWorkspace {...makeProps()} />)
    const user = userEvent.setup()
    await user.click(await screen.findByText('群聊专属'))
    await submitQuery('最近谁聊过健身')

    expect(api.runAskWechatQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '最近谁聊过健身',
        scope: expect.objectContaining({ scope: { kind: 'groups' } })
      })
    )
  })

  it('展示真实统计与真实证据，不再显示「知识库已收录 0」', async () => {
    api.runAskWechatQuery.mockResolvedValue(
      answeredResult({
        // 正文带 Host 分配的引用编号：inline [E1] 应可点击并指向同一条证据。
        answer: '张三最近提过健身[E1]。',
        evidence: [
          {
            citationId: 'E1',
            messageRef: 'ref-1',
            conversationName: 'TraceMemo 交流群',
            conversationType: 'group',
            sender: '张三',
            timestamp: 1_787_650_302_000,
            messageType: 'text',
            text: '最近重新开始健身了',
            source: 'search_messages'
          }
        ],
        stats: {
          tools: ['search_messages'],
          reads: { messageCount: 0, matchedCount: 12, overviewSourceCount: 0, evidenceCount: 1 },
          scope: { kind: 'groups', label: '群聊专属' },
          modelCallCount: 2,
          toolCallCount: 1,
          totalMs: 4034
        }
      })
    )
    render(<AISearchWorkspace {...makeProps()} />)
    await submitQuery('最近谁聊过健身')

    // 正文里 [E1] 被渲染成按钮，因此段落自身的直连文本节点是"张三最近提过健身。"
    const paragraph = await screen.findByText('张三最近提过健身。')
    // 段落完整文本 = 结论 + Host 分配的 [E1] + 句号：inline citation 真的在正文里，不是死文本
    expect(paragraph.textContent).toBe('张三最近提过健身[E1]。')
    // 正文 inline 引用：Host 分配的 E1 是可点击引用，标题指向同一条证据
    const inlineCitation = screen.getByTitle('查看证据 E1')
    expect(inlineCitation.textContent).toBe('[E1]')
    // 底部引用行与正文 inline 引用必须是同一个编号（都来自 Host 的 citationId）
    const bottomCitations = Array.from(document.querySelectorAll('[data-evidence-id]'))
    expect(bottomCitations.map((node) => node.getAttribute('data-evidence-id'))).toEqual(['E1'])
    // 群消息证据必须能归属到具体群 + 成员
    expect(screen.getAllByText(/TraceMemo 交流群/).length).toBeGreaterThan(0)
    // 证据卡片把"编号 · 发送者"渲染在同一行内，用正则匹配文本内容
    expect(screen.getAllByText(/张三/).length).toBeGreaterThan(0)
    expect(screen.getByText('最近重新开始健身了')).toBeTruthy()
    // 真实统计（不使用 Legacy 的"知识库已收录"）
    expect(screen.getByText('群聊专属内查询')).toBeTruthy()
    expect(screen.getByText('使用 1 条证据')).toBeTruthy()
    expect(screen.queryByText(/知识库已收录/)).toBeNull()
  })

  it('Host 移除的非法引用不会变成可点击的幻觉引用', async () => {
    api.runAskWechatQuery.mockResolvedValue(
      answeredResult({
        answer: '张三最近提过健身。',
        evidence: [
          { citationId: 'E1', messageRef: 'ref-1', sender: '张三', source: 'search_messages' }
        ],
        invalidCitationIds: ['E9']
      })
    )
    render(<AISearchWorkspace {...makeProps()} />)
    await submitQuery('最近谁聊过健身')

    expect(await screen.findByText('张三最近提过健身。')).toBeTruthy()
    // E9 已被 Host 移除，UI 不应把它渲染成可点击引用
    expect(screen.queryByTitle('查看证据 E9')).toBeNull()
    expect(screen.queryByText('[E9]')).toBeNull()
    expect(screen.getByTestId('query-invalid-citations').textContent).toContain('E9')
  })
})

describe('AISearchWorkspace — 知识库新鲜度状态', () => {
  it('索引落后时显示「可用 · 待追新」并说明覆盖范围，而不是「已同步」', async () => {
    api.getKnowledgeStatus.mockResolvedValue({
      ...readyKnowledgeStatus,
      indexLatestAt: new Date('2026-08-26T11:37:24+08:00').getTime(),
      sourceLatestAt: new Date('2026-09-11T11:57:24+08:00').getTime()
    })
    render(<AISearchWorkspace {...makeProps()} />)

    // ready ≠ fresh：落后时必须说「可用 · 待追新」，并在描述里给出真实覆盖边界，
    // 绝不能用笼统的「已同步」把两件事混为一谈。
    expect(await screen.findByText('可用 · 待追新')).toBeTruthy()
    expect(screen.queryByText('已同步')).toBeNull()
    expect(screen.queryByText('可用 · 已追至最新')).toBeNull()
    expect(screen.getByText(/跨会话搜索目前只覆盖到 8\/26/)).toBeTruthy()
    expect(screen.getByText('最新索引')).toBeTruthy()
    expect(screen.getByText('8/26')).toBeTruthy()
  })

  it('索引已追平源数据最新时才显示「可用 · 已追至最新」', async () => {
    render(<AISearchWorkspace {...makeProps()} />)

    expect(await screen.findByText('可用 · 已追至最新')).toBeTruthy()
    expect(screen.queryByText('已同步')).toBeNull()
    expect(screen.queryByText(/跨会话搜索目前只覆盖到/)).toBeNull()
  })
})

const emitProgress = async (
  requestId: string,
  event: Partial<QueryAgentProgressEvent> & { stage: QueryAgentProgressEvent['stage'] }
): Promise<void> => {
  await act(async () => {
    askWechatProgressListener?.(requestId, {
      elapsedMs: 0,
      at: Date.now(),
      modelCallCount: 1,
      toolCallCount: 0,
      ...event
    } as QueryAgentProgressEvent)
  })
}

describe('AISearchWorkspace — 查询进度与耗时拆解', () => {
  it('advances the visible stage from real Runtime progress instead of a static 4-step list', async () => {
    let release: ((value: unknown) => void) | undefined
    api.runAskWechatQuery.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    render(<AISearchWorkspace {...makeProps()} />)
    await userEvent.type(screen.getByRole('textbox'), '最近谁聊过健身')
    await userEvent.click(screen.getByRole('button', { name: /开始分析/ }))
    const requestId = api.runAskWechatQuery.mock.calls[0][0].requestId as string

    await emitProgress(requestId, { stage: 'understanding' })
    expect(screen.getByRole('heading', { name: '正在理解你的问题' })).toBeTruthy()

    // 跨会话范围（所有聊天记录）必须提前说明"范围较大"，否则用户会以为卡住了。
    await emitProgress(requestId, { stage: 'searching', toolCallCount: 1 })
    expect(screen.getByRole('heading', { name: '正在搜索较大范围的聊天记录…' })).toBeTruthy()

    await emitProgress(requestId, { stage: 'organizing_evidence', toolCallCount: 1 })
    expect(screen.getByRole('heading', { name: '正在整理找到的聊天记录' })).toBeTruthy()

    await emitProgress(requestId, { stage: 'generating_answer', toolCallCount: 1 })
    expect(screen.getByRole('heading', { name: '正在生成回答' })).toBeTruthy()

    // 进度里绝不能出现内部工具名 / SQL / 内部 id。
    expect(screen.queryByText(/search_messages|query_messages|SELECT|FTS/)).toBeNull()
    expect(screen.queryByText(/local:/)).toBeNull()

    release?.(answeredResult())
    expect(await screen.findByText('你们的第一次聊天是一条问候。')).toBeTruthy()
  })

  it('uses the narrower wording for a single-conversation scope', async () => {
    let release: ((value: unknown) => void) | undefined
    api.runAskWechatQuery.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    render(<AISearchWorkspace {...makeProps()} />)
    await userEvent.click(screen.getByRole('button', { name: /当前会话/ }))
    await userEvent.type(screen.getByRole('textbox'), '最近聊了什么')
    await userEvent.click(screen.getByRole('button', { name: /开始分析/ }))
    const requestId = api.runAskWechatQuery.mock.calls[0][0].requestId as string

    await emitProgress(requestId, { stage: 'searching', toolCallCount: 1 })

    expect(screen.getByRole('heading', { name: '正在搜索聊天记录…' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: '正在搜索较大范围的聊天记录…' })).toBeNull()

    release?.(answeredResult())
    expect(await screen.findByText('你们的第一次聊天是一条问候。')).toBeTruthy()
  })

  it('ignores progress that belongs to a different request', async () => {
    let release: ((value: unknown) => void) | undefined
    api.runAskWechatQuery.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    render(<AISearchWorkspace {...makeProps()} />)
    await submitQuery('最近谁聊过健身')

    await emitProgress('stale-request-id', { stage: 'generating_answer' })

    // 串台的进度会让用户看到一个根本不属于本次查询的阶段。
    expect(screen.queryByRole('heading', { name: '正在生成回答' })).toBeNull()
    expect(screen.getByRole('heading', { name: '正在准备查询' })).toBeTruthy()

    release?.(answeredResult())
    expect(await screen.findByText('你们的第一次聊天是一条问候。')).toBeTruthy()
  })

  it('breaks the total duration down into AI and local query instead of a bare 48.0s', async () => {
    api.runAskWechatQuery.mockResolvedValue(
      answeredResult({
        stats: {
          ...askStats(),
          totalMs: 19_548,
          timings: {
            totalMs: 19_548,
            modelMs: 3_892,
            localQueryMs: 15_648,
            modelDurationsMs: [1059, 2833],
            toolDurationsMs: [15_648]
          }
        }
      })
    )
    render(<AISearchWorkspace {...makeProps()} />)
    await submitQuery('最近谁聊过健身')
    await screen.findByText('你们的第一次聊天是一条问候。')

    const breakdown = screen.getByLabelText('本次查询耗时拆解')
    expect(breakdown.textContent).toContain('总耗时 19.5s')
    expect(breakdown.textContent).toContain('AI 3.9s')
    expect(breakdown.textContent).toContain('本地查询 15.6s')
    // 普通 UI 只出现用户能理解的名字，不出现 firstModelMs / toolTotalMs 这类工程字段。
    expect(breakdown.textContent).not.toMatch(/firstModelMs|toolTotalMs|finalModelMs/)
  })

  it('does not render a timing breakdown when the runtime reported none', async () => {
    render(<AISearchWorkspace {...makeProps()} />)
    await submitQuery('最近谁聊过健身')
    await screen.findByText('你们的第一次聊天是一条问候。')

    expect(screen.queryByLabelText('本次查询耗时拆解')).toBeNull()
    expect(screen.queryByText(/总耗时/)).toBeNull()
  })

  it('cancelling a query never touches the Knowledge sync abort scope', async () => {
    api.runAskWechatQuery.mockImplementation(() => new Promise(() => undefined))
    render(<AISearchWorkspace {...makeProps()} />)
    await submitQuery('最近谁聊过健身')

    await userEvent.click(await screen.findByRole('button', { name: /取消分析/ }))

    // 查询取消与索引取消必须是两套独立的 Abort scope，共用一个会互相误杀。
    expect(api.cancelKnowledgeIndex).not.toHaveBeenCalled()
  })
})
