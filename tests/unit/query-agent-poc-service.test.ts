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

  it('presents planning boundaries and remaining budget with tool results', async () => {
    const execute = vi.fn(async () => ({
      status: 'completed',
      evidenceCount: 1,
      sourceCoverage: { state: 'complete', sourceMessageCount: 10 },
      selection: { mode: 'temporal_coverage', selectedEvidenceCount: 1, sampled: true },
      evidence: [{ messageRef: 'opaque', timestamp: 1, sender: 'BOBO', sourceKind: 'image', text: 'caption' }]
    }))
    const configuredProvider = provider([
      { success: true, toolCalls: [{ id: 'call-1', name: 'search_messages', arguments: JSON.stringify({ target: { query: 'BOBO' }, timeRange: { kind: 'all' }, queries: ['topic'] }) }] },
      { success: true, data: '根据这条证据可以回答。' }
    ])
    await new QueryAgentPocService(configuredProvider, execute).run('查找相关记录')
    const calls = vi.mocked(configuredProvider.chatWithTools).mock.calls
    const firstMessages = calls[0]?.[0] || []
    expect(String(firstMessages[0]?.content)).toContain('Evidence 是否已经足以')
    const toolMessage = calls[1]?.[0].find((message) => message.role === 'tool')
    const presented = JSON.parse(String(toolMessage?.content)) as Record<string, any>
    expect(presented._agent).toMatchObject({ toolName: 'search_messages', toolCallsUsed: 1, toolCallsRemaining: 4, availableNextTools: ['message_context'] })
    expect(presented.evidence[0]).toMatchObject({ sourceKind: 'image', messageType: 'image', text: 'caption' })
    expect(presented.sourceCoverage).toEqual({ state: 'complete', sourceMessageCount: 10 })
    expect(calls[1]?.[1].map((tool) => tool.function.name)).toEqual(['message_context'])
  })

  it('removes tools after a sufficient exact result', async () => {
    const configuredProvider = provider([
      { success: true, toolCalls: [{ id: 'call-1', name: 'query_messages', arguments: JSON.stringify({ target: { query: 'BOBO' }, timeRange: { kind: 'all' }, limit: 1 }) }] },
      { success: true, data: '完成' }
    ])
    await new QueryAgentPocService(configuredProvider, vi.fn(async () => ({ status: 'completed', returnedCount: 1 }))).run('第一条消息')
    expect(vi.mocked(configuredProvider.chatWithTools).mock.calls[1]?.[1]).toEqual([])
  })

  it('does not execute a tool that is unavailable after the stopping boundary', async () => {
    const execute = vi.fn(async () => ({ status: 'completed', returnedCount: 1 }))
    const configuredProvider = provider([
      { success: true, toolCalls: [{ id: 'call-1', name: 'query_messages', arguments: JSON.stringify({ target: { query: 'BOBO' }, timeRange: { kind: 'all' }, limit: 1 }) }] },
      { success: true, toolCalls: [{ id: 'call-2', name: 'conversation_overview', arguments: JSON.stringify({ target: { query: 'BOBO' }, timeRange: { kind: 'all' } }) }] },
      { success: true, data: '完成' }
    ])
    const result = await new QueryAgentPocService(configuredProvider, execute).run('第一条消息')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(result.traces[1]).toMatchObject({ toolName: 'conversation_overview', status: 'invalid_tool_arguments' })
    const thirdCallMessages = vi.mocked(configuredProvider.chatWithTools).mock.calls[2]?.[0] || []
    const unavailableResult = thirdCallMessages.findLast((message) => message.role === 'tool')
    expect(String(unavailableResult?.content)).toContain('tool_availability')
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

  it('maps LLM queries[] to the Local Query API query + variants contract', async () => {
    const execute = vi.fn(async () => ({ status: 'completed', returnedCount: 0 }))
    const valid = await new QueryAgentPocService(provider([
      { success: true, toolCalls: [{ id: 'valid', name: 'search_messages', arguments: JSON.stringify({ target: { query: 'BOBO' }, timeRange: { kind: 'all' }, queries: ['答应', '承诺', '保证', '说好'] }) }] },
      { success: true, data: 'done' }
    ]), execute).run('test')
    expect(valid.traces[0]).toMatchObject({ status: 'completed', toolName: 'search_messages' })
    expect(execute).toHaveBeenCalledTimes(1)
    // Local Query API 仍然只认 query + variants，Host 负责映射。
    expect(execute.mock.calls[0][1]).toMatchObject({ query: '答应', variants: ['承诺', '保证', '说好'] })
    expect(execute.mock.calls[0][1]).not.toHaveProperty('queries')

    execute.mockClear()
    const invalid = await new QueryAgentPocService(provider([
      { success: true, toolCalls: [{ id: 'invalid', name: 'search_messages', arguments: JSON.stringify({ target: { query: 'BOBO' }, timeRange: { kind: 'all' }, queries: ['1', '2', '3', '4', '5'] }) }] },
      { success: true, data: '修正后完成' }
    ]), execute).run('test')
    expect(invalid.traces[0]).toMatchObject({ status: 'invalid_tool_arguments' })
    expect(invalid.traces[0].resultCount).toBeUndefined()
    expect(execute).not.toHaveBeenCalled()
  })

  it('enforces generic nested tool schema constraints', () => {
    const base = { target: { query: 'BOBO' }, timeRange: { kind: 'all' }, queries: ['x'] }
    expect(validateToolArguments('search_messages', { ...base, queries: ['1', '2', '3', '4'] }).error).toBeUndefined()
    expect(validateToolArguments('search_messages', { ...base, queries: ['1', '2', '3', '4', '5'] }).error).toMatchObject({ field: 'queries', constraint: 'maxItems', expected: 4, actual: 5 })
    expect(validateToolArguments('search_messages', { ...base, queries: [] }).error).toMatchObject({ field: 'queries', constraint: 'minItems', expected: 1, actual: 0 })
    expect(validateToolArguments('search_messages', { ...base, extra: true }).error).toMatchObject({ field: 'extra', constraint: 'additionalProperties' })
    // 旧的 query 字段已不再是合法属性，必须被拒绝而不是静默忽略。
    expect(validateToolArguments('search_messages', { ...base, query: 'x' }).error).toMatchObject({ field: 'query', constraint: 'additionalProperties' })
    // 漏掉 queries 时按 required 拒绝。
    expect(validateToolArguments('search_messages', { target: { query: 'BOBO' }, timeRange: { kind: 'all' } }).error).toMatchObject({ field: 'queries', constraint: 'required' })
    expect(validateToolArguments('query_messages', { target: { query: 'BOBO' }, timeRange: { kind: 'all' }, direction: 'sideways' }).error).toMatchObject({ field: 'direction', constraint: 'enum' })
    expect(validateToolArguments('query_messages', { target: { query: '' }, timeRange: { kind: 'all' } }).error).toMatchObject({ field: 'target.query', constraint: 'minLength' })
    expect(validateToolArguments('query_messages', { target: { query: 'BOBO' }, timeRange: { kind: 'all' }, limit: 0 }).error).toMatchObject({ field: 'limit', constraint: 'minimum' })
    expect(validateToolArguments('message_context', { messageRef: 'opaque', before: 51 }).error).toMatchObject({ field: 'before', constraint: 'maximum' })
  })

  it('rejects a whitespace-only search probe instead of sending an empty query', () => {
    const error = validateToolArguments('search_messages', { target: { query: 'BOBO' }, timeRange: { kind: 'all' }, queries: ['   '] }).error
    expect(error).toMatchObject({ field: 'queries', constraint: 'required' })
  })
})

describe('QueryAgent absolute time contract', () => {
  const now = new Date('2026-09-10T00:00:00Z')
  const target = { query: 'BOBO' }

  function canonical(timeRange: Record<string, unknown>) {
    return validateToolArguments('query_messages', { target, timeRange }, now)
  }

  it('canonicalizes an ISO-8601 absolute range with offset into Local Query API epoch seconds', () => {
    const result = canonical({ kind: 'absolute', startTime: '2025-08-01T00:00:00+08:00', endTime: '2025-09-01T00:00:00+08:00' })
    expect(result.error).toBeUndefined()
    expect(result.input?.timeRange).toEqual({
      kind: 'absolute',
      startTime: Math.floor(Date.parse('2025-07-31T16:00:00Z') / 1000),
      endTime: Math.floor(Date.parse('2025-08-31T16:00:00Z') / 1000)
    })
  })

  it('round-trips seconds and ISO to the same instant', () => {
    const result = canonical({ kind: 'absolute', startTime: '2025-08-13T03:27:34Z', endTime: '2025-08-13T04:00:00Z' })
    const startSeconds = (result.input?.timeRange as { startTime: number }).startTime
    expect(startSeconds).toBe(Math.floor(1755055654000 / 1000))
    expect(new Date(startSeconds * 1000).toISOString()).toBe('2025-08-13T03:27:34.000Z')
  })

  it('treats equivalent offsets as the same instant', () => {
    const beijing = canonical({ kind: 'absolute', startTime: '2025-08-01T00:00:00+08:00', endTime: '2025-08-02T00:00:00+08:00' })
    const utc = canonical({ kind: 'absolute', startTime: '2025-07-31T16:00:00Z', endTime: '2025-08-01T16:00:00Z' })
    expect(beijing.input?.timeRange).toEqual(utc.input?.timeRange)
  })

  it('supports cross-year ranges', () => {
    const result = canonical({ kind: 'absolute', startTime: '2025-12-31T20:00:00+08:00', endTime: '2026-01-01T04:00:00+08:00' })
    const range = result.input?.timeRange as { startTime: number; endTime: number }
    expect(result.error).toBeUndefined()
    expect(range.endTime).toBeGreaterThan(range.startTime)
    expect(new Date(range.startTime * 1000).toISOString()).toBe('2025-12-31T12:00:00.000Z')
    expect(new Date(range.endTime * 1000).toISOString()).toBe('2025-12-31T20:00:00.000Z')
  })

  it('never lets millisecond epoch numbers reach the executor silently', () => {
    const error = canonical({ kind: 'absolute', startTime: 1753977600000, endTime: 1756656000000 }).error
    expect(error).toMatchObject({ field: 'timeRange.startTime', constraint: 'type', expected: 'string', actual: 'number' })
  })

  it('rejects naive local datetimes without a timezone', () => {
    expect(canonical({ kind: 'absolute', startTime: '2025-08-01T00:00:00', endTime: '2025-09-01T00:00:00' }).error).toMatchObject({ field: 'timeRange.startTime', constraint: 'format' })
  })

  it('rejects invalid calendar days and out-of-range clock values', () => {
    expect(canonical({ kind: 'absolute', startTime: '2026-02-31T00:00:00Z', endTime: '2026-03-01T00:00:00Z' }).error).toMatchObject({ field: 'timeRange.startTime', constraint: 'format' })
    expect(canonical({ kind: 'absolute', startTime: '2026-03-01T25:00:00Z', endTime: '2026-03-02T00:00:00Z' }).error).toMatchObject({ field: 'timeRange.startTime', constraint: 'format' })
  })

  it('rejects start after end', () => {
    expect(canonical({ kind: 'absolute', startTime: '2026-03-02T00:00:00Z', endTime: '2026-03-01T00:00:00Z' }).error).toMatchObject({ field: 'timeRange.endTime', constraint: 'range_order' })
  })

  it('rejects absurd future and past ranges instead of returning complete-zero', () => {
    expect(canonical({ kind: 'absolute', startTime: '2999-01-01T00:00:00Z', endTime: '2999-02-01T00:00:00Z' }).error).toMatchObject({ field: 'timeRange.startTime', constraint: 'range_sanity' })
    expect(canonical({ kind: 'absolute', startTime: '1999-01-01T00:00:00Z', endTime: '1999-02-01T00:00:00Z' }).error).toMatchObject({ field: 'timeRange.startTime', constraint: 'range_sanity' })
    expect(canonical({ kind: 'absolute', startTime: '57526-01-01T00:00:00Z', endTime: '57526-02-01T00:00:00Z' }).error).toMatchObject({ field: 'timeRange.startTime', constraint: 'format' })
  })

  it('drops stray startTime/endTime for non-absolute kinds', () => {
    expect(canonical({ kind: 'all', startTime: '2026-01-01T00:00:00Z', endTime: '2026-02-01T00:00:00Z' }).input?.timeRange).toEqual({ kind: 'all' })
    expect(canonical({ kind: 'previous_month' }).input?.timeRange).toEqual({ kind: 'previous_month' })
  })

  it('requires both bounds for absolute ranges', () => {
    expect(canonical({ kind: 'absolute', startTime: '2026-01-01T00:00:00Z' }).error).toMatchObject({ field: 'timeRange.startTime', constraint: 'required' })
  })
})

describe('QueryAgent zero-result limited retry', () => {
  function searchCall(id: string, queries: string[], timeRange: Record<string, unknown> = { kind: 'all' }) {
    return { success: true as const, toolCalls: [{ id, name: 'search_messages', arguments: JSON.stringify({ target: { query: 'BOBO' }, timeRange, queries }) }] }
  }
  function queryCall(id: string, timeRange: Record<string, unknown> = { kind: 'all' }) {
    return { success: true as const, toolCalls: [{ id, name: 'query_messages', arguments: JSON.stringify({ target: { query: 'BOBO' }, timeRange }) }] }
  }
  const emptySearch = async () => ({ status: 'completed', evidenceCount: 0, evidence: [] })
  const emptyQuery = async () => ({ status: 'completed', returnedCount: 0, messages: [] })

  it('keeps search_messages available once after a zero-evidence search', async () => {
    const execute = vi.fn(emptySearch)
    const configured = provider([searchCall('c1', ['答应']), { success: true, data: '没有找到相关证据。' }])
    await new QueryAgentPocService(configured, execute).run('找承诺')
    expect(vi.mocked(configured.chatWithTools).mock.calls[1]?.[1].map((tool) => tool.function.name)).toEqual(['search_messages'])
    const toolMessage = vi.mocked(configured.chatWithTools).mock.calls[1]?.[0].find((message) => message.role === 'tool')
    const presented = JSON.parse(String(toolMessage?.content)) as Record<string, any>
    expect(presented._agent).toMatchObject({ toolCallsUsed: 1, availableNextTools: ['search_messages'] })
    expect(String(presented._agent.note)).toContain('实质不同')
  })

  it('allows exactly one substantively different second search and then closes tools', async () => {
    const execute = vi.fn(emptySearch)
    const configured = provider([searchCall('c1', ['答应']), searchCall('c2', ['公积金']), { success: true, data: '仍然没有。' }])
    const result = await new QueryAgentPocService(configured, execute).run('找承诺')
    expect(execute).toHaveBeenCalledTimes(2)
    expect(result.traces.map((trace) => trace.status)).toEqual(['completed', 'completed'])
    expect(vi.mocked(configured.chatWithTools).mock.calls[2]?.[1]).toEqual([])
    expect(result.error).toBeUndefined()
  })

  it('rejects an identical search retry instead of spending the budget again', async () => {
    const execute = vi.fn(emptySearch)
    const configured = provider([searchCall('c1', ['答应']), searchCall('c2', ['答应']), { success: true, data: '没有找到。' }])
    const result = await new QueryAgentPocService(configured, execute).run('找承诺')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(result.traces[1]).toMatchObject({ status: 'invalid_tool_arguments' })
    expect(vi.mocked(configured.chatWithTools).mock.calls[2]?.[1]).toEqual([])
    const toolMessage = vi.mocked(configured.chatWithTools).mock.calls[2]?.[0].findLast((message) => message.role === 'tool')
    expect(String(toolMessage?.content)).toContain('duplicate_retry')
  })

  it('treats a reordered identical probe set as an identical retry', async () => {
    const execute = vi.fn(emptySearch)
    const configured = provider([searchCall('c1', ['答应', '承诺']), searchCall('c2', ['承诺', '答应']), { success: true, data: 'x' }])
    const result = await new QueryAgentPocService(configured, execute).run('找承诺')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(result.traces[1].status).toBe('invalid_tool_arguments')
  })

  it('keeps the efficient path when the first search already returned evidence', async () => {
    const execute = vi.fn(async () => ({ status: 'completed', evidenceCount: 2, evidence: [{ messageRef: 'ref', text: 't' }] }))
    const configured = provider([searchCall('c1', ['答应']), { success: true, data: 'ok' }])
    await new QueryAgentPocService(configured, execute).run('找承诺')
    expect(vi.mocked(configured.chatWithTools).mock.calls[1]?.[1].map((tool) => tool.function.name)).toEqual(['message_context'])
  })

  it('allows one query_messages retry after a zero-result exact query', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ status: 'completed', returnedCount: 0, messages: [] })
      .mockResolvedValueOnce({ status: 'completed', returnedCount: 1, messages: [{ messageRef: 'ref' }] })
    const configured = provider([queryCall('c1', { kind: 'last_7_days' }), queryCall('c2', { kind: 'all' }), { success: true, data: '找到。' }])
    const result = await new QueryAgentPocService(configured, execute).run('找文件')
    expect(execute).toHaveBeenCalledTimes(2)
    expect(execute.mock.calls[1][1]).toMatchObject({ timeRange: { kind: 'all' } })
    expect(result.traces[1].status).toBe('completed')
  })

  it('rejects an identical query_messages retry', async () => {
    const execute = vi.fn(emptyQuery)
    const configured = provider([queryCall('c1', { kind: 'previous_month' }), queryCall('c2', { kind: 'previous_month' }), { success: true, data: 'x' }])
    const result = await new QueryAgentPocService(configured, execute).run('找文件')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(result.traces[1].status).toBe('invalid_tool_arguments')
  })

  it('keeps the efficient stop when the exact query already returned messages', async () => {
    const execute = vi.fn(async () => ({ status: 'completed', returnedCount: 3, messages: [] }))
    const configured = provider([queryCall('c1'), { success: true, data: 'ok' }])
    await new QueryAgentPocService(configured, execute).run('找')
    expect(vi.mocked(configured.chatWithTools).mock.calls[1]?.[1]).toEqual([])
  })

  it('still caps total tool calls at five', async () => {
    const execute = vi.fn(emptyQuery)
    const responses = [
      queryCall('c1', { kind: 'last_7_days' }),
      queryCall('c2', { kind: 'all' }),
      queryCall('c3', { kind: 'today' }),
      queryCall('c4', { kind: 'yesterday' }),
      queryCall('c5', { kind: 'this_year' }),
      queryCall('c6', { kind: 'this_month' })
    ]
    const result = await new QueryAgentPocService(provider(responses), execute).run('找')
    expect(result.toolCallCount).toBe(5)
    expect(result.error).toContain('最大工具调用次数')
  })
})

describe('QueryAgent 耗时与请求级诊断记录', () => {
  function queryCall(id: string) {
    return { success: true as const, toolCalls: [{ id, name: 'query_messages', arguments: JSON.stringify({ target: { query: 'BOBO' }, timeRange: { kind: 'all' }, limit: 1 }) }] }
  }

  it('记录每次模型调用耗时，包括失败的那次（首次调用失败）', async () => {
    const configured = provider([
      { success: false, error: '模型服务返回了网页而不是 JSON（HTTP 502 Bad Gateway）', errorStatus: 502, errorContentType: 'text/html', htmlInsteadOfJson: true, elapsedMs: 99419 }
    ])
    const result = await new QueryAgentPocService(configured, vi.fn()).run('测试')
    expect(result.modelCallCount).toBe(1)
    expect(result.modelDurationsMs).toHaveLength(1)
    expect(result.modelDiagnostics).toEqual([
      expect.objectContaining({ index: 1, status: 502, contentType: 'text/html', htmlInsteadOfJson: true, elapsedMs: 99419 })
    ])
    expect(result.error).toContain('502')
    // 首次模型调用就失败，不应产生任何工具调用
    expect(result.toolCallCount).toBe(0)
    expect(result.finalModelMs).toBeUndefined()
  })

  it('2 次模型调用 + 1 次工具：耗时数组与调用次数一致', async () => {
    const configured = provider([queryCall('c1'), { success: true, data: '完成' }])
    const result = await new QueryAgentPocService(configured, vi.fn(async () => ({ status: 'completed', returnedCount: 1 }))).run('测试')
    expect(result.modelCallCount).toBe(2)
    expect(result.modelDurationsMs).toHaveLength(2)
    expect(result.modelDurationsMs.every((value) => typeof value === 'number' && value >= 0)).toBe(true)
    expect(result.modelDiagnostics.map((entry) => entry.index)).toEqual([1, 2])
    expect(result.toolCallCount).toBe(1)
  })

  it('1 次模型调用 + 0 次工具：无工具诊断噪声', async () => {
    const configured = provider([{ success: true, data: '直接回答' }])
    const result = await new QueryAgentPocService(configured, vi.fn()).run('测试')
    expect(result.modelCallCount).toBe(1)
    expect(result.toolCallCount).toBe(0)
    expect(result.modelDurationsMs).toHaveLength(1)
    expect(result.modelDiagnostics[0]).not.toHaveProperty('error')
  })

  it('末尾模型调用失败时两条记录都在，且第二条带错误', async () => {
    const configured = provider([
      queryCall('c1'),
      { success: false, error: 'AI 请求超时', timedOut: true }
    ])
    const result = await new QueryAgentPocService(configured, vi.fn(async () => ({ status: 'completed', returnedCount: 1 }))).run('测试')
    expect(result.modelDurationsMs).toHaveLength(2)
    expect(result.modelDiagnostics[1]).toMatchObject({ index: 2, timedOut: true })
    expect(result.error).toBe('AI 请求超时')
    expect(result.answer).toBeUndefined()
  })
})
