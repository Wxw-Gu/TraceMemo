import { describe, expect, it, vi } from 'vitest'
import { Wcdb4Client, type Wcdb4Message } from '../../src/main/wcdb4-client'

const message = (id: string, year: number, serverId = `server-${id}`): Wcdb4Message => ({
  mesLocalID: id,
  serverId,
  mesDes: 0,
  messageType: '1',
  msgCreateTime: String(Math.floor(Date.UTC(year, 0, 1) / 1000)),
  msgContent: `fixture-${year}`,
  raw: {}
})

describe('WCDB message shard pagination', () => {
  it('keeps messages whose local ids repeat across database shards', async () => {
    const cursor = vi.fn(async () => [
      message('1', 2024, 'server-2024'),
      message('1', 2025, 'server-2025')
    ])
    const client = Object.assign(Object.create(Wcdb4Client.prototype), {
      getMessagesByCursorAsync: cursor
    }) as Wcdb4Client

    const result = await client.getMessagesAsync('fixture@chatroom')

    expect(result).toHaveLength(2)
    expect(result.map((item) => item.serverId)).toEqual(['server-2024', 'server-2025'])
  })

  it('merges cursor and all-store rows for a bounded cross-year page', async () => {
    const cursor = vi.fn(async () => [message('2025', 2025)])
    const tableScan = vi.fn(async () => [message('2017', 2017), message('2025', 2025)])
    const client = Object.assign(Object.create(Wcdb4Client.prototype), {
      wcdbGetMessageTableStats: vi.fn(),
      wcdbExecQuery: vi.fn(),
      getMessagesByCursorAsync: cursor,
      getMessagesByTableScanAsync: tableScan
    }) as Wcdb4Client

    const result = await client.getMessagesAsync(
      'fixture@chatroom',
      undefined,
      Math.floor(Date.UTC(2026, 0, 1) / 1000),
      { limit: 20 }
    )

    expect(tableScan).toHaveBeenCalledOnce()
    expect(result.map((item) => item.msgContent)).toEqual(['fixture-2017', 'fixture-2025'])
  })

  it('reports an unsupported shard query instead of claiming history ended', async () => {
    const client = Object.assign(Object.create(Wcdb4Client.prototype), {
      getMessagesByCursorAsync: vi.fn(async () => [])
    }) as Wcdb4Client

    await expect(
      client.getMessagesAsync('fixture@chatroom', undefined, 1_767_225_600, { limit: 20 })
    ).rejects.toThrow('无法检查历史消息分片')
  })
})
