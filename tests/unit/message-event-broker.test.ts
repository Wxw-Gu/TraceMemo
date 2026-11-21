import { describe, expect, it, vi } from 'vitest'
import {
  MessageEventBroker,
  eventIdFor,
  parseLastEventId,
  type MessageBackfillReport,
  type MessageEventOrigin,
  type MessageEventRecord,
  type MessageGap
} from '../../src/main/services/message-event-broker'
import {
  MessageListenerService,
  normalizeIncomingMessage,
  type NormalizedIncomingMessage
} from '../../src/main/services/message-listener-service'
import { decodeMessageRef } from '../../src/shared/local-query-api'
import { parseMonitorEvent } from '../../src/main/wcdb4-client'
import type { Wcdb4Client, Wcdb4Message } from '../../src/main/wcdb4-client'

/**
 * MessageEventBroker 的契约测试。
 *
 * 覆盖三件容易「看起来对、实际漏消息」的事：
 * 1. 事件 ID 与 messageRef 的确定性 / 可反解；
 * 2. 缓冲覆盖得住时是 replay，覆盖不住时必须显式 gap + 有界回补；
 * 3. 回补事件与实时事件在 `origin` 上必须可区分。
 */

const SESSION = 'group_A@chatroom'
const CONVERSATION = 'md5_conversation_a'
const NOW = 1_800_000_000_000

const makeRow = (overrides: Partial<Wcdb4Message> = {}): Wcdb4Message => ({
  mesLocalID: '100',
  serverId: '7000000000000000001',
  mesDes: 1,
  messageType: '1',
  msgCreateTime: String(Math.floor(NOW / 1000)),
  msgContent: 'hello',
  sender: 'OTHER_USER',
  senderNickname: '对方',
  senderAvatar: '',
  raw: {},
  ...overrides
})

const normalize = (row: Wcdb4Message): NormalizedIncomingMessage => {
  const normalized = normalizeIncomingMessage(SESSION, row)
  if (!normalized) throw new Error('fixture row is not normalizable')
  return normalized
}

interface Collected {
  statuses: unknown[]
  events: Array<{ event: MessageEventRecord; origin: MessageEventOrigin }>
  gaps: MessageGap[]
  backfills: MessageBackfillReport[]
  order: string[]
}

function makeSink(): Collected & {
  sink: {
    onStatus: (status: unknown) => void
    onEvent: (event: MessageEventRecord, origin: MessageEventOrigin) => void
    onGap: (gap: MessageGap) => void
    onBackfill: (report: MessageBackfillReport) => void
  }
} {
  const collected: Collected = { statuses: [], events: [], gaps: [], backfills: [], order: [] }
  return {
    ...collected,
    get statuses() {
      return collected.statuses
    },
    get events() {
      return collected.events
    },
    get gaps() {
      return collected.gaps
    },
    get backfills() {
      return collected.backfills
    },
    get order() {
      return collected.order
    },
    sink: {
      onStatus: (status) => {
        collected.statuses.push(status)
        collected.order.push('status')
      },
      onEvent: (event, origin) => {
        collected.events.push({ event, origin })
        collected.order.push(`event:${origin}`)
      },
      onGap: (gap) => {
        collected.gaps.push(gap)
        collected.order.push('gap')
      },
      onBackfill: (report) => {
        collected.backfills.push(report)
        collected.order.push('backfill')
      }
    }
  }
}

function makeBroker(
  options: {
    bufferSize?: number
    dbReady?: boolean
    reader?: ReturnType<typeof vi.fn>
    backfillLimit?: number
    backfillMaxConversations?: number
  } = {}
): MessageEventBroker {
  return new MessageEventBroker({
    resolveConversationId: (sessionId) => (sessionId === SESSION ? CONVERSATION : undefined),
    resolveSessionId: (conversationId) => (conversationId === CONVERSATION ? SESSION : undefined),
    isDatabaseReady: () => options.dbReady !== false,
    readMessages: options.reader as never,
    bufferSize: options.bufferSize ?? 10,
    ...(options.backfillLimit !== undefined ? { backfillLimit: options.backfillLimit } : {}),
    ...(options.backfillMaxConversations !== undefined
      ? { backfillMaxConversations: options.backfillMaxConversations }
      : {}),
    bufferTtlMs: 10 * 60 * 1000,
    now: () => NOW
  })
}

describe('事件 ID 与 messageRef', () => {
  it('同一会话 + 同一条消息得到确定性 ID', () => {
    expect(eventIdFor(CONVERSATION, '100')).toBe(eventIdFor(CONVERSATION, '100'))
    expect(eventIdFor(CONVERSATION, '100')).not.toBe(eventIdFor(CONVERSATION, '101'))
    expect(eventIdFor(CONVERSATION, '100')).toMatch(/^evt_[0-9a-f]{24}$/)
  })

  it('messageRef 用现有 encodeMessageRef 生成，能被 decodeMessageRef 反解', () => {
    const broker = makeBroker()
    const record = broker.publish(normalize(makeRow()))
    expect(record).not.toBeNull()
    expect(decodeMessageRef(record!.messageRef)).toEqual({
      conversationId: CONVERSATION,
      messageId: '1800000000:100'
    })
  })

  it('同一 localId、不同 createTime 是两条消息（复合身份不被 localId 合并）', () => {
    const broker = makeBroker()
    const first = broker.publish(
      normalize(makeRow({ mesLocalID: '7', msgCreateTime: '1800000000' }))
    )
    const second = broker.publish(
      normalize(makeRow({ mesLocalID: '7', msgCreateTime: '1800000100' }))
    )

    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(first!.id).not.toBe(second!.id)
    expect(decodeMessageRef(first!.messageRef)!.messageId).toBe('1800000000:7')
    expect(decodeMessageRef(second!.messageRef)!.messageId).toBe('1800000100:7')
  })

  it('无法映射会话时不发布，也不伪造 messageRef', () => {
    const broker = makeBroker()
    const other = normalizeIncomingMessage('unknown_session', makeRow())
    expect(broker.publish(other!)).toBeNull()
    expect(broker.stats().unmapped).toBe(1)
  })

  it('同一条消息重复回读只会产生一个事件', () => {
    const broker = makeBroker()
    const message = normalize(makeRow())
    expect(broker.publish(message)).not.toBeNull()
    expect(broker.publish(message)).toBeNull()
    expect(broker.stats()).toMatchObject({ published: 1, duplicates: 1 })
  })

  it('超长正文显式标记 textTruncated，而不是静默截断', () => {
    const broker = new MessageEventBroker({
      resolveConversationId: () => CONVERSATION,
      maxTextChars: 64
    })
    const record = broker.publish(normalize(makeRow({ msgContent: 'x'.repeat(200) })))
    expect(record?.text).toHaveLength(64)
    expect(record?.textTruncated).toBe(true)
  })
})

describe('订阅、过滤与重放', () => {
  it('会话过滤只投递匹配的会话', () => {
    const broker = makeBroker()
    const a = makeSink()
    const b = makeSink()
    broker.subscribe({ conversationIds: [CONVERSATION] }, a.sink)
    broker.subscribe({ conversationIds: ['md5_other'] }, b.sink)

    broker.publish(normalize(makeRow({ mesLocalID: '1' })))
    expect(a.events).toHaveLength(1)
    expect(b.events).toHaveLength(0)
  })

  it('Last-Event-ID 落在缓冲内时按 replay 重放', () => {
    const broker = makeBroker()
    broker.publish(normalize(makeRow({ mesLocalID: '1' })))
    broker.publish(normalize(makeRow({ mesLocalID: '2' })))

    const sink = makeSink()
    broker.subscribe({ conversationIds: [CONVERSATION], lastEventId: '1' }, sink.sink)

    expect(sink.gaps).toHaveLength(0)
    expect(sink.events.map((item) => item.origin)).toEqual(['replay'])
    expect(decodeMessageRef(sink.events[0].event.messageRef)).toEqual({
      conversationId: CONVERSATION,
      messageId: '1800000000:2'
    })
  })

  it('进程重启后的旧游标不会被当成「已收到最新」而静默跳过', () => {
    const broker = makeBroker()
    broker.publish(normalize(makeRow({ mesLocalID: '1' })))

    // 上一个进程可能把 seq 推到过 500；本进程只分配到 1。
    const sink = makeSink()
    broker.subscribe({ conversationIds: [CONVERSATION], lastEventId: '500' }, sink.sink)

    expect(sink.events).toHaveLength(0)
    expect(sink.gaps).toHaveLength(1)
    expect(sink.gaps[0]).toMatchObject({
      reason: 'cursor_from_previous_process',
      requestedLastEventId: '500'
    })
  })

  it('带了游标但格式非法时显式 gap，不当作首次订阅', () => {
    const broker = makeBroker()
    broker.publish(normalize(makeRow({ mesLocalID: '1' })))

    const sink = makeSink()
    broker.subscribe({ conversationIds: [CONVERSATION], lastEventId: 'evt_abc' }, sink.sink)

    expect(sink.gaps).toHaveLength(1)
    expect(sink.gaps[0]).toMatchObject({
      reason: 'invalid_cursor',
      requestedLastEventId: 'evt_abc'
    })
  })

  it('游标正好等于最新序号时既无重放也无 gap', () => {
    const broker = makeBroker()
    broker.publish(normalize(makeRow({ mesLocalID: '1' })))
    broker.publish(normalize(makeRow({ mesLocalID: '2' })))

    const sink = makeSink()
    broker.subscribe({ conversationIds: [CONVERSATION], lastEventId: '2' }, sink.sink)
    expect(sink.events).toHaveLength(0)
    expect(sink.gaps).toHaveLength(0)
  })

  it('游标早于缓冲下界时先 gap，再做有界数据库回补', async () => {
    const reader = vi.fn(async () => [makeRow({ mesLocalID: '9' })])
    const broker = makeBroker({ bufferSize: 2, reader })
    for (const id of ['1', '2', '3', '4', '5']) {
      broker.publish(normalize(makeRow({ mesLocalID: id })))
    }

    // 缓冲只剩 4、5；客户端说它只收到 1，中间 2、3 已经无法从缓冲重放。
    const sink = makeSink()
    broker.subscribe({ conversationIds: [CONVERSATION], lastEventId: '1' }, sink.sink)
    await vi.waitFor(() => expect(sink.events.length).toBe(1))

    expect(sink.gaps).toHaveLength(1)
    expect(sink.gaps[0]).toMatchObject({
      reason: 'buffer_overflow',
      requestedLastEventId: '1',
      oldestSeq: 4,
      backfill: 'scheduled'
    })
    // gap 必须先于回补事件送达：顺序本身就是语义。
    expect(sink.order[0]).toBe('status')
    expect(sink.order[1]).toBe('gap')
    expect(sink.events[0].origin).toBe('db_backfill')
    expect(reader).toHaveBeenCalledTimes(1)

    const [sessionArg, startArg, endArg, limitArg] = reader.mock.calls[0] as unknown as [
      string,
      number,
      number,
      number
    ]
    expect(sessionArg).toBe(SESSION)
    expect(startArg).toBeLessThan(endArg)
    expect(endArg - startArg).toBeLessThanOrEqual(300)
    expect(limitArg).toBeLessThanOrEqual(100)
    expect(sink.backfills).toHaveLength(1)
    expect(sink.backfills[0]).toMatchObject({
      truncated: false,
      complete: true,
      conversationTruncated: false,
      messageTruncated: false,
      processedConversations: 1
    })
  })

  it('单会话回补读满 limit 时明确报告 messageTruncated', async () => {
    const reader = vi.fn(async () => [
      makeRow({ mesLocalID: '21' }),
      makeRow({ mesLocalID: '22' })
    ])
    const broker = makeBroker({ bufferSize: 1, reader, backfillLimit: 2 })
    for (const id of ['1', '2', '3']) broker.publish(normalize(makeRow({ mesLocalID: id })))

    const sink = makeSink()
    broker.subscribe({ conversationIds: [CONVERSATION], lastEventId: '1' }, sink.sink)
    await vi.waitFor(() => expect(sink.backfills.length).toBe(1))

    expect(sink.backfills[0]).toMatchObject({
      messageTruncated: true,
      conversationTruncated: false,
      truncated: true,
      complete: false,
      perConversationLimit: 2
    })
  })

  it('订阅会话数超过上限时明确报告 conversationTruncated', async () => {
    const reader = vi.fn(async () => [makeRow({ mesLocalID: '31' })])
    const broker = new MessageEventBroker({
      resolveConversationId: (sessionId) => (sessionId === 'A@chatroom' ? 'conv-a' : 'conv-b'),
      resolveSessionId: (conversationId) => (conversationId === 'conv-a' ? 'A@chatroom' : 'B@chatroom'),
      isDatabaseReady: () => true,
      readMessages: reader as never,
      bufferSize: 1,
      backfillLimit: 10,
      backfillMaxConversations: 1,
      now: () => NOW
    })
    for (const id of ['1', '2', '3']) {
      broker.publish(normalizeIncomingMessage('A@chatroom', makeRow({ mesLocalID: id }))!)
    }

    const sink = makeSink()
    broker.subscribe({ conversationIds: ['conv-a', 'conv-b'], lastEventId: '1' }, sink.sink)
    await vi.waitFor(() => expect(sink.backfills.length).toBe(1))

    expect(sink.backfills[0]).toMatchObject({
      requestedConversations: 2,
      processedConversations: 1,
      conversationTruncated: true,
      messageTruncated: false,
      truncated: true,
      complete: false,
      maxConversations: 1
    })
  })

  it('没有会话过滤时不做回补（无法有界），并如实说明', () => {
    const reader = vi.fn(async () => [])
    const broker = makeBroker({ bufferSize: 1, reader })
    for (const id of ['1', '2', '3']) broker.publish(normalize(makeRow({ mesLocalID: id })))

    const sink = makeSink()
    broker.subscribe({ lastEventId: '1' }, sink.sink)

    expect(sink.gaps).toHaveLength(1)
    expect(sink.gaps[0].backfill).toBe('skipped_no_conversation_filter')
    expect(reader).not.toHaveBeenCalled()
  })

  it('数据库不可用时明确标记，不伪造回补', () => {
    const reader = vi.fn(async () => [makeRow()])
    const broker = makeBroker({ bufferSize: 1, dbReady: false, reader })
    for (const id of ['1', '2', '3']) broker.publish(normalize(makeRow({ mesLocalID: id })))

    const status = broker.status()
    expect(status.database).toBe('unavailable')

    const sink = makeSink()
    broker.subscribe({ conversationIds: [CONVERSATION], lastEventId: '1' }, sink.sink)

    expect(sink.gaps[0].backfill).toBe('skipped_database_unavailable')
    expect(reader).not.toHaveBeenCalled()
  })

  it('close 之后不再收到新事件', () => {
    const broker = makeBroker()
    const sink = makeSink()
    const subscription = broker.subscribe({ conversationIds: [CONVERSATION] }, sink.sink)
    broker.publish(normalize(makeRow({ mesLocalID: '1' })))
    subscription.close()
    broker.publish(normalize(makeRow({ mesLocalID: '2' })))

    expect(sink.events).toHaveLength(1)
    expect(broker.status().subscribers).toBe(0)
  })

  it('订阅数达到上限时抛错，而不是静默丢弃订阅', () => {
    const broker = new MessageEventBroker({
      resolveConversationId: () => CONVERSATION,
      maxSubscribers: 1
    })
    broker.subscribe({}, makeSink().sink)
    expect(() => broker.subscribe({}, makeSink().sink)).toThrow(/上限/)
  })
})

describe('parseLastEventId', () => {
  it('只接受正整数序号', () => {
    expect(parseLastEventId('12')).toBe(12)
    expect(parseLastEventId(' 12 ')).toBe(12)
    expect(parseLastEventId('0')).toBeNull()
    expect(parseLastEventId('-1')).toBeNull()
    expect(parseLastEventId('evt_abc')).toBeNull()
    expect(parseLastEventId(undefined)).toBeNull()
    expect(parseLastEventId('1'.repeat(20))).toBeNull()
  })
})

describe('有界性', () => {
  it('缓冲条目不超过 bufferSize', () => {
    const broker = makeBroker({ bufferSize: 3 })
    for (let index = 0; index < 10; index += 1) {
      broker.publish(normalize(makeRow({ mesLocalID: String(index + 1) })))
    }
    expect(broker.status().buffered).toBe(3)
    expect(broker.status().newestSeq).toBe(10)
  })

  it('订阅者已投递 ID 记忆有界（回补与实时重叠不会重复投递）', () => {
    const broker = makeBroker({ bufferSize: 50 })
    const sink = makeSink()
    broker.subscribe({ conversationIds: [CONVERSATION] }, sink.sink)

    const message = normalize(makeRow({ mesLocalID: '1' }))
    broker.publish(message)
    // 直接走一次回补路径（同一个 reader 返回同一条消息），应当被订阅者去重。
    expect(
      broker['deliver'](
        broker['subscribers'].values().next().value!,
        {
          ...broker['buffer'][0]
        },
        'db_backfill'
      )
    ).toBeUndefined()
    expect(sink.events).toHaveLength(1)
  })
})

// 防未使用告警：保留类型引用，说明测试覆盖的是真实客户端形态。
export type _ClientShape = Wcdb4Client

describe('多订阅者与 Automation 扇出', () => {
  it('多个订阅者并发收到同一条事件，互不影响', () => {
    const broker = makeBroker()
    const sinks = Array.from({ length: 5 }, () => makeSink())
    for (const sink of sinks) {
      broker.subscribe({ conversationIds: [CONVERSATION] }, sink.sink)
    }

    broker.publish(normalize(makeRow({ mesLocalID: 'fanout-1' })))

    for (const sink of sinks) {
      expect(sink.events).toHaveLength(1)
      expect(sink.events[0].event.id).toBe(eventIdFor(CONVERSATION, '1800000000:fanout-1'))
    }
    expect(broker.status().subscribers).toBe(5)
  })

  it('同一批 native event 只让 Automation 与事件订阅各收到一次', async () => {
    vi.useRealTimers()
    const client = {
      getSessions: vi.fn(() => [{ username: SESSION }]),
      getMessagesAsync: vi.fn(async () => [makeRow({ mesLocalID: '1' })])
    } as unknown as Wcdb4Client

    const broker = makeBroker()
    const sink = makeSink()
    broker.subscribe({ conversationIds: [CONVERSATION] }, sink.sink)

    const listener = new MessageListenerService(client, { coalesceMs: 10 })
    const automation = vi.fn()
    listener.onMessage((message) => {
      broker.publish(message)
      automation(message)
    })

    const v2 = parseMonitorEvent(
      JSON.stringify({ version: 2, kind: 'message_change', session_id: SESSION, table: 'message' })
    )
    // 一条消息在真实环境会触发一连串 native event。
    listener.handleNativeChange(v2)
    listener.handleNativeChange(v2)
    listener.handleNativeChange(v2)

    await vi.waitFor(() => expect(sink.events.length).toBe(1), { timeout: 2_000 })
    expect(automation).toHaveBeenCalledTimes(1)
    expect(broker.stats().published).toBe(1)
  })
})

describe('运行状态区分', () => {
  it('database / monitor / wechat 分别报告，不互相冒充', () => {
    const broker = new MessageEventBroker({
      resolveConversationId: () => CONVERSATION,
      isDatabaseReady: () => true,
      getMonitorState: () => 'running',
      getWechatProcessState: () => 'stopped',
      now: () => NOW
    })

    expect(broker.status()).toMatchObject({
      database: 'ready',
      monitor: 'running',
      wechat: 'stopped'
    })
  })

  it('未注入 monitor/wechat 时是 unknown，而不是默认 ready', () => {
    const broker = new MessageEventBroker({
      resolveConversationId: () => CONVERSATION,
      now: () => NOW
    })
    expect(broker.status()).toMatchObject({ monitor: 'unknown', wechat: 'unknown' })
  })
})

describe('重开库缓冲重置', () => {
  it('resetBuffer 清空缓冲但保留订阅者，新事件序号继续递增', () => {
    const broker = makeBroker()
    const sink = makeSink()
    broker.subscribe({}, sink.sink)
    broker.publish(normalize(makeRow({ mesLocalID: '1' })))
    broker.publish(normalize(makeRow({ mesLocalID: '2' })))
    expect(broker.status()).toMatchObject({ buffered: 2, subscribers: 1 })

    broker.resetBuffer()
    expect(broker.status()).toMatchObject({
      buffered: 0,
      oldestSeq: null,
      newestSeq: null,
      subscribers: 1
    })

    broker.publish(normalize(makeRow({ mesLocalID: '3' })))
    expect(broker.status().newestSeq).toBe(3)
    expect(sink.events.map((item) => item.event.seq)).toEqual([1, 2, 3])
  })
})

describe('回补失败也必须标记不完整', () => {
  it('会话读取抛错时 complete=false，且不是 truncated 语义', async () => {
    const reader = vi.fn(async () => {
      throw new Error('shard unavailable')
    })
    const broker = makeBroker({ bufferSize: 1, reader })
    for (const id of ['1', '2', '3']) broker.publish(normalize(makeRow({ mesLocalID: id })))

    const sink = makeSink()
    broker.subscribe({ conversationIds: [CONVERSATION], lastEventId: '1' }, sink.sink)
    await vi.waitFor(() => expect(sink.backfills.length).toBe(1))

    expect(sink.backfills[0]).toMatchObject({
      failedConversations: 1,
      truncated: false,
      complete: false,
      delivered: 0
    })
  })
})
