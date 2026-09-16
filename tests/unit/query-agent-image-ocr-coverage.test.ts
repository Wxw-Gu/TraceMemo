/**
 * §6 / §7 / §18：图片文字索引覆盖度在 Query Agent 这一层的语义。
 *
 * 这里能确定性验证的是"覆盖度**真的进到了模型上下文**"，而不是只做了个 UI 数字：
 * - 系统提示词把 imageOcrCoverage 定义成**独立于文字索引**的维度，并禁止凭零结果下"没有"；
 * - tool result 透传里真的带着 imageOcrCoverage（模型能看见比例与结论句）。
 *
 * 真模型最终怎么说话不在本文件断言范围内（那需要真实模型与真实数据）。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  QueryAgentService,
  type QueryAgentProvider
} from '../../src/main/services/query-agent-service'

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

/** 与 `buildImageOcrCoverage` 在 partial 时产出的结论句保持一致。 */
const PARTIAL_SUMMARY =
  '图片文字索引只完成 30%（30 / 100 条图片消息），当前图片搜索结果可能不完整。涉及图片、截图、海报里的文字的问题，当前不能因为没搜到就回答"没有"。'

function searchOnce(execute: ReturnType<typeof vi.fn>, finalAnswer: string): QueryAgentProvider {
  return provider([
    {
      success: true,
      toolCalls: [
        {
          id: 'call-1',
          name: 'search_messages',
          arguments: JSON.stringify({
            target: { query: '技术交流群' },
            timeRange: { kind: 'all' },
            queries: ['ChatGPT 价格']
          })
        }
      ]
    },
    { success: true, data: finalAnswer }
  ])
}

describe('Query Agent 的图片文字索引覆盖度语义', () => {
  it('系统提示词把图片覆盖度声明为独立维度，并禁止凭零结果断言"没有"', async () => {
    const execute = vi.fn(async () => ({ status: 'completed', evidenceCount: 0, evidence: [] }))
    const configured = searchOnce(execute, 'ok')
    await new QueryAgentService(configured, execute).run('图片文字索引相关的问题')

    const systemPrompt = String(vi.mocked(configured.chatWithTools).mock.calls[0]?.[0]?.[0]?.content)
    expect(systemPrompt).toContain('imageOcrCoverage')
    expect(systemPrompt).toContain('独立于文字索引')
    expect(systemPrompt).toContain('not_built')
    // 零结果诚实性必须写死在提示词里，不能指望模型自己想到。
    expect(systemPrompt).toContain('绝不能')
  })

  it('partial 覆盖度随 tool result 进入模型上下文，而不是只留在 UI 里', async () => {
    const execute = vi.fn(async () => ({
      status: 'completed',
      coverage: { state: 'partial' },
      evidenceCount: 0,
      evidence: [],
      imageOcrCoverage: {
        state: 'partial',
        totalImageMessages: 100,
        processed: 30,
        indexed: 28,
        empty: 2,
        missing: 0,
        failed: 0,
        pending: 70,
        countedAtLabel: '09-15 20:13',
        summary: PARTIAL_SUMMARY
      }
    }))
    const configured = searchOnce(execute, '图片文字索引只完成 30%，暂时无法确认。')
    await new QueryAgentService(configured, execute).run(
      '技术交流群之前是不是发过 ChatGPT 价格的图片？'
    )

    const toolMessage = vi
      .mocked(configured.chatWithTools)
      .mock.calls[1]?.[0].find((message) => message.role === 'tool')
    const presented = JSON.parse(String(toolMessage?.content)) as Record<string, any>

    expect(presented.imageOcrCoverage).toMatchObject({
      state: 'partial',
      totalImageMessages: 100,
      processed: 30,
      indexed: 28,
      empty: 2,
      pending: 70
    })
    expect(presented.imageOcrCoverage.summary).toContain('不能因为没搜到就回答')
  })

  it('complete 覆盖度不下发零结果约束（避免模型机械附加警告）', async () => {
    const execute = vi.fn(async () => ({
      status: 'completed',
      coverage: { state: 'complete' },
      evidenceCount: 1,
      evidence: [{ messageRef: 'opaque', timestamp: 1, sender: '张三', sourceKind: 'image', text: 'ChatGPT Plus $20' }],
      imageOcrCoverage: {
        state: 'complete',
        totalImageMessages: 100,
        processed: 100,
        indexed: 90,
        empty: 10,
        missing: 0,
        failed: 0,
        pending: 0,
        summary: '图片文字索引已覆盖所统计的全部 100 条图片消息。'
      }
    }))
    const configured = searchOnce(execute, '找到了。')
    await new QueryAgentService(configured, execute).run('技术交流群发过 ChatGPT 价格的图片吗')

    const toolMessage = vi
      .mocked(configured.chatWithTools)
      .mock.calls[1]?.[0].find((message) => message.role === 'tool')
    const presented = JSON.parse(String(toolMessage?.content)) as Record<string, any>
    expect(presented.imageOcrCoverage.state).toBe('complete')
    expect(presented.imageOcrCoverage.summary).not.toContain('不能因为没搜到就回答')
  })
})
