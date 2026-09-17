import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WechatConnectorService } from '../../src/main/services/wechat-ilink'
import {
  accountsDirectory,
  normalizeAccountId,
  saveCredentials
} from '../../src/main/services/wechat-ilink/account-store'
import type { WechatInboundMessage } from '../../src/main/services/wechat-ilink/types'

const ACCOUNT_ID = 'bot_ctx@im.bot'
const NORMALIZED_ACCOUNT_ID = normalizeAccountId(ACCOUNT_ID)

interface RecordedRequest {
  path: string
  body: Record<string, unknown>
}

describe('wechat-ilink 连接器：context_token 全链路', () => {
  const homes: string[] = []

  afterEach(() => {
    while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true })
  })

  function createHome(): string {
    const home = mkdtempSync(join(tmpdir(), 'tracememo-ilink-ctx-'))
    homes.push(home)
    saveCredentials(
      {
        bot_token: 'bot-token-value',
        ilink_bot_id: ACCOUNT_ID,
        baseurl: 'https://ilinkai.weixin.qq.com',
        ilink_user_id: 'user_42'
      },
      () => home
    )
    return home
  }

  function createHarness(options: { inboundContextToken?: string; sendRet?: number } = {}): {
    home: string
    service: WechatConnectorService
    requests: RecordedRequest[]
    received: WechatInboundMessage[]
    fetchImpl: typeof fetch
  } {
    const home = createHome()
    const requests: RecordedRequest[] = []
    const received: WechatInboundMessage[] = []
    let getUpdatesCalls = 0

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
        getUpdatesCalls += 1
        if (getUpdatesCalls === 1) {
          return json({
            ret: 0,
            errcode: 0,
            msgs: [
              {
                message_id: 9001,
                from_user_id: 'user@im.wechat',
                message_type: 1,
                item_list: [{ type: 1, text_item: { text: '最近聊了什么' } }],
                context_token: options.inboundContextToken ?? 'ctx-from-inbound'
              }
            ],
            get_updates_buf: 'buf-after-first-batch',
            longpolling_timeout_ms: 35_000
          })
        }
        // 让出宏任务，避免测试期间的紧密轮询饿死定时器。
        await new Promise((resolve) => setTimeout(resolve, 2))
        return json({ ret: 0, msgs: [], get_updates_buf: 'buf-after-first-batch' })
      }

      if (url.pathname.endsWith('/sendmessage')) {
        return json({ ret: options.sendRet ?? 0, errmsg: options.sendRet ? 'send failed' : '' })
      }
      return json({ ret: 0 })
    }) as unknown as typeof fetch

    const service = new WechatConnectorService({
      home: () => home,
      fetchImpl,
      sleep: async () => undefined
    })
    service.setHost({
      onMessages: async (messages) => {
        received.push(...messages)
      }
    })
    return { home, service, requests, received, fetchImpl }
  }

  it('入站 context_token 原样出现在回复的 sendmessage 请求里', async () => {
    const harness = createHarness({ inboundContextToken: 'ctx-from-inbound' })

    await harness.service.start(ACCOUNT_ID)
    await vi.waitFor(() => expect(harness.received).toHaveLength(1))
    expect(harness.received[0].contextToken).toBe('ctx-from-inbound')

    await harness.service.sendText({
      to: 'user@im.wechat',
      text: '这是回答',
      contextToken: harness.received[0].contextToken
    })
    await harness.service.stop()

    const send = harness.requests.filter((request) => request.path.endsWith('/sendmessage'))
    expect(send).toHaveLength(1)
    const msg = send[0].body.msg as Record<string, unknown>
    expect(msg.context_token).toBe('ctx-from-inbound')
    expect(msg.to_user_id).toBe('user@im.wechat')
    expect(msg.message_type).toBe(2)
    expect(msg.message_state).toBe(2)
    // 官方实现：Bot 外发 from_user_id 传空字符串。
    expect(msg.from_user_id).toBe('')
    expect((send[0].body.base_info as Record<string, unknown>).channel_version).toBe('2.4.6')
    expect((msg.item_list as Array<Record<string, unknown>>)[0]).toEqual({
      type: 1,
      text_item: { text: '这是回答' }
    })
  })

  it('主动发送时回退到该会话最近一次有效 context_token', async () => {
    const harness = createHarness({ inboundContextToken: 'ctx-stored' })

    await harness.service.start(ACCOUNT_ID)
    await vi.waitFor(() => expect(harness.received).toHaveLength(1))

    // 定时日报这类主动发送不会携带入站 token。
    await harness.service.sendText({ to: 'user@im.wechat', text: '日报已生成' })
    await harness.service.stop()

    const send = harness.requests.filter((request) => request.path.endsWith('/sendmessage'))
    expect(send[0].body.msg).toMatchObject({ context_token: 'ctx-stored' })
  })

  it('没有入站记录的会话主动发送时 context_token 为空字符串而不是错误 token', async () => {
    const harness = createHarness()

    await harness.service.start(ACCOUNT_ID)
    await vi.waitFor(() => expect(harness.received).toHaveLength(1))
    await harness.service.sendText({ to: 'someone-else@im.wechat', text: 'hi' })
    await harness.service.stop()

    const send = harness.requests.filter((request) => request.path.endsWith('/sendmessage'))
    expect(send[0].body.msg).toMatchObject({ context_token: '' })
  })

  it('getupdates 携带持久化游标，并在消息被接收后推进游标', async () => {
    const harness = createHarness()

    await harness.service.start(ACCOUNT_ID)
    await vi.waitFor(() => expect(harness.received).toHaveLength(1))
    await harness.service.stop()

    const getUpdates = harness.requests.filter((request) => request.path.endsWith('/getupdates'))
    expect(getUpdates[0].body.get_updates_buf).toBe('')

    const cursorFile = join(
      accountsDirectory(() => harness.home),
      `${NORMALIZED_ACCOUNT_ID}.sync.json`
    )
    const stored = JSON.parse(readFileSync(cursorFile, 'utf8')) as { get_updates_buf: string }
    expect(stored.get_updates_buf).toBe('buf-after-first-batch')
  })

  it('session 失效时进入 stale_token 状态并停止轮询', async () => {
    const home = createHome()
    const phases: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/getupdates')) {
        return new Response(
          JSON.stringify({ ret: 0, errcode: -14, msgs: [], get_updates_buf: '' }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          }
        )
      }
      return new Response(JSON.stringify({ ret: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    }) as unknown as typeof fetch

    const service = new WechatConnectorService({ home: () => home, fetchImpl })
    service.setHost({
      onMessages: async () => undefined,
      onPhaseChange: (phase) => phases.push(phase)
    })
    await service.start(ACCOUNT_ID)
    await vi.waitFor(() => expect(service.getPhase()).toBe('stale_token'))

    expect(phases).toContain('stale_token')
    // 会话失效后发送必须被明确拒绝，而不是静默失败。
    await expect(service.sendText({ to: 'user@im.wechat', text: 'hi' })).rejects.toThrow(
      /登录凭证已失效/
    )
  })

  it('sendmessage ret 非 0 时抛错，绝不当成发送成功', async () => {
    const harness = createHarness({ sendRet: 40001 })
    await harness.service.start(ACCOUNT_ID)
    await vi.waitFor(() => expect(harness.received).toHaveLength(1))

    await expect(harness.service.sendText({ to: 'user@im.wechat', text: 'hi' })).rejects.toThrow(
      /ret=40001/
    )

    await harness.service.stop()
  })

  it('账号列表来自持久化凭据，且未启动时发送会被拒绝', async () => {
    const home = createHome()
    const directory = accountsDirectory(() => home)
    mkdirSync(directory, { recursive: true })
    writeFileSync(
      join(directory, 'another.json'),
      JSON.stringify({
        bot_token: 'other',
        ilink_bot_id: 'bot_other',
        baseurl: 'https://ilinkai.weixin.qq.com',
        ilink_user_id: 'user_9'
      }),
      'utf8'
    )
    const service = new WechatConnectorService({ home: () => home })

    const accounts = service.listAccounts().map((item) => item.accountId)
    expect(accounts).toContain(ACCOUNT_ID)
    expect(accounts).toContain('bot_other')

    await expect(service.sendText({ to: 'user@im.wechat', text: 'hi' })).rejects.toThrow(/尚未启动/)
  })
})
