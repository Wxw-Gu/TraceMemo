import { zstdCompressSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MessageListenerService,
  decodeSourcePayload,
  extractMentionTargets,
  type NormalizedIncomingMessage
} from '../../src/main/services/message-listener-service'
import { parseMonitorEvent } from '../../src/main/wcdb4-client'
import type { Wcdb4Client, Wcdb4Message } from '../../src/main/wcdb4-client'

/**
 * MessageListener 底座测试。
 *
 * 覆盖 Spike 里用真实环境验证过的每一条行为，确保「正式实现 ≈ Spike 等价」。
 * 所有身份标识都用 `SELF_USER` / `OTHER_USER` 占位 —— 测试里**不得**出现真实 wxid。
 */

const SESSION_GROUP = 'group_A@chatroom'
const SESSION_DIRECT = 'user_A'

const makeMessage = (overrides: Partial<Wcdb4Message> = {}): Wcdb4Message => ({
  mesLocalID: '100',
  serverId: '7000000000000000001',
  mesDes: 1,
  // ⚠️ WCDB 层这几个字段是 **string**（见 Wcdb4Message 定义），
  // 归一化时才转 number。mock 必须跟随真实类型，否则类型检查会红。
  messageType: '1',
  msgCreateTime: '1789900000',
  msgContent: 'hello',
  sender: 'OTHER_USER',
  senderNickname: '对方昵称',
  senderAvatar: '',
  raw: {},
  ...overrides
})

/**
 * zstd 压缩一段文本，用来构造真实的 `source` 列形态。
 *
 * 用 **Node 内置 `zlib`** 而不是被测代码依赖的 `fzstd`：
 * 这样测试侧的「压缩」与实现侧的「解压」是**两条独立的实现路径**，
 * 不会因为同一个库的同一个缺陷而互相掩盖。
 * （`fzstd` 本身只提供解压，没有压缩接口。）
 */
async function zstdBuffer(text: string): Promise<Buffer> {
  return zstdCompressSync(Buffer.from(text, 'utf8'))
}

function makeClient(messages: Wcdb4Message[], username = SESSION_GROUP) {
  return {
    getSessions: vi.fn(() => [{ username }]),
    getMessagesAsync: vi.fn(async () => messages)
  } as unknown as Wcdb4Client
}

let received: NormalizedIncomingMessage[] = []

const collect = (listener: MessageListenerService): void => {
  listener.onMessage((message) => received.push(message))
}

/** 推进 coalesce 窗口并等待回读完成。 */
const flush = async (ms = 200): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms)
}

beforeEach(() => {
  received = []
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('mention parser（纯函数）', () => {
  it('CDATA 形式：剥掉外壳，只留 username', () => {
    const source =
      '<msgsource><atuserlist><![CDATA[SELF_USER]]></atuserlist><silence>1</silence></msgsource>'
    expect(extractMentionTargets(source)).toEqual(['SELF_USER'])
  })

  it('裸文本形式同样支持', () => {
    const source = '<msgsource><atuserlist>OTHER_USER</atuserlist></msgsource>'
    expect(extractMentionTargets(source)).toEqual(['OTHER_USER'])
  })

  it('没有 atuserlist 时返回空数组', () => {
    expect(extractMentionTargets('<msgsource><silence>1</silence></msgsource>')).toEqual([])
    expect(extractMentionTargets(undefined)).toEqual([])
    expect(extractMentionTargets('')).toEqual([])
  })

  it('假 @：正文里有 @昵称，但 source 没有 atuserlist ⇒ 不产生 mention', () => {
    const source = '<msgsource><silence>1</silence><membercount>34</membercount></msgsource>'
    expect(extractMentionTargets(source)).toEqual([])
  })

  it('不假设 username 以 wxid_ 开头（本机账号的 username 可能完全是别的形式）', () => {
    const source = '<msgsource><atuserlist>SELF_USER</atuserlist></msgsource>'
    // 若实现里写了 `startsWith('wxid_')` 过滤，这条会变成 []
    expect(extractMentionTargets(source)).toEqual(['SELF_USER'])
  })
})

describe('decodeSourcePayload', () => {
  it('zstd 压缩的 Buffer 能解出 XML', async () => {
    const xml = '<msgsource><atuserlist>SELF_USER</atuserlist></msgsource>'
    const buffer = await zstdBuffer(xml)
    // 魔数确认：确保我们构造的确实是 zstd
    expect([...buffer.subarray(0, 4)]).toEqual([0x28, 0xb5, 0x2f, 0xfd])
    expect(decodeSourcePayload(buffer)).toBe(xml)
  })

  it('Node Buffer 的 JSON 形态（{type:"Buffer",data:[...]}）也能解', async () => {
    const xml = '<msgsource><atuserlist>SELF_USER</atuserlist></msgsource>'
    const buffer = await zstdBuffer(xml)
    const jsonForm = JSON.parse(JSON.stringify(buffer)) as { type: string; data: number[] }
    expect(decodeSourcePayload(jsonForm)).toBe(xml)
  })

  it('空值 / 非 zstd 内容安全返回', () => {
    expect(decodeSourcePayload(undefined)).toBeUndefined()
    expect(decodeSourcePayload(Buffer.alloc(0))).toBeUndefined()
    expect(decodeSourcePayload(Buffer.from('plain text'))).toBe('plain text')
  })
})

describe('coalesce：一批 native event 只回读一次', () => {
  it('同一窗口收到 17 个 event，只产生 1 次回读、消息只投递 1 次', async () => {
    const client = makeClient([makeMessage()])
    const listener = new MessageListenerService(client)
    collect(listener)

    // 模拟实测观察到的「一条消息 ≈ 17 个 native event」
    for (let index = 0; index < 17; index += 1) listener.handleNativeChange()
    await flush()

    expect((client as unknown as { getMessagesAsync: ReturnType<typeof vi.fn> }).getMessagesAsync)
      .toHaveBeenCalledTimes(1)
    expect(received).toHaveLength(1)
    expect(listener.stats()).toMatchObject({
      nativeEvents: 17,
      coalescedEvents: 16,
      readbacks: 1,
      delivered: 1
    })
  })
})

describe('dedup', () => {
  it('同一 sessionId:localId 被回读多次，只投递一次', async () => {
    const client = makeClient([makeMessage({ mesLocalID: '100' })])
    const listener = new MessageListenerService(client)
    collect(listener)

    // 三个分开的窗口，每次都读到同一条消息
    for (let round = 0; round < 3; round += 1) {
      listener.handleNativeChange()
      await flush()
    }

    expect(received).toHaveLength(1)
    expect(listener.stats().delivered).toBe(1)
    expect(listener.stats().deduped).toBeGreaterThanOrEqual(2)
  })

  it('sessionId 相同但 localId 不同 ⇒ 不是同一条', async () => {
    const client = makeClient([makeMessage({ mesLocalID: '100' })])
    const listener = new MessageListenerService(client)
    collect(listener)

    listener.handleNativeChange()
    await flush()
    // 换成另一个 localId 再读一轮
    ;(client as unknown as { getMessagesAsync: ReturnType<typeof vi.fn> }).getMessagesAsync.mockResolvedValue(
      [makeMessage({ mesLocalID: '101' })]
    )
    listener.handleNativeChange()
    await flush()

    expect(received.map((message) => message.localId)).toEqual(['100', '101'])
  })

  it('dedup 缓存有界：超过上限会淘汰最旧条目', async () => {
    const client = makeClient([])
    const listener = new MessageListenerService(client, { dedupMaxEntries: 3 })
    collect(listener)

    const send = async (localId: string): Promise<void> => {
      ;(client as unknown as { getMessagesAsync: ReturnType<typeof vi.fn> }).getMessagesAsync.mockResolvedValue(
        [makeMessage({ mesLocalID: localId })]
      )
      listener.handleNativeChange()
      await flush()
    }

    for (const id of ['1', '2', '3', '4', '5']) await send(id)

    // 5 条都投递过（容量 3 只会影响「还能记住多少」）
    expect(received).toHaveLength(5)
    // 最早的两条已被淘汰 ⇒ 再读到 '1' 时会重新投递
    await send('1')
    expect(received.filter((message) => message.localId === '1')).toHaveLength(2)
  })
})

describe('连续消息', () => {
  it('同一窗口读到 3 条，必须全部投递（不能只取最后一条）', async () => {
    const client = makeClient([
      makeMessage({ mesLocalID: '100' }),
      makeMessage({ mesLocalID: '101' }),
      makeMessage({ mesLocalID: '102' })
    ])
    const listener = new MessageListenerService(client)
    collect(listener)

    listener.handleNativeChange()
    await flush()

    expect(received.map((message) => message.localId)).toEqual(['100', '101', '102'])
    expect(listener.stats().delivered).toBe(3)
  })
})

describe('self / incoming', () => {
  it('mesDes = 0 ⇒ isSelf = true', async () => {
    const client = makeClient([makeMessage({ mesDes: 0, sender: 'SELF_USER' })])
    const listener = new MessageListenerService(client)
    collect(listener)

    listener.handleNativeChange()
    await flush()

    expect(received[0].isSelf).toBe(true)
  })

  it('mesDes = 1 ⇒ isSelf = false', async () => {
    const client = makeClient([makeMessage({ mesDes: 1 })])
    const listener = new MessageListenerService(client)
    collect(listener)

    listener.handleNativeChange()
    await flush()

    expect(received[0].isSelf).toBe(false)
  })
})

describe('normalize 输出', () => {
  it('群消息：isGroup = true，且 mentionTargets 来自 source', async () => {
    const source = '<msgsource><atuserlist><![CDATA[SELF_USER]]></atuserlist></msgsource>'
    const client = makeClient([
      makeMessage({ raw: { source: await zstdBuffer(source) } })
    ])
    const listener = new MessageListenerService(client)
    collect(listener)

    listener.handleNativeChange()
    await flush()

    const message = received[0]
    expect(message.isGroup).toBe(true)
    expect(message.mentionTargets).toEqual(['SELF_USER'])
    expect(message.source).toContain('atuserlist')
  })

  it('私聊：isGroup = false，无 source 时 mentionTargets 为空', async () => {
    const client = makeClient([makeMessage({ raw: {} })], SESSION_DIRECT)
    const listener = new MessageListenerService(client)
    collect(listener)

    listener.handleNativeChange()
    await flush()

    expect(received[0].isGroup).toBe(false)
    expect(received[0].mentionTargets).toEqual([])
  })

  it('createTime 保持 epoch 秒（不做毫秒换算）', async () => {
    const client = makeClient([makeMessage({ msgCreateTime: '1789900000' })])
    const listener = new MessageListenerService(client)
    collect(listener)

    listener.handleNativeChange()
    await flush()

    expect(received[0].createTime).toBe(1_789_900_000)
    expect(received[0].createTime).toBeLessThan(1e11)
  })

  it('缺关键标识（无 localId 或无 createTime）的行不投递', async () => {
    const client = makeClient([
      makeMessage({ mesLocalID: '' }),
      makeMessage({ mesLocalID: '200', msgCreateTime: '0' }),
      makeMessage({ mesLocalID: '201' })
    ])
    const listener = new MessageListenerService(client)
    collect(listener)

    listener.handleNativeChange()
    await flush()

    expect(received.map((message) => message.localId)).toEqual(['201'])
  })
})

describe('Observation Mode 约束', () => {
  it('没有订阅者时不会崩，也不会产生投递', async () => {
    const client = makeClient([makeMessage()])
    const listener = new MessageListenerService(client)

    listener.handleNativeChange()
    await flush()

    expect(listener.stats().readbacks).toBe(1)
    expect(listener.stats().delivered).toBe(1)
    expect(received).toHaveLength(0)
  })

  it('dispose 之后不再响应事件', async () => {
    const client = makeClient([makeMessage()])
    const listener = new MessageListenerService(client)
    collect(listener)

    listener.dispose()
    listener.handleNativeChange()
    await flush()

    expect(received).toHaveLength(0)
    expect(listener.stats().nativeEvents).toBe(0)
  })

  it('取消订阅后不再收到消息', async () => {
    const client = makeClient([makeMessage()])
    const listener = new MessageListenerService(client)
    const unsubscribe = listener.onMessage((message) => received.push(message))

    unsubscribe()
    listener.handleNativeChange()
    await flush()

    expect(received).toHaveLength(0)
  })
})

/**
 * Native Monitor Event v2：pipe payload 里带上**发生变化的会话**。
 *
 * 这一组锁的是「不再依赖 `getSessions()[0]`」这件事，以及两个必须保留的行为：
 * legacy（v1 runtime）fallback 和同消息 dedup。
 */
describe('parseMonitorEvent（协议解析）', () => {
  it('v2 + message_change + session_id ⇒ precise', () => {
    const event = parseMonitorEvent(
      JSON.stringify({
        version: 2,
        kind: 'message_change',
        session_id: 'group_A@chatroom',
        db: 'message_0.db',
        table: 'message',
        action: 'update',
        observed_at_ms: 1_700_000_000_000
      })
    )
    expect(event.protocol).toBe(2)
    expect(event.sessionId).toBe('group_A@chatroom')
    expect(event.table).toBe('message')
    expect(event.observedAtMs).toBe(1_700_000_000_000)
  })

  it('v1 payload 仍然解析成 legacy（不带会话）', () => {
    const event = parseMonitorEvent(
      JSON.stringify({ db: 'session.db', table: 'Session', action: 'update' })
    )
    expect(event.protocol).toBe(1)
    expect(event.sessionId).toBeUndefined()
    expect(event.action).toBe('update')
    expect(event.raw).toContain('session.db')
  })

  it('v2 但缺 session_id / kind 不对 ⇒ 一律降级成 legacy，绝不猜会话', () => {
    for (const payload of [
      { version: 2, kind: 'message_change' },
      { version: 2, kind: 'message_change', session_id: '   ' },
      { version: 2, session_id: 'group_A@chatroom' },
      { version: 1, kind: 'message_change', session_id: 'group_A@chatroom' }
    ]) {
      expect(parseMonitorEvent(JSON.stringify(payload)).protocol).toBe(1)
      expect(parseMonitorEvent(JSON.stringify(payload)).sessionId).toBeUndefined()
    }
  })

  it('不是 JSON 也不崩', () => {
    const event = parseMonitorEvent('not-json')
    expect(event.protocol).toBe(1)
    expect(event.action).toBe('update')
  })
})

describe('MessageListener · precise session path', () => {
  const v2Event = (sessionId: string) =>
    parseMonitorEvent(
      JSON.stringify({ version: 2, kind: 'message_change', session_id: sessionId, table: 'message' })
    )
  const v1Event = () =>
    parseMonitorEvent(JSON.stringify({ db: 'session.db', table: 'Session', action: 'update' }))

  /** 按会话返回消息，并记录每个会话被回读了几次。 */
  function multiSessionClient(bySession: Record<string, Wcdb4Message[]>): {
    client: Wcdb4Client
    calls: string[]
  } {
    const calls: string[] = []
    const client = {
      // legacy fallback 用的「最近活跃会话」，故意与 precise 的会话不同。
      getSessions: vi.fn(() => [{ username: 'recent@chatroom' }]),
      getMessagesAsync: vi.fn(async (sessionId: string) => {
        calls.push(sessionId)
        return bySession[sessionId] ?? []
      })
    } as unknown as Wcdb4Client
    return { client, calls }
  }

  it('v2 事件直接按 sessionId 回读，不再碰 getSessions()[0]', async () => {
    const { client, calls } = multiSessionClient({
      'A@chatroom': [makeMessage({ mesLocalID: '1' })]
    })
    const listener = new MessageListenerService(client)
    collect(listener)

    listener.handleNativeChange(v2Event('A@chatroom'))
    await flush()

    expect(calls).toEqual(['A@chatroom'])
    expect(received.map((message) => message.sessionId)).toEqual(['A@chatroom'])
  })

  it('120ms 内 A/B/A/C 会回读 A、B、C 各一次（不是「最后一个 wins」）', async () => {
    const { client, calls } = multiSessionClient({
      'A@chatroom': [makeMessage({ mesLocalID: '1' })],
      'B@chatroom': [makeMessage({ mesLocalID: '2' })],
      'C@chatroom': [makeMessage({ mesLocalID: '3' })]
    })
    const listener = new MessageListenerService(client)
    collect(listener)

    listener.handleNativeChange(v2Event('A@chatroom'))
    listener.handleNativeChange(v2Event('B@chatroom'))
    listener.handleNativeChange(v2Event('A@chatroom'))
    listener.handleNativeChange(v2Event('C@chatroom'))
    await flush()

    expect(calls.sort()).toEqual(['A@chatroom', 'B@chatroom', 'C@chatroom'])
    expect(received.map((message) => message.sessionId).sort()).toEqual([
      'A@chatroom',
      'B@chatroom',
      'C@chatroom'
    ])
  })

  it('一批里既有 v2 又有 v1 时，仍然按 v2 的精确会话回读', async () => {
    const { client, calls } = multiSessionClient({
      'A@chatroom': [makeMessage({ mesLocalID: '1' })],
      'recent@chatroom': [makeMessage({ mesLocalID: '9' })]
    })
    const listener = new MessageListenerService(client)
    collect(listener)

    listener.handleNativeChange(v2Event('A@chatroom'))
    listener.handleNativeChange(v1Event())
    await flush()

    expect(calls).toEqual(['A@chatroom'])
  })

  it('legacy（v1 runtime）仍然退回最近活跃会话，行为不变', async () => {
    const { client, calls } = multiSessionClient({
      'recent@chatroom': [makeMessage({ mesLocalID: '1' })]
    })
    const listener = new MessageListenerService(client)
    collect(listener)

    listener.handleNativeChange(v1Event())
    await flush()

    expect(calls).toEqual(['recent@chatroom'])
    expect(received).toHaveLength(1)
  })

  it('native 重复发同一条消息的 v2 事件，只会投递一次', async () => {
    const { client, calls } = multiSessionClient({
      'A@chatroom': [makeMessage({ mesLocalID: '42' })]
    })
    const listener = new MessageListenerService(client)
    collect(listener)

    listener.handleNativeChange(v2Event('A@chatroom'))
    await flush()
    listener.handleNativeChange(v2Event('A@chatroom'))
    await flush()

    // 回读了两次（两次事件各一个窗口），但同一条消息只投递一次。
    expect(calls).toEqual(['A@chatroom', 'A@chatroom'])
    expect(received).toHaveLength(1)
  })
})
