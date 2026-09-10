import { describe, expect, it, vi } from 'vitest'
import { QueryAgentPocService, type QueryAgentProvider } from '../../src/main/services/query-agent-poc-service'

function provider(responses: Array<Awaited<ReturnType<QueryAgentProvider['chatWithTools']>>>, configured = true): QueryAgentProvider {
  return {
    getRuntimeConfig: () => ({ configured, providerName: 'Fixture Provider', model: 'fixture-model', modelName: 'Fixture Model' }),
    chatWithTools: vi.fn(async () => responses.shift() || { success: true, data: 'done' })
  }
}

describe('QueryAgentPocService', () => {
  it('runs a bounded model -> tool -> model loop and records sanitized trace', async () => {
    const execute = vi.fn(async () => ({ status: 'completed', returnedCount: 1, messages: [{ messageRef: 'secret-ref' }] }))
    const service = new QueryAgentPocService(provider([
      { success: true, toolCalls: [{ id: 'call-1', name: 'query_messages', arguments: JSON.stringify({ target: { query: 'BOBO' }, timeRange: { kind: 'all' }, limit: 1 }) }] },
      { success: true, data: '第一条消息是图片。' }
    ]), execute)
    const result = await service.run('我和 BOBO 最开始聊了什么')
    expect(result.answer).toBe('第一条消息是图片。')
    expect(result.modelCallCount).toBe(2)
    expect(result.toolCallCount).toBe(1)
    expect(result.traces[0]).toMatchObject({ toolName: 'query_messages', status: 'completed', resultCount: 1 })
    expect(JSON.stringify(result)).not.toContain('secret-ref')
  })

  it('rejects unknown tools and stops after five calls', async () => {
    const execute = vi.fn(async () => ({ status: 'completed' }))
    const responses = Array.from({ length: 6 }, () => ({ success: true, toolCalls: [{ id: 'x', name: 'unknown', arguments: '{}' }] }))
    const result = await new QueryAgentPocService(provider(responses), execute).run('test')
    expect(result.toolCallCount).toBe(5)
    expect(result.traces.every((trace) => trace.status === 'invalid_request')).toBe(true)
    expect(result.error).toContain('最大工具调用次数')
    expect(execute).not.toHaveBeenCalled()
  })

  it('clarifies unavailable configuration without making a model call', async () => {
    const configuredProvider = provider([], false)
    const result = await new QueryAgentPocService(configuredProvider, vi.fn()).run('test')
    expect(result.error).toContain('尚未配置')
    expect(configuredProvider.chatWithTools).not.toHaveBeenCalled()
  })
})
