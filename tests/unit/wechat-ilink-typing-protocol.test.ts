import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WechatConnectorService } from '../../src/main/services/wechat-ilink'
import { saveCredentials } from '../../src/main/services/wechat-ilink/account-store'
import {
  ILINK_TYPING_STATUS_CANCEL,
  ILINK_TYPING_STATUS_TYPING
} from '../../src/main/services/wechat-ilink/types'

const ACCOUNT_ID = 'bot_typing@im.bot'
const PEER = 'fixture-user-openid@im.wechat'

interface Recorded {
  path: string
  body: Record<string, unknown>
}

describe('wechat-ilink typing 协议接线', () => {
  const homes: string[] = []

  afterEach(() => {
    while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true })
  })

  async function createHarness(options: { keepaliveMs?: number } = {}): Promise<{
    service: WechatConnectorService
    requests: Recorded[]
    logs: string[]
    ticks: Array<() => void>
  }> {
    const home = mkdtempSync(join(tmpdir(), 'tracememo-ilink-typing-'))
    homes.push(home)
    saveCredentials(
      {
        bot_token: 'bot-token-value',
        ilink_bot_id: ACCOUNT_ID,
        baseurl: 'https://ilinkai.weixin.qq.com',
        ilink_user_id: PEER
      },
      () => home
    )

    const requests: Recorded[] = []
    const logs: string[] = []
    const ticks: Array<() => void> = []

    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
      requests.push({ path: url.pathname, body })
      const json = (payload: unknown): Response =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })

      if (url.pathname.endsWith('/getupdates')) {
        await new Promise((resolve) => setTimeout(resolve, 2))
        return json({ ret: 0, msgs: [], get_updates_buf: '' })
      }
      if (url.pathname.endsWith('/getconfig')) {
        return json({ ret: 0, errmsg: '', typing_ticket: 'ticket-abc' })
      }
      if (url.pathname.endsWith('/sendtyping')) return json({ ret: 0, errmsg: '' })
      return json({ ret: 0 })
    }) as unknown as typeof fetch

    const service = new WechatConnectorService({
      home: () => home,
      fetchImpl,
      sleep: async () => undefined,
      ...(options.keepaliveMs !== undefined ? { typingKeepaliveMs: options.keepaliveMs } : {}),
      typingSchedule: (tick) => {
        ticks.push(tick)
        return () => undefined
      }
    })
    service.setHost({ onLog: (_level, message) => logs.push(message) })
    await service.start(ACCOUNT_ID)
    return { service, requests, logs, ticks }
  }

  it('下发 getconfig → sendtyping(1)，stop 时 sendtyping(2)', async () => {
    const harness = await createHarness()

    const lease = await harness.service.beginTyping({ to: PEER, contextToken: 'ctx-1' })
    const configCalls = harness.requests.filter((r) => r.path.endsWith('/getconfig'))
    expect(configCalls).toHaveLength(1)
    // getconfig 需要带上对端与会话上下文。
    expect(configCalls[0].body).toMatchObject({
      ilink_user_id: PEER,
      context_token: 'ctx-1'
    })
    expect((configCalls[0].body.base_info as Record<string, unknown>).channel_version).toBe('2.4.6')

    const typingCalls = harness.requests.filter((r) => r.path.endsWith('/sendtyping'))
    expect(typingCalls).toHaveLength(1)
    expect(typingCalls[0].body).toMatchObject({
      ilink_user_id: PEER,
      typing_ticket: 'ticket-abc',
      status: ILINK_TYPING_STATUS_TYPING
    })

    await lease.stop()

    const afterStop = harness.requests.filter((r) => r.path.endsWith('/sendtyping'))
    expect(afterStop).toHaveLength(2)
    expect(afterStop[1].body).toMatchObject({
      ilink_user_id: PEER,
      typing_ticket: 'ticket-abc',
      status: ILINK_TYPING_STATUS_CANCEL
    })

    await harness.service.stop()
  })

  it('typing_ticket 按对端缓存：第二次会话不再调 getconfig', async () => {
    const harness = await createHarness()

    const first = await harness.service.beginTyping({ to: PEER, contextToken: 'ctx-1' })
    await first.stop()
    const second = await harness.service.beginTyping({ to: PEER, contextToken: 'ctx-1' })
    await second.stop()

    expect(harness.requests.filter((r) => r.path.endsWith('/getconfig'))).toHaveLength(1)
    expect(harness.requests.filter((r) => r.path.endsWith('/sendtyping'))).toHaveLength(4)

    await harness.service.stop()
  })

  it('keepalive 会周期性重发 status=1', async () => {
    const harness = await createHarness()

    const lease = await harness.service.beginTyping({ to: PEER })
    expect(harness.ticks).toHaveLength(1)

    harness.ticks[0]()
    harness.ticks[0]()
    await new Promise((resolve) => setTimeout(resolve, 5))

    const typingCalls = harness.requests.filter((r) => r.path.endsWith('/sendtyping'))
    expect(typingCalls).toHaveLength(3)
    expect(typingCalls.every((call) => call.body.status === ILINK_TYPING_STATUS_TYPING)).toBe(true)

    await lease.stop()
    await harness.service.stop()
  })

  it('并发两个 lease：只有最后一个 stop 才下发 cancel', async () => {
    const harness = await createHarness()

    const first = await harness.service.beginTyping({ to: PEER })
    const second = await harness.service.beginTyping({ to: PEER })
    await first.stop()

    let typingCalls = harness.requests.filter((r) => r.path.endsWith('/sendtyping'))
    expect(typingCalls).toHaveLength(1)

    await second.stop()
    typingCalls = harness.requests.filter((r) => r.path.endsWith('/sendtyping'))
    expect(typingCalls).toHaveLength(2)
    expect(typingCalls[1].body.status).toBe(ILINK_TYPING_STATUS_CANCEL)

    await harness.service.stop()
  })

  it('日志里不含 typing_ticket 与 context_token 原文', async () => {
    const harness = await createHarness()

    const lease = await harness.service.beginTyping({ to: PEER, contextToken: 'ctx-SECRET' })
    await lease.stop()
    await harness.service.stop()

    const joined = harness.logs.join('\n')
    expect(joined).toContain('typing.start')
    expect(joined).toContain('typing.stop')
    expect(joined).not.toContain('ticket-abc')
    expect(joined).not.toContain('ctx-SECRET')
    expect(joined).not.toContain(PEER)
    expect(joined).not.toContain('bot-token-value')
  })

  it('连接器 stop 后再 beginTyping 会安全降级（不发请求也不抛）', async () => {
    const harness = await createHarness()
    await harness.service.stop()

    const before = harness.requests.filter((r) => r.path.endsWith('/sendtyping')).length
    const lease = await harness.service.beginTyping({ to: PEER })
    await lease.stop()

    expect(harness.requests.filter((r) => r.path.endsWith('/sendtyping'))).toHaveLength(before)
  })
})
