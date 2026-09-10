import { describe, expect, it, vi } from 'vitest'
import { QueryAgentPocService, type QueryAgentProvider, validateToolArguments } from '../../src/main/services/query-agent-poc-service'

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
    expect(result.traces.every((trace) => trace.status === 'invalid_tool_arguments')).toBe(true)
    expect(result.error).toContain('最大工具调用次数')
    expect(execute).not.toHaveBeenCalled()
  })

  it('clarifies unavailable configuration without making a model call', async () => {
    const configuredProvider = provider([], false)
    const result = await new QueryAgentPocService(configuredProvider, vi.fn()).run('test')
    expect(result.error).toContain('尚未配置')
    expect(configuredProvider.chatWithTools).not.toHaveBeenCalled()
  })

  it('accepts schema-valid variants and rejects invalid arguments before executing a tool', async () => {
    const execute = vi.fn(async () => ({ status: 'completed', returnedCount: 0 }))
    const valid = await new QueryAgentPocService(provider([
      { success: true, toolCalls: [{ id: 'valid', name: 'search_messages', arguments: JSON.stringify({ target: { query: 'BOBO' }, timeRange: { kind: 'all' }, query: '答应', variants: ['承诺', '保证', '说好', '一定'] }) }] },
      { success: true, data: 'done' }
    ]), execute).run('test')
    expect(valid.traces[0]).toMatchObject({ status: 'completed', toolName: 'search_messages' })
    expect(execute).toHaveBeenCalledTimes(1)

    execute.mockClear()
    const invalid = await new QueryAgentPocService(provider([
      { success: true, toolCalls: [{ id: 'invalid', name: 'search_messages', arguments: JSON.stringify({ target: { query: 'BOBO' }, timeRange: { kind: 'all' }, query: '答应', variants: ['1', '2', '3', '4', '5'] }) }] },
      { success: true, data: '修正后完成' }
    ]), execute).run('test')
    expect(invalid.traces[0]).toMatchObject({ status: 'invalid_tool_arguments' })
    expect(invalid.traces[0].resultCount).toBeUndefined()
    expect(execute).not.toHaveBeenCalled()
  })

  it('enforces generic nested tool schema constraints', () => {
    const base = { target: { query: 'BOBO' }, timeRange: { kind: 'all' }, query: 'x' }
    expect(validateToolArguments('search_messages', { ...base, variants: ['1', '2', '3', '4'] }).error).toBeUndefined()
    expect(validateToolArguments('search_messages', { ...base, variants: ['1', '2', '3', '4', '5'] }).error).toMatchObject({ field: 'variants', constraint: 'maxItems', expected: 4, actual: 5 })
    expect(validateToolArguments('search_messages', { ...base, extra: true }).error).toMatchObject({ field: 'extra', constraint: 'additionalProperties' })
    expect(validateToolArguments('query_messages', { target: { query: 'BOBO' }, timeRange: { kind: 'all' }, direction: 'sideways' }).error).toMatchObject({ field: 'direction', constraint: 'enum' })
    expect(validateToolArguments('query_messages', { target: { query: '' }, timeRange: { kind: 'all' } }).error).toMatchObject({ field: 'target.query', constraint: 'minLength' })
    expect(validateToolArguments('query_messages', { target: { query: 'BOBO' }, timeRange: { kind: 'all' }, limit: 0 }).error).toMatchObject({ field: 'limit', constraint: 'minimum' })
    expect(validateToolArguments('message_context', { messageRef: 'opaque', before: 51 }).error).toMatchObject({ field: 'before', constraint: 'maximum' })
  })
})
