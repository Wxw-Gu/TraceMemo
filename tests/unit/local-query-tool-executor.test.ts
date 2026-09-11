import { describe, expect, it, vi } from 'vitest'
import { createLocalQueryToolExecutor } from '../../src/main/services/local-query-tool-executor'
import type { LocalQueryApiService } from '../../src/main/services/local-query-api-service'

function fakeQueryApi(): LocalQueryApiService {
  return {
    messages: vi.fn(async () => ({ status: 'completed', returnedCount: 0 })),
    search: vi.fn(async () => ({ status: 'completed', evidenceCount: 0 })),
    context: vi.fn(async () => ({ status: 'completed' })),
    overview: vi.fn(async () => ({ status: 'completed' }))
  } as unknown as LocalQueryApiService
}

describe('createLocalQueryToolExecutor', () => {
  it('把四个 Tool 映射到对应的 Local Query API 能力', async () => {
    const api = fakeQueryApi()
    const execute = createLocalQueryToolExecutor(api)

    await execute('query_messages', { target: { query: 'BOBO' }, timeRange: { kind: 'all' } })
    await execute('search_messages', { query: '房租' })
    await execute('message_context', { messageRef: 'ref' })
    await execute('conversation_overview', { target: { query: '群' }, timeRange: { kind: 'all' } })

    expect(api.messages).toHaveBeenCalledWith({ target: { query: 'BOBO' }, timeRange: { kind: 'all' } })
    expect(api.search).toHaveBeenCalledWith({ query: '房租' })
    expect(api.context).toHaveBeenCalledWith({ messageRef: 'ref' })
    expect(api.overview).toHaveBeenCalledWith({
      target: { query: '群' },
      timeRange: { kind: 'all' }
    })
  })

  it('拒绝未知工具名（不静默落到任意查询）', async () => {
    const api = fakeQueryApi()
    const execute = createLocalQueryToolExecutor(api)

    await expect(execute('raw_sql', {})).rejects.toThrow('不允许的工具')
    expect(api.messages).not.toHaveBeenCalled()
  })
})
