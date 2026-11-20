import { describe, expect, it, vi } from 'vitest'
import {
  WorkBuddyAgentTaskProvider,
  WorkBuddyAccessTokenSource,
  parseReplies
} from '../../src/main/services/workbuddy-agent-provider'
import { AgentTaskProviderError } from '../../src/main/services/agent-task-provider'
import type { WorkBuddyCredentials } from '../../src/main/services/agent-task-config'

/**
 * WorkBuddy Open API 适配器契约。
 *
 * 这些用例**只验证客户端行为**（请求形状、鉴权、错误分类、解析），
 * 不代表真实账号已经接入成功。真实链路需要凭证 + 在线助理，本轮未验证。
 */

type FetchMock = ReturnType<typeof vi.fn>
type FetchCall = [url: string, init: RequestInit]

function callsOf(fetchImpl: FetchMock): FetchCall[] {
  return fetchImpl.mock.calls as unknown as FetchCall[]
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

function provider(
  fetchImpl: FetchMock,
  credentials: WorkBuddyCredentials = { accessToken: 'token-1' }
): WorkBuddyAgentTaskProvider {
  return new WorkBuddyAgentTaskProvider({
    baseUrl: 'https://workbuddy.test',
    timeoutMs: 500,
    credentials,
    fetchImpl: fetchImpl as unknown as typeof fetch
  })
}

describe('在线检测与投递', () => {
  it('GET /openapi/v2/localassistant，带 Bearer，返回 data.online', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 0, data: { online: true } }))
    await expect(provider(fetchImpl).checkOnline()).resolves.toBe(true)

    const [url, init] = callsOf(fetchImpl)[0]
    expect(url).toBe('https://workbuddy.test/openapi/v2/localassistant')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token-1')
  })

  it('online=false 如实返回 false（不降级成「已提交」）', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 0, data: { online: false } }))
    await expect(provider(fetchImpl).checkOnline()).resolves.toBe(false)
  })

  it('投递使用 msg_type=text，并读取 data.message_id', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 0, data: { message_id: 'msg-001' } }))
    const result = await provider(fetchImpl).submitTask({ content: '/ai 写日报' })

    expect(result).toEqual({ messageId: 'msg-001' })
    const [url, init] = callsOf(fetchImpl)[0]
    expect(url).toBe('https://workbuddy.test/openapi/v2/localassistant/message')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ content: '/ai 写日报', msg_type: 'text' })
  })

  it('投递响应缺 message_id 时报 invalid_response', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 0, data: {} }))
    await expect(provider(fetchImpl).submitTask({ content: 'x' })).rejects.toMatchObject({
      kind: 'invalid_response'
    })
  })
})

describe('鉴权', () => {
  it('没有凭证时明确 auth_missing', async () => {
    const fetchImpl = vi.fn()
    await expect(provider(fetchImpl, {}).checkOnline()).rejects.toMatchObject({
      kind: 'auth_missing'
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('401 时用 refresh_token 换新 token 并重试一次', async () => {
    let messageCalls = 0
    const fetchImpl = vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.endsWith('/openapi/v2/token')) {
        return jsonResponse({ code: 0, data: { access_token: 'fresh', expires_in: 3600 } })
      }
      messageCalls += 1
      if (messageCalls === 1) return jsonResponse({ code: 401, msg: 'expired' }, 401)
      return jsonResponse({ code: 0, data: { message_id: 'msg-2' } })
    })

    const instance = provider(fetchImpl, {
      accessToken: 'stale',
      refreshToken: 'refresh-1',
      clientId: 'client-1',
      clientSecret: 'secret-1'
    })
    await expect(instance.submitTask({ content: 'x' })).resolves.toEqual({ messageId: 'msg-2' })

    expect(messageCalls).toBe(2)
    const calls = callsOf(fetchImpl)
    const tokenCall = calls.find(([url]) => url.endsWith('/token'))!
    const body = String(tokenCall[1].body)
    expect(body).toContain('grant_type=refresh_token')
    expect(body).toContain('refresh_token=refresh-1')

    // 第二次投递必须使用刷新后的 token。
    const messageCallsWithInit = calls.filter(([url]) => url.endsWith('/localassistant/message'))
    const secondHeaders = messageCallsWithInit[1][1].headers as Record<string, string>
    expect(secondHeaders.Authorization).toBe('Bearer fresh')
  })

  it('refresh 也失败时报 auth_expired，不无限重试', async () => {
    const fetchImpl = vi.fn(async (input: unknown) => {
      if (String(input).endsWith('/token')) {
        return jsonResponse({ code: 400, msg: 'invalid_grant' }, 400)
      }
      return jsonResponse({ code: 401 }, 401)
    })
    const instance = provider(fetchImpl, {
      accessToken: 'stale',
      refreshToken: 'bad',
      clientId: 'c',
      clientSecret: 's'
    })
    await expect(instance.submitTask({ content: 'x' })).rejects.toMatchObject({
      kind: 'auth_expired'
    })
  })

  it('静态 token 遇到 401 且无 refresh 时给 auth_expired，错误里不回显 token', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 401 }, 401))
    const instance = provider(fetchImpl, { accessToken: 'super-secret-token' })
    const error = await instance.submitTask({ content: 'x' }).catch((caught) => caught)

    expect(error).toBeInstanceOf(AgentTaskProviderError)
    expect(error.kind).toBe('auth_expired')
    expect(String(error.message)).not.toContain('super-secret-token')
  })

  it('403 归类为 auth_expired（scope 不足）', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 403 }, 403))
    await expect(provider(fetchImpl).checkOnline()).rejects.toMatchObject({
      kind: 'auth_expired',
      httpStatus: 403
    })
  })
})

describe('超时与错误分类', () => {
  it('请求超时归类为 timeout', async () => {
    const fetchImpl = vi.fn(
      (_url: unknown, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          })
        })
    )
    const instance = new WorkBuddyAgentTaskProvider({
      baseUrl: 'https://workbuddy.test',
      timeoutMs: 20,
      credentials: { accessToken: 'token-1' },
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    await expect(instance.checkOnline()).rejects.toMatchObject({ kind: 'timeout' })
  })

  it('5xx 归类为可重试的 http_error', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 500, msg: 'boom' }, 503))
    await expect(provider(fetchImpl).checkOnline()).rejects.toMatchObject({
      kind: 'http_error',
      retryable: true,
      httpStatus: 503
    })
  })

  it('业务 code 非 0 时不当成功', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 1001, msg: 'denied' }))
    await expect(provider(fetchImpl).submitTask({ content: 'x' })).rejects.toMatchObject({
      kind: 'http_error'
    })
  })
})

describe('回复解析', () => {
  it('从 data.messages 解析 role / content[] / created_at', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        code: 0,
        data: {
          messages: [
            {
              message_id: 'm1',
              role: 'assistant',
              content: [
                { type: 'text', text: '第一段' },
                { type: 'text', text: '第二段' }
              ],
              created_at: '2026-10-23T03:00:00Z'
            },
            { message_id: 'm2', role: 'system', content: 'plain' }
          ]
        }
      })
    )

    const replies = await provider(fetchImpl).fetchReplies('m0')
    expect(replies).toEqual([
      {
        messageId: 'm1',
        role: 'assistant',
        text: '第一段\n第二段',
        createdAt: '2026-10-23T03:00:00Z'
      },
      { messageId: 'm2', role: 'other', text: 'plain' }
    ])

    const [url] = callsOf(fetchImpl)[0]
    expect(url).toContain('/openapi/v2/localassistant/message?')
    expect(url).toContain('message_id=m0')
  })

  it('容错：data 直接是数组 / 缺 message_id 的条目被跳过', () => {
    expect(
      parseReplies([
        { message_id: 'a', role: 'assistant', content: [{ text: 'hi' }] },
        { role: 'assistant', content: 'no id' }
      ])
    ).toEqual([{ messageId: 'a', role: 'assistant', text: 'hi' }])
  })
})

describe('WorkBuddyAccessTokenSource', () => {
  it('缓存未过期时复用 token，不发第二次请求', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ code: 0, data: { access_token: 'cached', expires_in: 3600 } })
    )
    const source = new WorkBuddyAccessTokenSource({
      baseUrl: 'https://workbuddy.test',
      timeoutMs: 500,
      credentials: { refreshToken: 'r', clientId: 'c', clientSecret: 's' },
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    await expect(source.getAccessToken()).resolves.toBe('cached')
    await expect(source.getAccessToken()).resolves.toBe('cached')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
