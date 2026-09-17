import { describe, expect, it, vi } from 'vitest'
import {
  QueryAgentService,
  type QueryAgentProvider,
  type QueryAgentToolResult
} from '../../src/main/services/query-agent-service'
import type { AIChatToolCall } from '../../src/main/services/ai-provider-service'

/**
 * Query Agent 的稳定 Citation 契约。
 *
 * 四个必须同时成立的条件（缺一，正文里的 `[E#]` 就会消失或变成幻觉引用）：
 * 1. Host 在**模型调用之前**给 evidence 分配稳定 `citationId`，同一 messageRef 只分配一次；
 * 2. `citationId` 随 Tool Result 进入**模型可见**上下文（模型只能引用它见过的编号）；
 * 3. 模型可见编号集合 ⊆ UI 可见集合，且同号（UI 证据卡 / 底部引用按钮不另行编号）；
 * 4. 回答返回前经 Host 校验：非法 `[E#]` 移除并回报，绝不进 UI。
 */

function provider(
  responses: Array<Awaited<ReturnType<QueryAgentProvider['chatWithTools']>>>,
  configured = true
): QueryAgentProvider {
  return {
    getRuntimeConfig: () => ({
      configured,
      providerName: 'Fixture Provider',
      model: 'fixture-model',
      modelName: 'Fixture Model'
    }),
    chatWithTools: vi.fn(async () => responses.shift() || { success: true, data: 'done' })
  }
}

const queryMessagesCall = (id: string): AIChatToolCall => ({
  id,
  name: 'query_messages',
  arguments: JSON.stringify({
    target: { query: 'BOBO' },
    timeRange: { kind: 'all' },
    temporalBasis: { kind: 'none' },
    limit: 5
  })
})

const searchCall = (id: string): AIChatToolCall => ({
  id,
  name: 'search_messages',
  arguments: JSON.stringify({
    target: { query: 'BOBO' },
    timeRange: { kind: 'all' },
    queries: ['topic']
  })
})

const contextCall = (id: string, messageRef: string): AIChatToolCall => ({
  id,
  name: 'message_context',
  arguments: JSON.stringify({ messageRef, before: 1, after: 1 })
})

/** 从第 N 次模型调用里取出 tool 消息内容。 */
const toolMessageOf = (mocked: QueryAgentProvider, callIndex: number): Record<string, unknown> => {
  const messages = vi.mocked(mocked.chatWithTools).mock.calls[callIndex]?.[0] || []
  const toolMessage = messages.find((message) => message.role === 'tool')
  expect(toolMessage, `第 ${callIndex + 1} 次模型调用应带 tool 消息`).toBeTruthy()
  return JSON.parse(String(toolMessage?.content)) as Record<string, unknown>
}

describe('Query Agent Citation — Host 分配稳定编号', () => {
  it('首次命中即分配 E1、E2…，顺序与 evidence 契约一致', async () => {
    const execute = vi.fn(
      async (): Promise<QueryAgentToolResult> => ({
        status: 'completed',
        returnedCount: 2,
        messages: [{ messageRef: 'ref-1' }, { messageRef: 'ref-2' }]
      })
    )
    const service = new QueryAgentService(
      provider([
        { success: true, toolCalls: [queryMessagesCall('call-1')] },
        { success: true, data: '读到了两条。' }
      ]),
      execute
    )
    const result = await service.run('我和 BOBO 最开始聊了什么')

    expect(result.evidence?.map((item) => item.citationId)).toEqual(['E1', 'E2'])
    expect(result.evidence?.map((item) => item.messageRef)).toEqual(['ref-1', 'ref-2'])
  })

  it('同一 messageRef 被第二个 Tool 再次命中时保持原 citationId，不重排、不新增', async () => {
    const execute = vi.fn(async (name: string, input: Record<string, unknown>) => {
      if (name === 'search_messages') {
        return {
          status: 'completed',
          evidenceCount: 2,
          evidence: [{ messageRef: 'ref-1' }, { messageRef: 'ref-2' }]
        } as QueryAgentToolResult
      }
      // message_context：anchor 就是被补语境的那条证据（ref-2 再次命中），
      // before/after 不是本次结论的依据，不该进证据列表。
      return {
        status: 'completed',
        anchor: { messageRef: String(input.messageRef) },
        before: [{ messageRef: 'before-1' }],
        after: [{ messageRef: 'after-1' }]
      } as QueryAgentToolResult
    })
    const configuredProvider = provider([
      { success: true, toolCalls: [searchCall('call-1')] },
      { success: true, toolCalls: [contextCall('call-2', 'ref-2')] },
      { success: true, data: '第二条更重要[E2]。' }
    ])
    const result = await new QueryAgentService(configuredProvider, execute).run('查找相关记录')

    // ref-1 → E1，ref-2 → E2；ref-2 被 context 再次命中后编号不变
    expect(result.evidence?.map((item) => ({ ref: item.messageRef, id: item.citationId }))).toEqual(
      [
        { ref: 'ref-1', id: 'E1' },
        { ref: 'ref-2', id: 'E2' }
      ]
    )
    // before/after 不进证据列表
    expect(result.evidence?.some((item) => String(item.messageRef).startsWith('before'))).toBe(
      false
    )
  })

  it('citationId 随 Tool Result 进入模型可见上下文（否则模型无从引用）', async () => {
    const execute = vi.fn(
      async (): Promise<QueryAgentToolResult> => ({
        status: 'completed',
        returnedCount: 2,
        messages: [{ messageRef: 'ref-1' }, { messageRef: 'ref-2' }]
      })
    )
    const configuredProvider = provider([
      { success: true, toolCalls: [queryMessagesCall('call-1')] },
      { success: true, data: '完成。' }
    ])
    const result = await new QueryAgentService(configuredProvider, execute).run('第一条消息')

    const presented = toolMessageOf(configuredProvider, 1)
    const presentedEvidence = presented.messages as Array<Record<string, unknown>>
    expect(presentedEvidence.map((item) => item.citationId)).toEqual(['E1', 'E2'])
    // 模型可见编号集合 == 契约编号集合（同号，不是另一套 index）
    expect(presentedEvidence.map((item) => item.citationId)).toEqual(
      result.evidence?.map((item) => item.citationId)
    )
  })

  it('超过证据上限的条目不分配编号，也不带 citationId 进模型上下文', async () => {
    const limit = 40
    const execute = vi.fn(
      async (): Promise<QueryAgentToolResult> => ({
        status: 'completed',
        returnedCount: limit + 5,
        messages: Array.from({ length: limit + 5 }, (_, index) => ({
          messageRef: `ref-${index + 1}`
        }))
      })
    )
    const configuredProvider = provider([
      { success: true, toolCalls: [queryMessagesCall('call-1')] },
      { success: true, data: '完成。' }
    ])
    const result = await new QueryAgentService(configuredProvider, execute).run('第一条消息')

    expect(result.evidence).toHaveLength(limit)
    expect(result.evidence?.at(-1)?.citationId).toBe(`E${limit}`)
    // 第 41 条以后没有编号：模型上下文里也不该出现它们的 citationId
    const presented = toolMessageOf(configuredProvider, 1).messages as Array<
      Record<string, unknown>
    >
    const cited = presented.filter((item) => typeof item.citationId === 'string')
    expect(cited).toHaveLength(limit)
    expect(presented.filter((item) => item.messageRef === 'ref-41')[0]?.citationId).toBeUndefined()
  })
})

describe('Query Agent Citation — Host 侧校验，幻觉编号不得进入 UI', () => {
  it('合法的 [E#] 原样保留', async () => {
    const execute = vi.fn(
      async (): Promise<QueryAgentToolResult> => ({
        status: 'completed',
        returnedCount: 1,
        messages: [{ messageRef: 'ref-1' }]
      })
    )
    const service = new QueryAgentService(
      provider([
        { success: true, toolCalls: [queryMessagesCall('call-1')] },
        { success: true, data: '张三提到健身[E1]。' }
      ]),
      execute
    )
    const result = await service.run('第一条消息')

    expect(result.answer).toBe('张三提到健身[E1]。')
    expect(result.invalidCitationIds).toBeUndefined()
  })

  it('不存在的 [E#] 被移除并回报 invalidCitationIds', async () => {
    const execute = vi.fn(
      async (): Promise<QueryAgentToolResult> => ({
        status: 'completed',
        returnedCount: 1,
        messages: [{ messageRef: 'ref-1' }]
      })
    )
    const service = new QueryAgentService(
      provider([
        { success: true, toolCalls: [queryMessagesCall('call-1')] },
        { success: true, data: '张三提到健身[E1] ，另有来源[E9][E99]。' }
      ]),
      execute
    )
    const result = await service.run('第一条消息')

    expect(result.answer).toContain('[E1]')
    expect(result.answer).not.toMatch(/\[E(?:9|99)\]/)
    expect(result.invalidCitationIds).toEqual(['E9', 'E99'])
  })

  it('本轮没有任何证据时，回答里的 [E#] 一律移除', async () => {
    const configuredProvider = provider([{ success: true, data: '这个群今天聊了健身[E1]。' }])
    const result = await new QueryAgentService(configuredProvider, vi.fn()).run('闲聊')

    expect(result.answer).toBe('这个群今天聊了健身。')
    expect(result.invalidCitationIds).toEqual(['E1'])
    // 没有 Tool 就没有证据：白名单为空，所以任何编号都不成立。
    // （Runtime 不主动造空数组，Adapter 侧按 `|| []` 兜底，与既有契约一致。）
    expect(result.evidence ?? []).toEqual([])
  })
})
