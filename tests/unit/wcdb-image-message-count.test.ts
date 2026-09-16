/**
 * 图片消息计数 / 增量的**标识符与列名**回归测试。
 *
 * 真机反馈「检测到图片消息为 0 → 无法统计（未找到该会话的消息表）」，根因有两个，
 * 都在这里钉死：
 *
 * 1. **标识符混淆**：`contact.md5` 是 `md5(wxid)` 的哈希，而原生接口
 *    （`wcdbGetMessageTableStats` / `wcdbGetMessages`）要的是**原始 username**。
 *    把 md5 直接当 username 传，原生侧匹配不到任何表 —— 既有读消息路径一直有做这层转换
 *    （`wechat-db.chatMd5ToUsername`、`chat-service` 的 `getUsernameByMd5`），统计路径漏了。
 * 2. **类型列名硬编码**：不同微信版本的列名不统一（项目读行时用的是别名列表），
 *    把 `local_type` 写进 WHERE 会在列名不同的库上抛错。
 */
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { Wcdb4Client } from '../../src/main/wcdb4-client'

const USERNAME = 'wxid_real_user'
const ROOM = '12345678@chatroom'
const MD5_OF_USERNAME = createHash('md5').update(USERNAME).digest('hex')
const MD5_OF_ROOM = createHash('md5').update(ROOM).digest('hex')

type ClientOptions = {
  sessions?: { username: string }[]
  chatTables?: { name: string; db_number: string }[] | null
  columns?: string[]
  count?: number
  maxLocalId?: number
  identifierLog?: string[]
}

function makeClient(options: ClientOptions): Wcdb4Client {
  const identifierLog = options.identifierLog ?? []
  return Object.assign(Object.create(Wcdb4Client.prototype), {
    cachedSessions: (options.sessions ?? []).map((session) => ({ ...session })),
    cachedChatTables: options.chatTables ?? null,
    messageTypeColumnCache: new Map<string, string | null>(),
    messageTypeColumnCandidates: [
      'local_type',
      'localType',
      'msg_type',
      'msgType',
      'message_type',
      'messageType',
      'type',
      'WCDB_CT_local_type'
    ],
    // 断言点：走到消息表查找时用的标识符必须是 username，不是 md5。
    listMessageStoresAsync: vi.fn(async (identifier: string) => {
      identifierLog.push(identifier)
      return [{ tableName: 'Msg_fixture', dbPath: 'C:/fixture/message_0.db' }]
    }),
    // 聚合查询的返回（真实实现由 pickValue 解析）。
    callJsonAsync: vi.fn(async () => [
      { image_count: options.count ?? 0, image_max_local_id: options.maxLocalId ?? 0 }
    ]),
    readMessageColumns: vi.fn(() =>
      (options.columns ?? []).map((name) => ({ name, declaration: 'INTEGER' }))
    ),
    wcdbGetMessageTableStats: vi.fn(async () => 0),
    wcdbExecQuery: vi.fn(async () => 0)
  }) as Wcdb4Client
}

describe('图片消息统计：会话标识符必须是 username 而不是 md5', () => {
  it('从 session 能把 md5 反解成 username，并把它交给消息表查找', async () => {
    const identifierLog: string[] = []
    const client = makeClient({
      sessions: [{ username: USERNAME }],
      columns: ['local_type'],
      count: 7,
      identifierLog
    })

    const result = await client.countImageMessagesAsync(MD5_OF_USERNAME)

    expect(result).toEqual({ count: 7, typeColumn: 'local_type' })
    // ★ 核心回归断言：绝不能把 md5 当 username 传下去。
    expect(identifierLog).toEqual([USERNAME])
    expect(identifierLog).not.toContain(MD5_OF_USERNAME)
  })

  it('群聊同样走 md5 → username', async () => {
    const identifierLog: string[] = []
    const client = makeClient({
      sessions: [{ username: ROOM }],
      columns: ['local_type'],
      count: 2,
      identifierLog
    })

    await client.countImageMessagesAsync(MD5_OF_ROOM)
    expect(identifierLog).toEqual([ROOM])
  })

  it('不在 session 列表、只以 Chat_<md5> 表存在的会话也能反解', async () => {
    const identifierLog: string[] = []
    const client = makeClient({
      sessions: [],
      chatTables: [{ name: `Chat_${MD5_OF_ROOM}`, db_number: ROOM }],
      columns: ['local_type'],
      count: 3,
      identifierLog
    })

    const result = await client.countImageMessagesAsync(MD5_OF_ROOM)
    expect(result.count).toBe(3)
    expect(identifierLog).toEqual([ROOM])
  })

  it('增量水位使用同一个标识符（否则水位永远拿不到、退化成每轮重扫）', async () => {
    const identifierLog: string[] = []
    const client = makeClient({
      sessions: [{ username: USERNAME }],
      columns: ['local_type'],
      count: 7,
      maxLocalId: 42,
      identifierLog
    })

    const watermark = await client.imageConversationWatermarkAsync(MD5_OF_USERNAME)
    expect(watermark).toEqual({ count: 7, maxLocalId: 42 })
    expect(identifierLog).toEqual([USERNAME])
  })
})

describe('图片消息统计：类型列名随版本变化', () => {
  it('列名不是 local_type 时照样能统计，并把真实列名透出', async () => {
    const client = makeClient({
      sessions: [{ username: USERNAME }],
      columns: ['msg_type'],
      count: 5
    })

    const result = await client.countImageMessagesAsync(MD5_OF_USERNAME)
    expect(result).toEqual({ count: 5, typeColumn: 'msg_type' })
  })

  it('探测不到类型列时明确失败，而不是静默返回 0', async () => {
    const client = makeClient({ sessions: [{ username: USERNAME }], columns: [] })

    const result = await client.countImageMessagesAsync(MD5_OF_USERNAME)
    // "数不出来"必须是 null + 原因，不能是 0。
    expect(result.count).toBeNull()
    expect(result.error).toBe('消息表缺少可识别的消息类型列')
  })

  it('一张表都没匹配到时给出可诊断的原因', async () => {
    const client = makeClient({ sessions: [{ username: USERNAME }], columns: ['local_type'] })
    Object.assign(client, { listMessageStoresAsync: vi.fn(async () => []) })

    const result = await client.countImageMessagesAsync(MD5_OF_USERNAME)
    expect(result.count).toBeNull()
    expect(result.error).toBe('未找到该会话的消息表')
  })

  it('原生统计通道不可用时说明是环境问题，与 0 张区分开', async () => {
    const client = makeClient({ sessions: [{ username: USERNAME }], columns: ['local_type'] })
    Object.assign(client, { wcdbExecQuery: null })

    const result = await client.countImageMessagesAsync(MD5_OF_USERNAME)
    expect(result.count).toBeNull()
    expect(result.error).toBe('当前数据服务不支持消息表统计')
  })
})
