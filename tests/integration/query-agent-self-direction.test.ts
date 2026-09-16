/**
 * Query Agent 的**说话人方向**语义（self sender）。
 *
 * 真机回归：问「我给文件传输助手发了什么图片」，planner 第一次用了 `from_target`
 * （= 对方发来），拿到 0 条后**回头问用户"是不是方向搞错了"**，而不是自己改向重查。
 *
 * 代码事实：direction 的词表是**以目标会话为参照**的 ——
 * `to_target` = 我发出的（self sender），`from_target` = 对方发来的。
 * 所以这不是"缺一个方向取值"，而是 planner 选错了值 + 0 结果后没有利用既有重试机制。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

process.env.TZ = 'Asia/Shanghai'

const fixture = vi.hoisted(() => {
  const selfImageTime = Date.parse('2026-09-10T10:00:00+08:00')
  const otherImageTime = Date.parse('2026-09-11T11:00:00+08:00')
  return {
    selfImageTime,
    otherImageTime,
    contacts: [
      {
        m_nsUsrName: 'filehelper',
        m_nsNickName: '文件传输助手',
        md5: 'md5-filehelper',
        type: 'user' as const
      }
    ],
    messages: [
      {
        id: '1001',
        localId: '1001',
        from: 'assistant',
        // 我发出的图片：isSender = true（自我身份来自 mesDes，不是昵称）
        type: '图片',
        datetime: '2026/9/10 10:00:00',
        content: '',
        contentData: { type: 'image', md5: 'md5-self-image', datName: 'dat-self' },
        isSender: true,
        name: '我',
        createTime: Math.floor(selfImageTime / 1000)
      },
      {
        id: '1002',
        localId: '1002',
        from: 'user',
        // 对方发来的图片
        type: '图片',
        datetime: '2026/9/11 11:00:00',
        content: '',
        contentData: { type: 'image', md5: 'md5-other-image', datName: 'dat-other' },
        isSender: false,
        name: '文件传输助手',
        createTime: Math.floor(otherImageTime / 1000)
      }
    ]
  }
})

vi.mock('../../src/main/services/chat-service', () => ({
  isReady: () => true,
  listContactsAsync: vi.fn(async () => fixture.contacts),
  listMessagesAsync: vi.fn(async () => fixture.messages)
}))

import { LocalQueryApiService } from '../../src/main/services/local-query-api-service'
import { createLocalQueryToolExecutor } from '../../src/main/services/local-query-tool-executor'
import {
  QueryAgentService,
  type QueryAgentProvider
} from '../../src/main/services/query-agent-service'

function makeKnowledge() {
  return {
    search: vi.fn(async () => ({ state: 'ready', evidence: [] })),
    requestCatchUp: vi.fn(() => ({ triggered: false, inProgress: false })),
    waitForIndexingComplete: vi.fn(async () => false),
    lastPassDurationMs: vi.fn(() => 0),
    beginInteractiveQuery: vi.fn(),
    endInteractiveQuery: vi.fn()
  } as never
}

function makeService(): LocalQueryApiService {
  return new LocalQueryApiService(makeKnowledge(), () => new Date('2026-09-16T09:00:00+08:00'))
}

const queryArgs = (direction: string): string =>
  JSON.stringify({
    target: { query: '文件传输助手' },
    timeRange: { kind: 'all' },
    temporalBasis: { kind: 'none' },
    direction,
    messageTypes: ['image']
  })

describe('direction 语义：to_target = 我发出的（self sender）', () => {
  let service: LocalQueryApiService
  beforeEach(() => {
    service = makeService()
  })

  it('to_target 只返回我发出的图片，排除对方发来的', async () => {
    const result = await service.messages({
      target: { query: '文件传输助手' },
      timeRange: { kind: 'all' },
      direction: 'to_target',
      messageTypes: ['image']
    } as never)

    expect(result.status).toBe('completed')
    expect(result.messages?.map((message) => message.messageRef)).toHaveLength(1)
    expect(result.messages?.[0].direction).toBe('to_target')
    expect(result.messages?.[0].sender).toBe('我')
    expect(result.query?.direction).toBe('to_target')
  })

  it('from_target 只返回对方发来的图片', async () => {
    const result = await service.messages({
      target: { query: '文件传输助手' },
      timeRange: { kind: 'all' },
      direction: 'from_target',
      messageTypes: ['image']
    } as never)

    expect(result.messages).toHaveLength(1)
    expect(result.messages?.[0].direction).toBe('from_target')
    expect(result.messages?.[0].sender).toBe('文件传输助手')
  })
})

describe('Query Agent：方向选反后必须自己改向重查，而不是问用户', () => {
  function provider(
    responses: Array<Awaited<ReturnType<QueryAgentProvider['chatWithTools']>>>
  ): QueryAgentProvider {
    return {
      getRuntimeConfig: () => ({
        configured: true,
        providerName: 'Fixture Provider',
        model: 'fixture-model',
        modelName: 'Fixture Model'
      }),
      chatWithTools: vi.fn(async () => responses.shift() || { success: true, data: 'done' })
    }
  }

  it('系统提示词把「我给 X 发」明确映射到 to_target，并禁止因此反问用户', () => {
    const scripted = provider([{ success: true, data: 'ok' }])
    const service = makeService()
    const executor = createLocalQueryToolExecutor(service)
    void new QueryAgentService(scripted, executor).run('我给文件传输助手发了什么图片')

    const systemPrompt = String(vi.mocked(scripted.chatWithTools).mock.calls[0]?.[0]?.[0]?.content)
    expect(systemPrompt).toContain('说话人是我 → to_target')
    expect(systemPrompt).toContain('说话人是对方 → from_target')
    // 提示词里明确禁止"因为方向可能错就反问用户"
    expect(systemPrompt).toContain('要不要换个方向')
  })

  it('第一次用错方向得到 0 条 → tool result 明确要求改向重查；第二次查对 → 命中我发出的图片', async () => {
    /**
     * 只保留"我发出的"那一张：这样用错方向（from_target = 对方发来）必然 0 条，
     * 才能真实复现"第一次查反了"的场景。
     */
    const originalMessages = fixture.messages
    fixture.messages = [originalMessages[0]] as typeof fixture.messages
    const configured = provider([
      // 第一次：方向选反（对方发来）
      { success: true, toolCalls: [{ id: 'c1', name: 'query_messages', arguments: queryArgs('from_target') }] },
      // 第二次：改向（我发出的）
      { success: true, toolCalls: [{ id: 'c2', name: 'query_messages', arguments: queryArgs('to_target') }] },
      { success: true, data: '你给文件传输助手发过 1 张图片。' }
    ])
    const service = makeService()
    const executor = createLocalQueryToolExecutor(service)
    const result = await new QueryAgentService(configured, executor).run(
      '我给文件传输助手发了什么图片'
    )

    const calls = vi.mocked(configured.chatWithTools).mock.calls
    const firstToolResult = JSON.parse(
      String(calls[1]?.[0].find((message) => message.role === 'tool')?.content)
    ) as Record<string, any>

    // 0 条确实发生了（说明 fixture 的方向过滤是真的在起作用）
    expect(firstToolResult.returnedCount).toBe(0)
    // 重试提示必须点明"方向选反"这件事，并且**禁止**反问用户
    expect(String(firstToolResult._agent?.note)).toContain('方向选反')
    expect(String(firstToolResult._agent?.note)).toContain('不要问用户')
    // 重试通道仍然开放（这正是既有 zero-result retry 机制）
    expect(firstToolResult._agent?.note).toContain('to_target')

    // 取**最后一条** tool 消息：第三次调用的上下文里已经有两次 tool result。
    const secondToolResult = JSON.parse(
      String(
        calls[2]?.[0].filter((message) => message.role === 'tool').at(-1)?.content
      )
    ) as Record<string, any>
    expect(secondToolResult.returnedCount).toBe(1)
    expect(secondToolResult.messages?.[0].direction).toBe('to_target')

    // 最终答案基于第二次（正确方向）的结果
    expect(result.answer).toContain('发过')
    expect(result.toolCallCount).toBe(2)

    fixture.messages = originalMessages
  })

  it('正常情况下第一次就查对：一次 tool call 命中，不需要重试', async () => {
    const configured = provider([
      { success: true, toolCalls: [{ id: 'c1', name: 'query_messages', arguments: queryArgs('to_target') }] },
      { success: true, data: '你给文件传输助手发过 1 张图片。' }
    ])
    const service = makeService()
    const executor = createLocalQueryToolExecutor(service)
    const result = await new QueryAgentService(configured, executor).run(
      '我给文件传输助手发了什么图片'
    )

    expect(result.toolCallCount).toBe(1)
    const calls = vi.mocked(configured.chatWithTools).mock.calls
    const toolResult = JSON.parse(
      String(calls[1]?.[0].find((message) => message.role === 'tool')?.content)
    ) as Record<string, any>
    expect(toolResult.returnedCount).toBe(1)
    expect(toolResult.messages?.[0].direction).toBe('to_target')
  })
})
