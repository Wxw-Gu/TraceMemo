import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runQrLogin } from '../../src/main/services/wechat-ilink/auth'
import { accountsDirectory } from '../../src/main/services/wechat-ilink/account-store'
import type { ILinkCredentials, WechatLoginEvent } from '../../src/main/services/wechat-ilink/types'

interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

const qrResponse = {
  qrcode: 'qr-secret-token',
  qrcode_img_content: 'https://liteapp.weixin.qq.com/q/demo'
}

const credentialsBody = {
  status: 'confirmed',
  bot_token: 'bot-token-value',
  ilink_bot_id: 'bot_abc@im.bot',
  ilink_user_id: 'user_42',
  baseurl: 'https://ilinkai.weixin.qq.com'
}

/** 防止用例写错时无限轮询：超过硬上限直接中止登录，让断言失败而不是挂死进程。 */
const HARD_CALL_LIMIT = 40

function createScriptedFetch(
  statusQueue: unknown[],
  onExhausted?: () => void
): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = String(value)
    }
    calls.push({
      url,
      method: String(init?.method ?? 'GET'),
      headers,
      ...(typeof init?.body === 'string' ? { body: init.body } : {})
    })
    if (calls.length > HARD_CALL_LIMIT) {
      onExhausted?.()
      throw new Error('scripted fetch hard call limit reached')
    }

    if (url.includes('/ilink/bot/get_bot_qrcode')) return jsonResponse(qrResponse)
    if (url.includes('/ilink/bot/get_qrcode_status')) {
      const next = statusQueue.shift() ?? { status: 'wait' }
      if (next instanceof Error) throw next
      return jsonResponse(next)
    }
    return jsonResponse({}, 404)
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

describe('wechat-ilink QR 登录', () => {
  const homes: string[] = []

  afterEach(() => {
    while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true })
  })

  function createHome(): string {
    const home = mkdtempSync(join(tmpdir(), 'tracememo-ilink-login-'))
    homes.push(home)
    return home
  }

  function createLogin(options: {
    home: string
    statusQueue: unknown[]
    maxQrRefreshes?: number
    verifyCodeProvider?: () => Promise<string | undefined>
  }): {
    calls: RecordedCall[]
    events: WechatLoginEvent[]
    run: () => Promise<ILinkCredentials>
  } {
    const controller = new AbortController()
    const { fetchImpl, calls } = createScriptedFetch(options.statusQueue, () => controller.abort())
    const events: WechatLoginEvent[] = []
    return {
      calls,
      events,
      run: () =>
        runQrLogin({
          home: () => options.home,
          fetchImpl,
          signal: controller.signal,
          sleep: async () => undefined,
          qrEncoder: async (content) =>
            `data:image/png;base64,${Buffer.from(content).toString('base64')}`,
          ...(options.maxQrRefreshes !== undefined
            ? { maxQrRefreshes: options.maxQrRefreshes }
            : {}),
          ...(options.verifyCodeProvider ? { verifyCodeProvider: options.verifyCodeProvider } : {}),
          onEvent: (event) => events.push(event)
        })
    }
  }

  it('完成 wait → scaned → confirmed 流程并落盘凭据', async () => {
    const home = createHome()
    const harness = createLogin({
      home,
      statusQueue: [{ status: 'wait' }, { status: 'scaned' }, credentialsBody]
    })

    const credentials = await harness.run()

    expect(credentials).toMatchObject({
      bot_token: 'bot-token-value',
      ilink_bot_id: 'bot_abc@im.bot',
      ilink_user_id: 'user_42'
    })
    expect(harness.events.map((event) => event.status)).toEqual([
      'qrcode',
      'wait',
      'scaned',
      'confirmed',
      'active'
    ])
    const qrEvent = harness.events[0]
    expect(
      qrEvent.status === 'qrcode' && qrEvent.qrCodeDataUrl.startsWith('data:image/png;base64,')
    ).toBe(true)

    const stored = JSON.parse(
      readFileSync(
        join(
          accountsDirectory(() => home),
          'bot_abc-im-bot.json'
        ),
        'utf8'
      )
    ) as { bot_token: string }
    expect(stored.bot_token).toBe('bot-token-value')
  })

  it('用 POST + local_token_list 获取二维码，且登录前不发送 Authorization', async () => {
    const home = createHome()
    const harness = createLogin({ home, statusQueue: [credentialsBody] })

    await harness.run()

    const qrCall = harness.calls[0]
    expect(qrCall.url).toBe('https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3')
    expect(qrCall.method).toBe('POST')
    expect(JSON.parse(qrCall.body!)).toEqual({ local_token_list: [] })
    expect(qrCall.headers['ilink-app-id']).toBe('bot')
    expect(qrCall.headers['ilink-app-clientversion']).toBe('132102')
    expect(qrCall.headers.authorization).toBeUndefined()

    const statusCall = harness.calls.find((call) => call.url.includes('get_qrcode_status'))!
    expect(statusCall.headers.authorization).toBeUndefined()
    expect(statusCall.headers['x-wechat-uin']).toBeUndefined()
  })

  it('已登录账号的 token 会进入 local_token_list', async () => {
    const home = createHome()
    const directory = accountsDirectory(() => home)
    mkdirSync(directory, { recursive: true })
    writeFileSync(
      join(directory, 'existing.json'),
      JSON.stringify({
        bot_token: 'existing-token',
        ilink_bot_id: 'bot_existing',
        baseurl: 'https://ilinkai.weixin.qq.com',
        ilink_user_id: 'user_1'
      }),
      'utf8'
    )
    const harness = createLogin({ home, statusQueue: [credentialsBody] })

    await harness.run()

    expect(JSON.parse(harness.calls[0].body!)).toEqual({ local_token_list: ['existing-token'] })
  })

  it('scaned_but_redirect 后改用 redirect_host 继续轮询状态', async () => {
    const home = createHome()
    const harness = createLogin({
      home,
      statusQueue: [
        { status: 'scaned_but_redirect', redirect_host: 'idc2.weixin.qq.com' },
        credentialsBody
      ]
    })

    await harness.run()

    const statusCalls = harness.calls.filter((call) => call.url.includes('get_qrcode_status'))
    expect(statusCalls[0].url.startsWith('https://ilinkai.weixin.qq.com/')).toBe(true)
    expect(statusCalls[1].url.startsWith('https://idc2.weixin.qq.com/')).toBe(true)
    expect(statusCalls[1].url).toContain('qrcode=qr-secret-token')
  })

  it('need_verifycode 时把配对码填进下一次状态请求', async () => {
    const home = createHome()
    const harness = createLogin({
      home,
      statusQueue: [{ status: 'need_verifycode' }, credentialsBody],
      verifyCodeProvider: async () => ' 246810 '
    })

    await harness.run()

    const statusCalls = harness.calls.filter((call) => call.url.includes('get_qrcode_status'))
    expect(statusCalls[0].url).not.toContain('verify_code')
    expect(statusCalls[1].url).toContain('verify_code=246810')
    expect(harness.events.some((event) => event.status === 'need_verifycode')).toBe(true)
  })

  it('没有配对码输入通道时刷新二维码，超过上限后明确失败', async () => {
    const home = createHome()
    const harness = createLogin({
      home,
      statusQueue: [{ status: 'need_verifycode' }, { status: 'need_verifycode' }],
      maxQrRefreshes: 1
    })

    await expect(harness.run()).rejects.toThrow(/二维码多次刷新后仍未完成登录/)
    expect(harness.calls.filter((call) => call.url.includes('get_bot_qrcode'))).toHaveLength(2)
  })

  it('verify_code_blocked 清除配对码并刷新二维码', async () => {
    const home = createHome()
    const harness = createLogin({
      home,
      statusQueue: [
        { status: 'need_verifycode' },
        { status: 'verify_code_blocked' },
        { status: 'need_verifycode' },
        { status: 'verify_code_blocked' }
      ],
      maxQrRefreshes: 1,
      verifyCodeProvider: async () => '123456'
    })

    await expect(harness.run()).rejects.toThrow(/二维码多次刷新后仍未完成登录/)

    const statusCalls = harness.calls.filter((call) => call.url.includes('get_qrcode_status'))
    expect(statusCalls[1].url).toContain('verify_code=123456')
    // 被限制后重新扫码，第二次请求不再携带旧配对码。
    expect(statusCalls[2].url).not.toContain('verify_code=')
    expect(harness.events.some((event) => event.status === 'verify_code_blocked')).toBe(true)
  })

  it('二维码过期时自动刷新', async () => {
    const home = createHome()
    const harness = createLogin({
      home,
      statusQueue: [{ status: 'expired' }, credentialsBody],
      maxQrRefreshes: 2
    })

    await harness.run()

    expect(harness.calls.filter((call) => call.url.includes('get_bot_qrcode'))).toHaveLength(2)
    expect(harness.events.filter((event) => event.status === 'qrcode')).toHaveLength(2)
    expect(harness.events.some((event) => event.status === 'expired')).toBe(true)
  })

  it('binded_redirect 在本地没有可用凭据时不能当作登录成功', async () => {
    const home = createHome()
    const harness = createLogin({
      home,
      statusQueue: [{ status: 'binded_redirect' }],
      maxQrRefreshes: 0
    })

    await expect(harness.run()).rejects.toThrow(/二维码多次刷新后仍未完成登录/)
  })

  it('binded_redirect 在本地已有凭据时直接复用，不重新扫码', async () => {
    const home = createHome()
    const directory = accountsDirectory(() => home)
    mkdirSync(directory, { recursive: true })
    writeFileSync(
      join(directory, 'bot_existing.json'),
      JSON.stringify({
        bot_token: 'existing-token',
        ilink_bot_id: 'bot_existing',
        baseurl: 'https://ilinkai.weixin.qq.com',
        ilink_user_id: 'user_1'
      }),
      'utf8'
    )

    const harness = createLogin({ home, statusQueue: [{ status: 'binded_redirect' }] })
    const credentials = await harness.run()

    expect(credentials.bot_token).toBe('existing-token')
    expect(harness.events.map((event) => event.status)).toEqual(['qrcode', 'confirmed', 'active'])
  })

  it('confirmed 但缺少 ilink_bot_id 时明确报错而不是写入半截凭据', async () => {
    const home = createHome()
    const harness = createLogin({
      home,
      statusQueue: [{ status: 'confirmed', bot_token: 'x' }]
    })

    await expect(harness.run()).rejects.toThrow(/ilink_bot_id/)
  })

  it('状态轮询网络错误按 wait 处理并继续轮询', async () => {
    const home = createHome()
    const harness = createLogin({
      home,
      statusQueue: [new Error('ETIMEDOUT'), { status: 'scaned' }, credentialsBody]
    })

    const credentials = await harness.run()
    expect(credentials.ilink_bot_id).toBe('bot_abc@im.bot')
  })
})
