import { describe, expect, it } from 'vitest'
import { ILinkPoller } from '../../src/main/services/wechat-ilink/poller'
import { ILinkError } from '../../src/main/services/wechat-ilink/errors'
import type {
  ILinkGetUpdatesResponse,
  ILinkWeixinMessage,
  WechatInboundMessage
} from '../../src/main/services/wechat-ilink/types'

interface HarnessOptions {
  initialCursor?: string
  onMessages?: (messages: WechatInboundMessage[]) => Promise<void>
  onStaleToken?: (message: string) => void
}

function message(id: number): ILinkWeixinMessage {
  return {
    message_id: id,
    from_user_id: 'user@im.wechat',
    message_type: 1,
    item_list: [{ type: 1, text_item: { text: `msg-${id}` } }],
    context_token: `ctx-${id}`
  }
}

function createHarness(
  steps: Array<ILinkGetUpdatesResponse | Error>,
  options: HarnessOptions = {}
): {
  poller: ILinkPoller
  savedCursors: string[]
  dispatched: WechatInboundMessage[][]
  logs: string[]
  timeline: string[]
  fetchTimeouts: number[]
  fetchCount: () => number
} {
  const controller = new AbortController()
  const savedCursors: string[] = []
  const dispatched: WechatInboundMessage[][] = []
  const logs: string[] = []
  const timeline: string[] = []
  const fetchTimeouts: number[] = []
  let index = 0

  const poller = new ILinkPoller({
    fetchUpdates: async (getUpdatesBuf, timeoutMs) => {
      fetchTimeouts.push(timeoutMs)
      if (index >= steps.length) {
        // 队列耗尽后结束循环，避免无限轮询。
        controller.abort()
        return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf }
      }
      const step = steps[index]
      index += 1
      if (step instanceof Error) throw step
      return step
    },
    onMessages: async (messages) => {
      dispatched.push(messages)
      timeline.push('dispatch')
      await options.onMessages?.(messages)
    },
    normalize: (raw): WechatInboundMessage | undefined => {
      if (!raw.from_user_id) return undefined
      return {
        accountId: 'acc',
        fromUserId: raw.from_user_id,
        messageId: String(raw.message_id ?? ''),
        messageType: 1,
        items: [{ type: 1, text: raw.item_list?.[0]?.text_item?.text ?? '' }],
        receivedAt: 1
      }
    },
    loadCursor: () => options.initialCursor ?? '',
    saveCursor: (getUpdatesBuf) => {
      savedCursors.push(getUpdatesBuf)
      timeline.push('saveCursor')
    },
    signal: controller.signal,
    log: (level, text) => logs.push(`${level}:${text}`),
    ...(options.onStaleToken ? { onStaleToken: options.onStaleToken } : {}),
    sleep: async () => undefined,
    now: () => 0
  })

  return {
    poller,
    savedCursors,
    dispatched,
    logs,
    timeline,
    fetchTimeouts,
    fetchCount: () => index
  }
}

describe('ILinkPoller', () => {
  it('只有 dispatch 成功之后才持久化新游标', async () => {
    const harness = createHarness([{ ret: 0, msgs: [message(1)], get_updates_buf: 'buf-1' }])

    await harness.poller.run()

    expect(harness.dispatched).toHaveLength(1)
    expect(harness.savedCursors).toEqual(['buf-1'])
    // 顺序固定：先投递，再推进游标。反过来就会出现"游标已推进、消息还没处理"的静默丢消息。
    expect(harness.timeline).toEqual(['dispatch', 'saveCursor'])
  })

  it('dispatch 失败时不推进游标，让服务端重投', async () => {
    let attempts = 0
    const harness = createHarness(
      [
        { ret: 0, msgs: [message(7)], get_updates_buf: 'buf-1' },
        { ret: 0, msgs: [message(7)], get_updates_buf: 'buf-1' }
      ],
      {
        onMessages: async () => {
          attempts += 1
          if (attempts === 1) throw new Error('AgentHub 暂时不可用')
        }
      }
    )

    await harness.poller.run()

    expect(attempts).toBe(2)
    // 第一次失败不写游标；第二次成功后写一次。
    expect(harness.savedCursors).toEqual(['buf-1'])
    expect(harness.logs.some((line) => line.startsWith('error:'))).toBe(true)
  })

  it('同一批消息重投时允许重复，但不能丢弃', async () => {
    const harness = createHarness([
      { ret: 0, msgs: [message(1), message(2)], get_updates_buf: 'buf-9' }
    ])

    await harness.poller.run()

    expect(harness.dispatched[0].map((item) => item.messageId)).toEqual(['1', '2'])
    expect(harness.savedCursors).toEqual(['buf-9'])
  })

  it('errcode=-14 视为 bot token 失效：停止轮询、不重置游标、不立即重试', async () => {
    const staleMessages: string[] = []
    const harness = createHarness(
      [
        { ret: 0, errcode: -14, errmsg: 'stale token', msgs: [], get_updates_buf: 'buf-ignored' },
        { ret: 0, msgs: [message(1)], get_updates_buf: 'buf-later' }
      ],
      { onStaleToken: (text) => staleMessages.push(text) }
    )

    await harness.poller.run()

    expect(staleMessages).toHaveLength(1)
    // 第二条响应永远不会被消费：-14 之后不再无间隔重试。
    expect(harness.fetchCount()).toBe(1)
    expect(harness.dispatched).toHaveLength(0)
    // 游标保持不变，重新登录后仍可续上原有进度。
    expect(harness.savedCursors).toEqual([])
    expect(harness.logs.some((line) => line.includes('重新扫码登录'))).toBe(true)
  })

  it('客户端长轮询超时属于正常控制流，不推进游标也不计入失败', async () => {
    const harness = createHarness([
      new ILinkError({ kind: 'timeout', message: 'request timeout' }),
      { ret: 0, msgs: [], get_updates_buf: '' }
    ])

    await harness.poller.run()

    expect(harness.fetchTimeouts.length).toBeGreaterThanOrEqual(2)
    expect(harness.savedCursors).toEqual([])
    expect(harness.logs.some((line) => line.includes('获取更新失败'))).toBe(false)
  })

  it('ret 非 0 时按退避重试且不推进游标', async () => {
    const harness = createHarness([
      { ret: 500, errcode: 500, errmsg: 'server busy', msgs: [], get_updates_buf: 'buf-x' },
      { ret: 0, msgs: [], get_updates_buf: 'buf-y' }
    ])

    await harness.poller.run()

    expect(harness.savedCursors).toEqual(['buf-y'])
    expect(harness.logs.some((line) => line.includes('服务端返回错误'))).toBe(true)
  })

  it('采用服务端建议的 longpolling_timeout_ms', async () => {
    const harness = createHarness([
      { ret: 0, msgs: [], get_updates_buf: 'a', longpolling_timeout_ms: 5_000 },
      { ret: 0, msgs: [], get_updates_buf: 'b', longpolling_timeout_ms: 7_000 }
    ])

    await harness.poller.run()

    expect(harness.fetchTimeouts[0]).toBe(35_000)
    expect(harness.fetchTimeouts[1]).toBe(5_000)
    expect(harness.fetchTimeouts[2]).toBe(7_000)
  })

  it('从失败中恢复时补一条 info，让故障窗口在日志里有边界', async () => {
    const harness = createHarness([
      new Error('ECONNRESET'),
      { ret: 0, msgs: [], get_updates_buf: 'ok' }
    ])

    await harness.poller.run()

    expect(harness.logs.some((line) => line.startsWith('warn:'))).toBe(true)
    expect(harness.logs.filter((line) => line.includes('已恢复'))).toHaveLength(1)
  })

  it('一直正常时不打恢复日志', async () => {
    const harness = createHarness([{ ret: 0, msgs: [], get_updates_buf: 'a' }])

    await harness.poller.run()

    expect(harness.logs.some((line) => line.includes('已恢复'))).toBe(false)
  })

  it('从持久化游标恢复，且不沿用空游标覆盖', async () => {
    const harness = createHarness([{ ret: 0, msgs: [], get_updates_buf: 'buf-next' }], {
      initialCursor: 'buf-restored'
    })

    expect(harness.poller.getUpdatesBuf).toBe('buf-restored')
    await harness.poller.run()
    expect(harness.savedCursors).toEqual(['buf-next'])
  })
})
