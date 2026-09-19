import { describe, expect, it, vi } from 'vitest'
import {
  QueryAgentService,
  type QueryAgentProvider
} from '../../src/main/services/query-agent-service'

function capturingProvider(configured = true): {
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
      return { success: true, data: 'ok' }
    })
  }
  return { provider, calls }
}

describe('QueryAgentService — 历史上下文不改变毕业语义', () => {
  it('不传 history 时 messages 仍然只有 system + user（与毕业版本一致）', async () => {
    const { provider, calls } = capturingProvider()
    const service = new QueryAgentService(provider, vi.fn())

    await service.run('我和 BOBO 第一次聊了什么')

    expect(calls[0].messages.map((message) => message.role)).toEqual(['system', 'user'])
    expect(calls[0].messages[1]).toMatchObject({ content: '我和 BOBO 第一次聊了什么' })
    expect(calls[0].tools).toEqual([
      'query_messages',
      'search_messages',
      'message_context',
      'conversation_overview'
    ])
  })

  it('传 history 时按 问 / 答 顺序插在 system 之后', async () => {
    const { provider, calls } = capturingProvider()
    const service = new QueryAgentService(provider, vi.fn())

    await service.run('是 BOBO', {
      history: [{ question: '我们第一次聊了什么', answer: '你说的是哪位联系人？' }]
    })

    expect(calls[0].messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user'
    ])
  })

  it('传 conversationScope 时把范围说明合并进唯一的 system message', async () => {
    const { provider, calls } = capturingProvider()
    const service = new QueryAgentService(provider, vi.fn())

    await service.run('这个群最近聊了什么', {
      conversationScope: {
        scope: { kind: 'current', conversationId: 'fixture-conversation' },
        label: '当前会话：fixture-group'
      }
    })

    expect(calls[0].messages.map((message) => message.role)).toEqual(['system', 'user'])
    expect(calls[0].messages.filter((message) => message.role === 'system')).toHaveLength(1)
    expect(calls[0].messages[0]).toMatchObject({
      content: expect.stringContaining('当前搜索范围（由应用界面决定）：当前会话：fixture-group。')
    })
    expect(String(calls[0].messages[0].content)).toContain('你是 TraceMemo 的本地聊天查询助手')
  })

  it('失败分类是 additive 字段：成功时不存在', async () => {
    const { provider } = capturingProvider()
    const service = new QueryAgentService(provider, vi.fn())

    const result = await service.run('你好')

    expect(result.errorKind).toBeUndefined()
    expect(result.answer).toBe('ok')
  })

  it('Provider 未配置 / 空问题仍返回可区分的失败分类', async () => {
    const notConfigured = new QueryAgentService(capturingProvider(false).provider, vi.fn())
    const unconfigured = await notConfigured.run('你好')
    expect(unconfigured.errorKind).toBe('provider_unavailable')
    expect(unconfigured.modelCallCount).toBe(0)

    const configured = new QueryAgentService(capturingProvider().provider, vi.fn())
    const empty = await configured.run('   ')
    expect(empty.errorKind).toBe('invalid_question')
  })
})
