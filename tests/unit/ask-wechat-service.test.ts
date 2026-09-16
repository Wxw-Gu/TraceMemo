import { describe, expect, it, vi } from 'vitest'
import { AskWechatService, type AskWechatLogRecord } from '../../src/main/services/ask-wechat-service'
import { QueryAgentService, type QueryAgentProvider } from '../../src/main/services/query-agent-service'
import type { AiSearchPipelineResult } from '../../src/shared/ai-search'
import type { AskWechatQueryRequest, AskWechatQueryResult } from '../../src/shared/query-agent'

type ChatResponse = Awaited<ReturnType<QueryAgentProvider['chatWithTools']>>
type ToolExecutor = (name: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>

const request = (
  text: string,
  legacy?: AskWechatQueryRequest['legacy']
): AskWechatQueryRequest => ({ requestId: 'req-1', text, legacy })

function providerFactory(responses: ChatResponse[], configured = true): {
  provider: QueryAgentProvider
  calls: Array<{ messages: Array<Record<string, unknown>>; tools: string[] }>
} {
  const calls: Array<{ messages: Array<Record<string, unknown>>; tools: string[] }> = []
  const provider: QueryAgentProvider = {
    getRuntimeConfig: () => ({
      configured,
      providerName: 'Fixture Provider',
      model: 'fixture-model',
      modelName: 'Fixture Model'
    }),
    chatWithTools: vi.fn(async (messages, tools) => {
      calls.push({ messages, tools: tools.map((tool) => tool.function.name) })
      return responses.shift() || { success: true, data: 'done' }
    })
  }
  return { provider, calls }
}

const toolCall = (name: string, args: Record<string, unknown>): ChatResponse => ({
  success: true,
  data: '',
  toolCalls: [{ id: `call-${name}`, name, arguments: JSON.stringify(args) }]
})

const answer = (data: string): ChatResponse => ({ success: true, data })

const toolMessages = (messages: Array<Record<string, unknown>>): string =>
  JSON.stringify(messages.filter((message) => message.role === 'tool'))

const legacyResult = (patch: Record<string, unknown> = {}): AiSearchPipelineResult =>
  ({
    requestId: 'req-1',
    status: 'completed',
    answer: 'legacy answer',
    ...patch
  }) as unknown as AiSearchPipelineResult

const answered = (result: AskWechatQueryResult): Extract<AskWechatQueryResult, { status: 'answered' }> => {
  if (result.status !== 'answered') throw new Error(`expected answered, got ${result.status}`)
  return result
}

describe('AskWechatService — 桌面问问微信主路径', () => {
  it('A. 「我和 BOBO 第一次聊了什么」走 query_messages 并返回回答', async () => {
    const execute = vi.fn(async () => ({
      status: 'completed',
      returnedCount: 1,
      messages: [{ messageRef: 'ref-1', text: '你好' }]
    }))
    const { provider } = providerFactory([
      toolCall('query_messages', {
        target: { query: 'BOBO' },
        timeRange: { kind: 'all' },
        temporalBasis: { kind: 'none' },
        order: 'asc',
        limit: 1
      }),
      answer('你们的第一次聊天是一条问候。')
    ])
    const service = new AskWechatService(new QueryAgentService(provider, execute), { entry: 'desktop' })

    const result = answered(await service.ask(request('我和 BOBO 第一次聊了什么')))

    expect(result.engine).toBe('query-agent')
    expect(result.answer).toBe('你们的第一次聊天是一条问候。')
    expect(result.diagnostics).toMatchObject({
      entry: 'desktop',
      provider: 'Fixture Provider',
      model: 'Fixture Model',
      modelCallCount: 2,
      toolCallCount: 1,
      tools: ['query_messages'],
      outcome: 'answered'
    })
    expect(execute).toHaveBeenCalledTimes(1)
    // temporalBasis 是 LLM-facing 元数据，必须在到达 Query API 前被剥离。
    expect(execute.mock.calls[0][1]).not.toHaveProperty('temporalBasis')
    expect(execute.mock.calls[0][1].timeRange).toEqual({ kind: 'all' })
  })

  it('B. 明确时间（constraint）不会被 retry 扩大，ISO-8601 被换算成 epoch seconds', async () => {
    const execute = vi.fn(async () => ({
      status: 'completed',
      returnedCount: 0,
      coverage: { state: 'complete' }
    }))
    const constraintBasis = { kind: 'constraint', sourceText: '八月份' }
    const { provider, calls } = providerFactory([
      toolCall('query_messages', {
        target: { query: 'BOBO' },
        timeRange: {
          kind: 'absolute',
          startTime: '2026-08-01T00:00:00+08:00',
          endTime: '2026-09-01T00:00:00+08:00'
        },
        temporalBasis: constraintBasis
      }),
      toolCall('query_messages', {
        target: { query: 'BOBO' },
        timeRange: { kind: 'all' },
        temporalBasis: constraintBasis
      }),
      answer('八月份没有找到相关记录。')
    ])
    const service = new AskWechatService(new QueryAgentService(provider, execute), { entry: 'desktop' })

    answered(await service.ask(request('八月份 BOBO 有没有给我发过文件')))

    // 第二次改时间范围被 Host 结构性拒绝，没有到达 Query API。
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0][1].timeRange).toEqual({
      kind: 'absolute',
      startTime: Math.floor(Date.parse('2026-08-01T00:00:00+08:00') / 1000),
      endTime: Math.floor(Date.parse('2026-09-01T00:00:00+08:00') / 1000)
    })
    expect(toolMessages(calls[2].messages)).toContain('constraint_time_range_immutable')
  })

  it('C. 模糊时间（recall_hint）首次 0 条时由 Host 自动补查 all，且不占 toolCallCount', async () => {
    const execute = vi
      .fn<ToolExecutor>()
      .mockResolvedValueOnce({ status: 'completed', returnedCount: 0, coverage: { state: 'complete' } })
      .mockResolvedValueOnce({
        status: 'completed',
        returnedCount: 2,
        coverage: { state: 'complete' },
        messages: [{ messageRef: 'ref-2' }]
      })
    const { provider } = providerFactory([
      toolCall('query_messages', {
        target: { query: 'BOBO' },
        timeRange: { kind: 'last_7_days' },
        temporalBasis: { kind: 'recall_hint', sourceText: '前阵子' }
      }),
      answer('原范围没有，全部历史里有两条。')
    ])
    const service = new AskWechatService(new QueryAgentService(provider, execute), { entry: 'desktop' })

    const result = answered(await service.ask(request('前阵子 BOBO 好像发过东西给我')))

    expect(execute).toHaveBeenCalledTimes(2)
    expect(execute.mock.calls[1][1].timeRange).toEqual({ kind: 'all' })
    expect(result.diagnostics.toolCallCount).toBe(1)
    expect(result.diagnostics.modelCallCount).toBe(2)
  })

  it('D. 语义检索走 search_messages，queries 映射为 query + variants', async () => {
    const execute = vi.fn(async () => ({ status: 'completed', evidenceCount: 2, evidence: [] }))
    const { provider } = providerFactory([
      toolCall('search_messages', {
        target: { query: 'BOBO' },
        timeRange: { kind: 'all' },
        queries: ['房租', '押金']
      }),
      answer('找到两条相关记录。')
    ])
    const service = new AskWechatService(new QueryAgentService(provider, execute), { entry: 'desktop' })

    const result = answered(await service.ask(request('BOBO 提过房租或者押金吗')))

    expect(result.diagnostics.tools).toEqual(['search_messages'])
    expect(execute.mock.calls[0][1]).toMatchObject({ query: '房租', variants: ['押金'] })
  })

  it('E. 宽泛总结走 conversation_overview', async () => {
    const execute = vi.fn(async () => ({ status: 'completed', evidenceCount: 12, evidence: [] }))
    const { provider } = providerFactory([
      toolCall('conversation_overview', {
        target: { query: 'TraceMemo交流群' },
        timeRange: { kind: 'last_7_days' }
      }),
      answer('最近一周主要讨论了两件事。')
    ])
    const service = new AskWechatService(new QueryAgentService(provider, execute), { entry: 'desktop' })

    const result = answered(await service.ask(request('TraceMemo交流群最近聊了什么')))

    expect(result.diagnostics.tools).toEqual(['conversation_overview'])
  })

  it('F. 模型追问（clarification）按普通回答返回，并进入下一轮上下文', async () => {
    const { provider, calls } = providerFactory([
      answer('你想问的是哪位联系人？'),
      answer('好的，是 BOBO。')
    ])
    const service = new AskWechatService(new QueryAgentService(provider, vi.fn()), { entry: 'desktop' })

    const first = answered(await service.ask(request('我们第一次聊了什么')))
    expect(first.answer).toBe('你想问的是哪位联系人？')

    await service.ask(request('BOBO'))

    expect(calls[1].messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user'
    ])
    expect(calls[1].messages[1]).toMatchObject({ content: '我们第一次聊了什么' })
    expect(calls[1].messages[2]).toMatchObject({ content: '你想问的是哪位联系人？' })
  })

  it('G. Provider 失败 → 安全文案，且不回退 Legacy', async () => {
    const runLegacy = vi.fn(async () => legacyResult())
    const { provider } = providerFactory([{ success: false, error: 'AI 请求超时', timedOut: true }])
    const service = new AskWechatService(new QueryAgentService(provider, vi.fn()), {
      entry: 'desktop',
      runLegacy
    })

    const result = await service.ask(request('BOBO 说过什么'))

    expect(result.status).toBe('provider_unavailable')
    if (result.status !== 'provider_unavailable') throw new Error('unreachable')
    expect(result.message).toBe('当前 AI 查询服务暂时不可用，请稍后再试。')
    expect(result.diagnostics.outcome).toBe('provider_failure')
    expect(runLegacy).not.toHaveBeenCalled()
  })

  it('G2. Provider 未配置 → 安全文案，且不触发任何模型 / 工具调用', async () => {
    const execute = vi.fn(async () => ({ status: 'completed' }))
    const { provider } = providerFactory([], false)
    const service = new AskWechatService(new QueryAgentService(provider, execute), { entry: 'desktop' })

    const result = await service.ask(request('BOBO 说过什么'))

    expect(result.status).toBe('provider_unavailable')
    expect(execute).not.toHaveBeenCalled()
    expect(provider.chatWithTools).not.toHaveBeenCalled()
  })

  it('H. Query Agent 查 0 条 → 仍然是它回答，不调用 Legacy', async () => {
    const execute = vi.fn(async () => ({
      status: 'completed',
      returnedCount: 0,
      coverage: { state: 'complete' }
    }))
    const runLegacy = vi.fn(async () => legacyResult())
    const { provider } = providerFactory([
      toolCall('query_messages', {
        target: { query: 'BOBO' },
        timeRange: { kind: 'all' },
        temporalBasis: { kind: 'none' }
      }),
      answer('当前可读取的完整范围里没有找到相关记录。')
    ])
    const service = new AskWechatService(new QueryAgentService(provider, execute), {
      entry: 'desktop',
      runLegacy
    })

    const result = answered(await service.ask(request('BOBO 给我发过文件吗')))

    expect(result.answer).toContain('没有找到')
    expect(result.diagnostics.outcome).toBe('answered')
    expect(runLegacy).not.toHaveBeenCalled()
  })

  it('Runtime 抛出未分类异常 → 允许回退 Legacy，并沿用 UI 范围', async () => {
    const runLegacy = vi.fn(async () => legacyResult({ status: 'completed' }))
    const provider: QueryAgentProvider = {
      getRuntimeConfig: () => ({
        configured: true,
        providerName: 'P',
        model: 'm',
        modelName: 'M'
      }),
      chatWithTools: vi.fn(async () => {
        throw new Error('unexpected internal failure')
      })
    }
    const service = new AskWechatService(new QueryAgentService(provider, vi.fn()), {
      entry: 'desktop',
      runLegacy
    })

    const result = await service.ask(
      request('BOBO 说过什么', {
        scope: 'conversation',
        range: '30d',
        conversationId: 'conversation-1'
      })
    )

    expect(result.engine).toBe('legacy')
    if (result.engine !== 'legacy') throw new Error('unreachable')
    expect(result.reason).toBe('runtime_error')
    expect(runLegacy).toHaveBeenCalledTimes(1)
    expect(runLegacy.mock.calls[0][0]).toMatchObject({
      requestId: 'req-1',
      text: 'BOBO 说过什么',
      scope: 'conversation',
      range: '30d',
      conversationId: 'conversation-1'
    })
  })

  it('Runtime 异常且没有 Legacy 通道（Agent Hub）→ 明确文案，不抛异常', async () => {
    const provider: QueryAgentProvider = {
      getRuntimeConfig: () => ({ configured: true, providerName: 'P', model: 'm', modelName: 'M' }),
      chatWithTools: vi.fn(async () => {
        throw new Error('unexpected internal failure')
      })
    }
    const service = new AskWechatService(new QueryAgentService(provider, vi.fn()), {
      entry: 'agent-hub'
    })

    const result = await service.ask(request('BOBO 说过什么'))

    expect(result.status).toBe('error')
    if (result.status !== 'error') throw new Error('unreachable')
    expect(result.message).toBe('本次查询没有完成，请稍后再试或换一种问法。')
    expect(result.diagnostics.entry).toBe('agent-hub')
  })

  it('超过工具调用上限 → 判为 Runtime 失败（可回退），不伪装成正常回答', async () => {
    let counter = 0
    const execute = vi.fn(async () => ({ status: 'completed', returnedCount: 0 }))
    const provider: QueryAgentProvider = {
      getRuntimeConfig: () => ({ configured: true, providerName: 'P', model: 'm', modelName: 'M' }),
      chatWithTools: vi.fn(async () => {
        counter += 1
        return {
          success: true,
          data: '',
          toolCalls: [
            {
              id: `call-${counter}`,
              name: 'query_messages',
              arguments: JSON.stringify({
                target: { query: `BOBO${counter}` },
                timeRange: { kind: 'all' },
                temporalBasis: { kind: 'none' }
              })
            }
          ]
        }
      })
    }
    const service = new AskWechatService(new QueryAgentService(provider, execute), {
      entry: 'agent-hub'
    })

    const result = await service.ask(request('一直查不完的问题'))

    expect(result.status).toBe('error')
    if (result.status !== 'error') throw new Error('unreachable')
    expect(result.diagnostics.outcome).toBe('tool_limit')
  })

  it('空问题 → 明确的用户文案', async () => {
    const { provider } = providerFactory([])
    const service = new AskWechatService(new QueryAgentService(provider, vi.fn()), { entry: 'desktop' })

    const result = await service.ask(request('   '))

    expect(result.status).toBe('error')
    if (result.status !== 'error') throw new Error('unreachable')
    expect(result.message).toBe('请先输入想了解的问题。')
    expect(result.diagnostics.outcome).toBe('invalid_question')
  })

  it('本地日志必须包含问题与模型回答原文，方便回放排查', async () => {
    const logs: AskWechatLogRecord[] = []
    const { provider } = providerFactory([answer('BOBO 最近在准备搬家，提到了房租和押金。')])
    const service = new AskWechatService(new QueryAgentService(provider, vi.fn()), {
      entry: 'desktop',
      log: (record) => logs.push(record)
    })

    await service.ask(request('BOBO 最近在忙什么'))

    expect(logs).toHaveLength(1)
    // 形态字段仍然一个不少（排查时既要知道"问了什么"，也要知道"跑了什么工具、多久"）。
    for (const key of ['entry', 'model', 'modelCallCount', 'outcome', 'provider', 'toolCallCount', 'tools', 'totalMs']) {
      expect(logs[0].details).toHaveProperty(key)
    }
    // 措辞回归：真机上曾出现"图片已识别出文字却答'没有取得 OCR 文字'"，
    // 当时日志里只有工具名与次数，无法判断是索引没建还是链路没接上。
    // 现在问答原文进入**本机**日志（不上传、不进遥测），可以直接回放。
    expect(logs[0].details?.question).toBe('BOBO 最近在忙什么')
    expect(String(logs[0].details?.answer)).toContain('准备搬家')
  })

  it('图片 OCR 的两条结构化事实进入诊断（不重复正文）', async () => {
    const logs: AskWechatLogRecord[] = []
    const { provider } = providerFactory([answer('那张图里有价格文字。')])
    const runtime = new QueryAgentService(provider, vi.fn())
    // 直接在 Runtime 结果里放一条带图片 OCR 的 trace，验证聚合口径。
    vi.spyOn(runtime, 'run').mockResolvedValue({
      question: '图里写了什么',
      provider: 'Fixture',
      model: 'fixture',
      modelCallCount: 1,
      toolCallCount: 1,
      toolTotalMs: 5,
      totalMs: 10,
      modelDurationsMs: [],
      modelDiagnostics: [],
      answer: '那张图里有价格文字。',
      traces: [
        {
          toolName: 'query_messages',
          input: {},
          durationMs: 5,
          status: 'completed',
          imageOcrTextCount: 3,
          imageOcrCoverageState: 'partial'
        }
      ]
    } as never)
    const service = new AskWechatService(runtime, {
      entry: 'desktop',
      log: (record) => logs.push(record)
    })

    await service.ask(request('图里写了什么'))

    expect(logs[0].details?.imageOcrTextCount).toBe(3)
    expect(logs[0].details?.imageOcrCoverageState).toBe('partial')
  })

  it('forgetConversation 清掉指定会话的澄清上下文', async () => {
    const { provider, calls } = providerFactory([
      answer('哪一位？'),
      answer('好的。'),
      answer('好的。')
    ])
    const service = new AskWechatService(new QueryAgentService(provider, vi.fn()), { entry: 'desktop' })
    await service.ask(request('我们第一次聊了什么'))
    service.forgetConversation()
    await service.ask(request('BOBO'))

    expect(calls[1].messages.map((message) => message.role)).toEqual(['system', 'user'])
  })
})

describe('AskWechatService — 搜索范围（conversationScope）', () => {
  it('把 UI 的 scope 透传到 Tool 执行上下文，并让范围说明进入模型上下文', async () => {
    const seen: Array<Record<string, unknown> | undefined> = []
    const execute = vi.fn(async (_name: string, _input: Record<string, unknown>, context?: { conversationScope?: unknown }) => {
      seen.push(context?.conversationScope as Record<string, unknown> | undefined)
      return { status: 'completed', returnedCount: 0 }
    })
    const { provider, calls } = providerFactory([
      toolCall('search_messages', { timeRange: { kind: 'all' }, queries: ['健身'] }),
      answer('范围内没有找到。')
    ])
    const service = new AskWechatService(new QueryAgentService(provider, execute), { entry: 'desktop' })

    await service.ask({
      requestId: 'req-1',
      text: '最近谁聊过健身',
      scope: { scope: { kind: 'groups' }, label: '群聊专属' }
    })

    expect(seen[0]).toEqual({ kind: 'groups' })
    // 范围说明只描述边界；强制由 Engine 完成（越界 target 会被结构化拒绝）。
    expect(String(calls[0].messages[1]?.content)).toContain('群聊专属')
    expect(String(calls[0].messages[1]?.content)).toContain('群成员实际发送的消息')
  })

  it('没有 scope 时不注入范围说明（保持毕业版本的 messages 形状）', async () => {
    const { provider, calls } = providerFactory([answer('好的')])
    const service = new AskWechatService(new QueryAgentService(provider, vi.fn()), { entry: 'agent-hub' })

    await service.ask(request('你好'))

    expect(calls[0].messages.map((message) => message.role)).toEqual(['system', 'user'])
  })

  it('回答结果带真实统计与证据（供 UI 顶部与右侧面板使用）', async () => {
    const execute = vi.fn(async () => ({
      status: 'completed',
      evidenceCount: 2,
      evidence: [
        {
          messageRef: 'ref-1',
          conversationName: 'TraceMemo 交流群',
          conversationType: 'group',
          sender: '张三',
          timestamp: 1_787_650_302_000,
          sourceKind: 'text',
          text: '最近开始健身了'
        }
      ]
    }))
    const { provider } = providerFactory([
      toolCall('search_messages', { timeRange: { kind: 'all' }, queries: ['健身'] }),
      answer('张三提过。')
    ])
    const service = new AskWechatService(new QueryAgentService(provider, execute), { entry: 'desktop' })

    const result = answered(
      await service.ask({ requestId: 'req-1', text: '谁聊过健身', scope: { scope: { kind: 'groups' } } })
    )

    expect(result.evidence).toHaveLength(1)
    expect(result.evidence[0]).toMatchObject({
      conversationName: 'TraceMemo 交流群',
      conversationType: 'group',
      sender: '张三',
      source: 'search_messages'
    })
    expect(result.stats.tools).toEqual(['search_messages'])
    expect(result.stats.reads.evidenceCount).toBe(1)
    expect(result.stats.scope).toEqual({ kind: 'groups' })
  })
})
