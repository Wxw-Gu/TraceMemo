import { describe, expect, it, vi, type Mock } from 'vitest'
import { Wcdb4Client, type Wcdb4Message } from '../../src/main/wcdb4-client'

const message = (id: number): Wcdb4Message => ({
  mesLocalID: String(id),
  serverId: `server-${id}`,
  mesDes: 0,
  messageType: '1',
  msgCreateTime: '150',
  msgContent: `fixture-${id}`,
  raw: {}
})

function makeClient(overrides: Record<string, unknown> = {}): Wcdb4Client {
  return Object.assign(Object.create(Wcdb4Client.prototype), {
    wcdbGetMessageTableStats: vi.fn(),
    wcdbExecQuery: vi.fn(),
    wcdbGetMessages: vi.fn(() => {
      throw new Error('unbounded native fallback must not run')
    }),
    getMessagesByCursorAsync: vi.fn(async () => []),
    listMessageStoresAsync: vi.fn(async () => [
      { tableName: 'Msg_fixture', dbPath: 'message_0.db' }
    ]),
    // Native SQL returns normalized synthetic rows here. No real WeChat database is used.
    finalizeMessages: vi.fn((_user: string, rows: Wcdb4Message[]) => rows),
    ...overrides
  }) as Wcdb4Client
}

function makeCursorClient(fetch: { code: number; json?: string; hasMore?: number }[]): {
  client: Wcdb4Client
  read: () => Promise<Wcdb4Message[]>
  call: Mock<(fn: unknown, ...args: unknown[]) => Promise<number>>
  close: Mock
  free: Mock
} {
  const open = vi.fn()
  const batch = vi.fn()
  const close = vi.fn()
  const free = vi.fn()
  const call = vi.fn(async (fn: unknown, ...args: unknown[]) => {
    if (fn === open) {
      ;(args[6] as [number])[0] = 123
      return 0
    }
    if (fn === batch) {
      const next = fetch.shift()!
      ;(args[2] as [unknown])[0] = next.json === undefined ? null : { json: next.json }
      ;(args[3] as [number])[0] = next.hasMore || 0
      return next.code
    }
    return 0
  })
  const client = Object.assign(Object.create(Wcdb4Client.prototype), {
    wcdbOpenMessageCursor: open,
    wcdbFetchMessageBatch: batch,
    wcdbCloseMessageCursor: close,
    wcdbFreeString: free,
    ensureHandle: () => 1,
    callAsyncCode: call,
    koffi: { decode: (pointer: { json: string }) => pointer.json },
    finalizeMessages: vi.fn((_user: string, rows: Wcdb4Message[]) => rows)
  }) as Wcdb4Client
  const read = (): Promise<Wcdb4Message[]> =>
    Reflect.get(client, 'getMessagesByCursorAsync').call(client, 'fixture', 100, 200)
  return { client, read, call, close, free }
}

describe('bounded Reader message reads', () => {
  it('accepts an authoritative empty shard query without a full-conversation fallback', async () => {
    const query = vi.fn<
      (fn: unknown, kind: string, db: string, sql: string) => Promise<Wcdb4Message[]>
    >(async () => [])
    const client = makeClient({ callJsonAsync: query })

    await expect(client.getMessagesAsync('fixture', 100, 200)).resolves.toEqual([])

    expect(query).toHaveBeenCalledOnce()
    expect(query.mock.calls[0][3]).toContain('"create_time" >= 100 AND "create_time" <= 200')
    expect(Reflect.get(client, 'wcdbGetMessages')).not.toHaveBeenCalled()
  })

  it('reads more than 5,000 rows per shard when no limit was requested', async () => {
    const first = Array.from({ length: 5000 }, (_, id) => message(id + 1))
    const query = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce([message(5001)])
    const client = makeClient({ callJsonAsync: query })

    const result = await client.getMessagesAsync('fixture', 100, 200)

    expect(result).toHaveLength(5001)
    expect(result.at(-1)?.mesLocalID).toBe('5001')
    expect(query.mock.calls[0][3]).toContain(
      'ORDER BY "create_time" ASC, "local_id" ASC LIMIT 5000 OFFSET 0'
    )
    expect(query.mock.calls[1][3]).toContain('LIMIT 5000 OFFSET 5000')
    expect(Reflect.get(client, 'wcdbGetMessages')).not.toHaveBeenCalled()
  })

  it('merges every matching historical store when the native cursor is empty', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([message(1)])
      .mockResolvedValueOnce([message(2)])
    const client = makeClient({
      callJsonAsync: query,
      listMessageStoresAsync: vi.fn(async () => [
        { tableName: 'Msg_fixture', dbPath: 'message_0.db' },
        { tableName: 'Msg_fixture', dbPath: 'message_1.db' }
      ])
    })
    await expect(client.getMessagesAsync('fixture', 100, 200)).resolves.toHaveLength(2)
  })

  it('does not publish a partial range when a later shard fails', async () => {
    const client = makeClient({
      listMessageStoresAsync: vi.fn(async () => [
        { tableName: 'Msg_fixture', dbPath: 'message_0.db' },
        { tableName: 'Msg_fixture', dbPath: 'message_1.db' }
      ]),
      callJsonAsync: vi
        .fn()
        .mockResolvedValueOnce([message(1)])
        .mockRejectedValueOnce(new Error('locked'))
    })
    await expect(client.getMessagesAsync('fixture', 100, 200)).rejects.toThrow(
      '历史消息分片读取失败'
    )
  })

  it('rejects the complete range if a later SQL page fails', async () => {
    const client = makeClient({
      callJsonAsync: vi
        .fn()
        .mockResolvedValueOnce(Array.from({ length: 5000 }, (_, id) => message(id + 1)))
        .mockRejectedValueOnce(new Error('second page unavailable'))
    })
    await expect(client.getMessagesAsync('fixture', 100, 200)).rejects.toThrow(
      '历史消息分片读取失败'
    )
  })

  it('fails closed when canonical shard discovery fails, but permits a missing conversation table', async () => {
    const client = makeClient({
      getMessageDatabasePaths: vi.fn(() => ['message_0.db']),
      callJsonAsync: vi.fn(async () => {
        throw new Error('cannot read sqlite_master')
      })
    })
    const discover = Reflect.get(client, 'listFallbackMessageStoresAsync')
    await expect(discover.call(client, 'fixture', true)).rejects.toThrow(
      'cannot read sqlite_master'
    )
    // Non-Reader consumers retain their existing tolerant discovery contract.
    await expect(discover.call(client, 'fixture')).resolves.toEqual([])
    Reflect.set(
      client,
      'callJsonAsync',
      vi.fn(async () => [])
    )
    await expect(discover.call(client, 'fixture', true)).resolves.toEqual([])
  })

  it('enables strict shard discovery for a complete Reader range', async () => {
    const discover = vi.fn(async () => {
      throw new Error('discovery failed')
    })
    const client = makeClient({ listMessageStoresAsync: discover })
    await expect(client.getMessagesAsync('fixture', 100, 200)).rejects.toThrow(
      '无法读取历史消息分片信息'
    )
    expect(discover).toHaveBeenCalledWith('fixture', true)
  })

  it('does not treat an unsupported or failed SQL read as a successful empty range', async () => {
    const client = makeClient({
      callJsonAsync: vi.fn(async () => {
        throw new Error('native failure')
      })
    })
    await expect(client.getMessagesAsync('fixture', 100, 200)).rejects.toThrow()
    Reflect.set(client, 'wcdbExecQuery', undefined)
    await expect(client.getMessagesAsync('fixture', 100, 200)).rejects.toThrow(
      '无法检查历史消息分片'
    )
  })

  it('keeps an explicit newest-message limit instead of paging an unlimited range', async () => {
    const query = vi.fn<
      (fn: unknown, kind: string, db: string, sql: string) => Promise<Wcdb4Message[]>
    >(async () => [message(2)])
    const client = makeClient({ callJsonAsync: query })
    await expect(client.getMessagesAsync('fixture', 100, 200, { limit: 1 })).resolves.toHaveLength(
      1
    )
    expect(query).toHaveBeenCalledOnce()
    expect(query.mock.calls[0][3]).toContain('DESC LIMIT 1 OFFSET 0')
  })

  it.each([false, true])(
    'keeps recall journal opt-in=%s on the async Reader path',
    async (enabled) => {
      const recovered = { ...message(2), raw: { _wxe_recovered: 1 } }
      const journal = vi.fn(async () => [recovered])
      const client = makeClient({
        recallJournalEnabled: enabled,
        callJsonAsync: vi.fn(async () => [message(1)]),
        readRecallJournalAsync: journal
      })
      const result = await client.getMessagesAsync('fixture', 100, 200)
      expect(result).toHaveLength(enabled ? 2 : 1)
      expect(journal).toHaveBeenCalledTimes(enabled ? 1 : 0)
    }
  )

  it('uses async SQL to read the optional journal with the original time bounds', async () => {
    const query = vi.fn(async () => [{ ...message(2), raw: { _wxe_recovered: 1 } }])
    const client = makeClient({ callJsonAsync: query })
    const rows = await Reflect.get(client, 'readRecallJournalAsync').call(
      client,
      'fixture',
      100,
      200
    )
    expect(rows).toHaveLength(1)
    const sql = (query.mock.calls as unknown[][])[0][3]
    expect(sql).toContain(`"_wxe_source_table" = 'Msg_fixture'`)
    expect(sql).toContain('"create_time" >= 100 AND "create_time" <= 200')
    expect(sql).toContain('LIMIT 500')
  })

  it('distinguishes a completed empty cursor batch from a failed native fetch', async () => {
    const valid = makeCursorClient([{ code: 0, json: '[]' }])
    await expect(valid.read()).resolves.toEqual([])
    expect(valid.free).toHaveBeenCalledOnce()
    expect(valid.call).toHaveBeenLastCalledWith(valid.close, 1, 123)

    const invalid = makeCursorClient([{ code: 5, json: '[]' }])
    await expect(invalid.read()).rejects.toThrow('消息游标读取失败')
    expect(invalid.free).toHaveBeenCalledOnce()
    expect(invalid.call).toHaveBeenLastCalledWith(invalid.close, 1, 123)
  })

  it('closes the cursor and releases native output when JSON decoding fails', async () => {
    const broken = makeCursorClient([{ code: 0, json: '{' }])
    await expect(broken.read()).rejects.toThrow()
    expect(broken.free).toHaveBeenCalledOnce()
    expect(broken.call).toHaveBeenLastCalledWith(broken.close, 1, 123)
  })
})
