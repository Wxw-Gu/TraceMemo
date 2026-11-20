import { describe, expect, it, vi } from 'vitest'
import { Wcdb4Client, type Wcdb4MessagePage } from '../../src/main/wcdb4-client'

type Row = Record<string, unknown>

function row(localId: number, createTime: number, serverId: string, text: string): Row {
  return {
    local_id: localId,
    server_id: serverId,
    create_time: createTime,
    local_type: 1,
    message_content: text,
    mes_des: 0
  }
}

const STORES = [
  { tableName: 'Msg_a', dbPath: '/shard/a.db' },
  { tableName: 'Msg_b', dbPath: '/shard/b.db' },
  { tableName: 'Msg_c', dbPath: '/shard/c.db' }
]

// 分片 b 的前 5 条与分片 a 的尾部重叠：模拟迁移留下的重复行。
const SHARD_A = Array.from({ length: 40 }, (_, index) =>
  row(index + 1, 1_000_000 + index * 60, `srv-${index}`, `A-${index}`)
)
const SHARD_B = [
  ...Array.from({ length: 5 }, (_, index) =>
    row(100 + index, 1_000_000 + (35 + index) * 60, `srv-${35 + index}`, `dup-${35 + index}`)
  ),
  ...Array.from({ length: 35 }, (_, index) =>
    row(200 + index, 1_000_000 + (40 + index) * 60, `srv-${40 + index}`, `B-${index}`)
  )
]
const SHARD_C = Array.from({ length: 20 }, (_, index) =>
  row(index + 1, 1_000_000 + (75 + index) * 60, `srv-${75 + index}`, `C-${index}`)
)

function createClient(batchLimit?: number): Wcdb4Client {
  const data: Record<string, Row[]> = {
    '/shard/a.db': SHARD_A,
    '/shard/b.db': SHARD_B,
    '/shard/c.db': SHARD_C
  }
  const offsets = new Map<string, number>()

  return Object.assign(Object.create(Wcdb4Client.prototype), {
    wcdbExecQuery: vi.fn(),
    displayNameCache: new Map(),
    avatarCache: new Map(),
    messageTypeColumnCache: new Map(),
    resolveMessageUsername: (value: string) => value,
    getGroupNicknames: () => new Map<string, string>(),
    getMyUsernameCandidates: () => [],
    listMessageStoresAsync: async () => STORES,
    // 只模拟"分片内按有序顺序取下一页"，SQL 条件本身由真实 SQLite 保证。
    callJsonAsync: async (_fn: unknown, _kind: string, dbPath: string, sql: string) => {
      const limit = Number(/LIMIT (\d+)/.exec(sql)?.[1] ?? 1000)
      const rows = data[dbPath] ?? []
      const offset = offsets.get(dbPath) ?? 0
      offsets.set(dbPath, offset + limit)
      if (batchLimit !== undefined && rows.length > batchLimit) {
        return rows.slice(offset, Math.min(offset + limit, batchLimit))
      }
      return rows.slice(offset, offset + limit)
    }
  }) as unknown as Wcdb4Client
}

async function collect(client: Wcdb4Client, pageSize: number): Promise<Wcdb4MessagePage[]> {
  const pages: Wcdb4MessagePage[] = []
  for await (const page of client.iterateMessagePagesAsync('fixture@chatroom', {
    pageSize,
    requestId: 'test'
  })) {
    pages.push(page)
  }
  return pages
}

describe('iterateMessagePagesAsync', () => {
  it('merges shards into one stable order and drops cross-shard duplicates', async () => {
    const client = createClient()
    const pages = await collect(client, 10)
    const messages = pages.flatMap((page) => page.messages)

    // 40 + 40 + 20 条里，分片 b 的前 5 条是分片 a 的重复行。
    expect(messages).toHaveLength(95)
    expect(new Set(messages.map((message) => message.serverId)).size).toBe(95)

    const times = messages.map((message) => Number(message.msgCreateTime))
    expect(times).toEqual([...times].sort((left, right) => left - right))

    expect(new Set(messages.map((message) => message.msgContent)).size).toBe(95)
    expect(pages.every((page) => page.failedStores.length === 0)).toBe(true)
    expect(pages[pages.length - 1]?.hasMore).toBe(false)
  })

  it('never repeats or skips a message when pages are uneven', async () => {
    const reference = await collect(createClient(), 250)
    const referenceIds = reference.flatMap((page) => page.messages).map((m) => m.serverId)

    for (const pageSize of [3, 7, 11]) {
      const pages = await collect(createClient(), pageSize)
      const ids = pages.flatMap((page) => page.messages).map((m) => m.serverId)
      expect(ids).toEqual(referenceIds)
    }
  })

  it('reports the failing shard instead of silently returning a short result', async () => {
    const client = Object.assign(Object.create(Wcdb4Client.prototype), {
      wcdbExecQuery: vi.fn(),
      displayNameCache: new Map(),
      avatarCache: new Map(),
      messageTypeColumnCache: new Map(),
      resolveMessageUsername: (value: string) => value,
    getGroupNicknames: () => new Map<string, string>(),
    getMyUsernameCandidates: () => [],
      listMessageStoresAsync: async () => STORES,
      callJsonAsync: async (_fn: unknown, _kind: string, dbPath: string) => {
        if (dbPath === '/shard/b.db') throw new Error('shard unavailable')
        return dbPath === '/shard/a.db' ? SHARD_A : SHARD_C
      }
    }) as unknown as Wcdb4Client

    const pages = await collect(client, 20)
    const failed = pages.flatMap((page) => page.failedStores)
    // 失败必须显式暴露：上层据此才能拒绝把这一遍标成完整。
    expect(failed).toContain('Msg_b')
  })
})

/**
 * 反例：无法证明是副本时必须保留两条。
 *
 * 两个必须守住的边界：`server_id` 会被不同消息复用（同一个 id 出现在不同
 * create_time 上），而"同秒 + 同发送者 + 同正文"完全可能只是两句"收到"。
 */
describe('跨分片副本判据', () => {
  const buildClient = (data: Record<string, Row[]>, stores: typeof STORES): Wcdb4Client => {
    const offsets = new Map<string, number>()
    return Object.assign(Object.create(Wcdb4Client.prototype), {
      wcdbExecQuery: vi.fn(),
      displayNameCache: new Map(),
      avatarCache: new Map(),
      messageTypeColumnCache: new Map(),
      resolveMessageUsername: (value: string) => value,
      getGroupNicknames: () => new Map<string, string>(),
      getMyUsernameCandidates: () => [],
      listMessageStoresAsync: async () => stores,
      callJsonAsync: async (_fn: unknown, _kind: string, dbPath: string, sql: string) => {
        const limit = Number(/LIMIT (\d+)/.exec(sql)?.[1] ?? 1000)
        const rows = data[dbPath] ?? []
        const offset = offsets.get(dbPath) ?? 0
        offsets.set(dbPath, offset + limit)
        return rows.slice(offset, offset + limit)
      }
    }) as unknown as Wcdb4Client
  }

  const collectAll = async (client: Wcdb4Client): Promise<Wcdb4MessagePage[]> => {
    const pages: Wcdb4MessagePage[] = []
    for await (const page of client.iterateMessagePagesAsync('fixture@chatroom', {
      pageSize: 50,
      requestId: 'test'
    })) {
      pages.push(page)
    }
    return pages
  }

  it('同秒、同 local_id、同正文但 server_id 不同 → 两条都保留', async () => {
    const stores = [
      { tableName: 'Msg_a', dbPath: '/x/a.db' },
      { tableName: 'Msg_b', dbPath: '/x/b.db' }
    ]
    const data = {
      '/x/a.db': [row(7, 1_700_000_000, 'srv-A', '收到')],
      '/x/b.db': [row(7, 1_700_000_000, 'srv-B', '收到')]
    }
    const messages = (await collectAll(buildClient(data, stores))).flatMap((page) => page.messages)
    expect(messages).toHaveLength(2)
    expect(messages.map((message) => message.serverId)).toEqual(['srv-A', 'srv-B'])
  })

  it('server_id 被复用（不同 create_time）→ 两条都保留', async () => {
    const stores = [
      { tableName: 'Msg_a', dbPath: '/y/a.db' },
      { tableName: 'Msg_b', dbPath: '/y/b.db' }
    ]
    const data = {
      '/y/a.db': [row(1, 1_700_000_000, 'srv-shared', '第一条')],
      '/y/b.db': [row(1, 1_700_000_060, 'srv-shared', '第二条')]
    }
    const messages = (await collectAll(buildClient(data, stores))).flatMap((page) => page.messages)
    expect(messages).toHaveLength(2)
  })

  it('同秒且同 server_id 的重复行才是副本 → 合并为一条', async () => {
    const stores = [
      { tableName: 'Msg_a', dbPath: '/z/a.db' },
      { tableName: 'Msg_b', dbPath: '/z/b.db' }
    ]
    const data = {
      '/z/a.db': [row(1, 1_700_000_000, 'srv-same', '同一条')],
      '/z/b.db': [row(99, 1_700_000_000, 'srv-same', '同一条')]
    }
    const messages = (await collectAll(buildClient(data, stores))).flatMap((page) => page.messages)
    expect(messages).toHaveLength(1)
  })

  it('没有 server_id 时不按正文合并', async () => {
    const stores = [
      { tableName: 'Msg_a', dbPath: '/w/a.db' },
      { tableName: 'Msg_b', dbPath: '/w/b.db' }
    ]
    const data = {
      '/w/a.db': [row(1, 1_700_000_000, '0', '好的')],
      '/w/b.db': [row(1, 1_700_000_000, '0', '好的')]
    }
    const messages = (await collectAll(buildClient(data, stores))).flatMap((page) => page.messages)
    expect(messages).toHaveLength(2)
  })
})
