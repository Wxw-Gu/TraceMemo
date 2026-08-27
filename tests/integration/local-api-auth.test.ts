import fs from 'fs-extra'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  root: `/tmp/wxe-local-api-auth-${process.pid}`,
  storageAvailable: true,
  contacts: [
    {
      m_nsUsrName: 'wxid_fixture',
      m_nsNickName: '测试联系人',
      md5: 'fixture-md5',
      type: 'user' as const
    }
  ],
  chatlogMessages: [
    {
      id: 'message:1',
      type: '图片',
      content: '',
      contentData: { type: 'image', md5: 'fixture-md5', aeskey: 'do-not-return' },
      media: {
        type: 'image',
        available: true,
        url: '/api/v1/media/message%3A1'
      }
    }
  ],
  testSend: vi.fn(async () => ({ success: true, status: 'sent' }))
}))

vi.mock('electron', () => ({
  app: { getPath: () => fixture.root },
  safeStorage: {
    isEncryptionAvailable: () => fixture.storageAvailable,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8').replace(/^encrypted:/, '')
  }
}))

vi.mock('../../src/main/services/chat-service', () => ({
  isReady: () => true,
  listContacts: () => fixture.contacts,
  listMessages: () => fixture.chatlogMessages,
  getGroupSnapshot: () => ({ members: [] }),
  listRecentChat: () => [],
  resolveMd5: () => fixture.contacts[0]
}))

vi.mock('../../src/main/group-report-service', () => ({
  exportGroupReport: vi.fn(async () => ({ success: true }))
}))

vi.mock('../../src/main/services/agent-group-report-service', () => ({
  generateAgentGroupReport: vi.fn(async () => ({ success: true }))
}))

vi.mock('../../src/main/services/agent-hub-service', () => ({
  agentHubService: {
    getStatus: () => ({
      hub: 'online',
      connector: 'online',
      dataApi: 'online',
      databaseReady: true
    }),
    testSend: fixture.testSend
  }
}))

import { apiTokenStore } from '../../src/main/api-token-store'
import { apiServer, startHttpServer, type HttpServerHandle } from '../../src/main/http-server'
import { HttpMediaError } from '../../src/main/http-media-service'
import {
  buildLocalApiCurlCommand,
  testLocalApiRequest
} from '../../src/main/services/local-api-test-service'

const VALID_TOKEN = 'A'.repeat(43)
const handles: HttpServerHandle[] = []

function baseUrl(handle: HttpServerHandle): string {
  return `http://${handle.host}:${handle.port}`
}

async function startFixtureServer(
  tokenProvider = (): string => VALID_TOKEN,
  mediaProvider?: (messageId: string) => Promise<{ buffer: Buffer; mimeType: string }>
): Promise<HttpServerHandle> {
  const handle = await startHttpServer('127.0.0.1', 0, { tokenProvider, mediaProvider })
  handles.push(handle)
  return handle
}

describe('Local API authentication', () => {
  beforeAll(() => fs.ensureDirSync(fixture.root))

  beforeEach(() => {
    fixture.storageAvailable = true
  })

  afterEach(async () => {
    await Promise.all(handles.splice(0).map((handle) => handle.close()))
    await apiServer.stop()
    fixture.testSend.mockClear()
  })

  afterAll(() => fs.removeSync(fixture.root))

  it('keeps health public while protecting contact with a real HTTP request', async () => {
    const handle = await startFixtureServer()
    const health = await fetch(`${baseUrl(handle)}/api/v1/health`)
    expect(health.status).toBe(200)
    const healthBody = await health.json()
    expect(healthBody).toMatchObject({ ok: true, service: 'TraceMemo Reader' })
    expect(JSON.stringify(healthBody)).not.toMatch(
      /token|authorization|wxid|databasePath|provider/i
    )
    await expect(fetch(`${baseUrl(handle)}/api/v1/contact`)).resolves.toMatchObject({ status: 401 })
    await expect(
      fetch(`${baseUrl(handle)}/api/v1/contact`, {
        headers: { Authorization: 'Bearer invalid' }
      })
    ).resolves.toMatchObject({ status: 401 })
    const response = await fetch(`${baseUrl(handle)}/api/v1/contact`, {
      headers: { Authorization: `Bearer ${VALID_TOKEN}` }
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ count: 1 })
  })

  it.each([
    ['GET', '/api/v1/current_time'],
    ['GET', '/api/v1/contact'],
    ['GET', '/api/v1/chatroom'],
    ['GET', '/api/v1/recent_chat'],
    ['GET', '/api/v1/chatlog'],
    ['GET', '/api/v1/media/message-1'],
    ['GET', '/api/v1/group_snapshot'],
    ['GET', '/api/v1/resolve'],
    ['POST', '/api/v1/report'],
    ['GET', '/api/v1/agent/status'],
    ['POST', '/api/v1/agent/group-report'],
    ['POST', '/api/v1/agent/send']
  ])('protects every non-health route: %s %s', async (method, pathname) => {
    const handle = await startFixtureServer()
    const response = await fetch(`${baseUrl(handle)}${pathname}`, {
      method,
      ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: '{}' } : {})
    })
    expect(response.status).toBe(401)
  })

  it('returns image bytes from the authenticated media route without exposing a path', async () => {
    const provider = vi.fn(async (messageId: string) => {
      expect(messageId).toBe('message:1')
      return { buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), mimeType: 'image/jpeg' }
    })
    const handle = await startFixtureServer(() => VALID_TOKEN, provider)
    const response = await fetch(
      `${baseUrl(handle)}/api/v1/media/${encodeURIComponent('message:1')}`,
      {
        headers: { Authorization: `Bearer ${VALID_TOKEN}` }
      }
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('image/jpeg')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    expect(provider).toHaveBeenCalledOnce()
    expect(JSON.stringify(response.headers)).not.toMatch(/path|token|database/i)
  })

  it('adds media metadata to chatlog while redacting image keys', async () => {
    const handle = await startFixtureServer()
    const response = await fetch(`${baseUrl(handle)}/api/v1/chatlog?talker=测试联系人`, {
      headers: { Authorization: `Bearer ${VALID_TOKEN}` }
    })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.messages[0]).toMatchObject({
      id: 'message:1',
      media: {
        type: 'image',
        available: true,
        url: '/api/v1/media/message%3A1'
      }
    })
    expect(body.messages[0].contentData).not.toHaveProperty('aeskey')
  })

  it('maps media lookup failures to stable API statuses', async () => {
    const handle = await startFixtureServer(
      () => VALID_TOKEN,
      async () => {
        throw new HttpMediaError('NOT_IMAGE', '消息不是可读取的图片消息')
      }
    )
    const response = await fetch(`${baseUrl(handle)}/api/v1/media/message-1`, {
      headers: { Authorization: `Bearer ${VALID_TOKEN}` }
    })
    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toMatchObject({ status: 422 })
  })

  it.each(['Basic xxx', 'Bearer', 'bearer xxx', 'Bearer    xxx', 'xxx'])(
    'rejects the invalid Authorization format %s',
    async (authorization) => {
      const handle = await startFixtureServer()
      const response = await fetch(`${baseUrl(handle)}/api/v1/contact`, {
        headers: { Authorization: authorization }
      })
      expect(response.status).toBe(401)
      await expect(response.json()).resolves.toEqual({
        error: 'unauthorized',
        message: 'Valid API token required'
      })
    }
  )

  it('protects agent/send before entering its original handler', async () => {
    const handle = await startFixtureServer()
    const url = `${baseUrl(handle)}/api/v1/agent/send`
    const init = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'fixture', text: 'test' })
    }
    expect((await fetch(url, init)).status).toBe(401)
    expect(
      (
        await fetch(url, {
          ...init,
          headers: { ...init.headers, Authorization: 'Bearer invalid' }
        })
      ).status
    ).toBe(401)
    expect(fixture.testSend).not.toHaveBeenCalled()
    expect(
      (
        await fetch(url, {
          ...init,
          headers: { ...init.headers, Authorization: `Bearer ${VALID_TOKEN}` }
        })
      ).status
    ).toBe(200)
    expect(fixture.testSend).toHaveBeenCalledOnce()
  })

  it.each([
    'http://localhost',
    'http://localhost:5173',
    'http://127.0.0.1',
    'http://127.0.0.1:5173',
    'http://[::1]',
    'http://[::1]:5173'
  ])('allows the trusted CORS origin %s', async (origin) => {
    const handle = await startFixtureServer()
    const response = await fetch(`${baseUrl(handle)}/api/v1/health`, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'Authorization'
      }
    })
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe(origin)
    expect(response.headers.get('access-control-allow-methods')).toContain('PATCH')
    expect(response.headers.get('access-control-allow-methods')).toContain('DELETE')
    expect(response.headers.get('access-control-allow-headers')).toBe('Content-Type, Authorization')
  })

  it.each([
    'https://localhost',
    'http://localhost.example.com',
    'http://foo.localhost',
    'http://localhost.',
    'http://127.0.0.2',
    'http://2130706433',
    'https://example.com',
    'http://example.com'
  ])('rejects the untrusted CORS origin %s', async (origin) => {
    const handle = await startFixtureServer()
    const response = await fetch(`${baseUrl(handle)}/api/v1/health`, {
      method: 'OPTIONS',
      headers: { Origin: origin }
    })
    expect(response.status).toBe(403)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('allows clients without an Origin header', async () => {
    const handle = await startFixtureServer()
    const response = await fetch(`${baseUrl(handle)}/api/v1/contact`, {
      headers: { Authorization: `Bearer ${VALID_TOKEN}` }
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('rotates immediately, authenticates the API Center client, and stops cleanly', async () => {
    const state = await apiServer.start('127.0.0.1', 0)
    expect(state.running).toBe(true)
    const serviceUrl = `http://${state.host}:${state.port}`
    const oldToken = apiTokenStore.revealToken().token
    expect(oldToken).toBeTruthy()
    expect(
      (
        await fetch(`${serviceUrl}/api/v1/contact`, {
          headers: { Authorization: `Bearer ${oldToken}` }
        })
      ).status
    ).toBe(200)
    await expect(testLocalApiRequest({ endpointId: 'contact' })).resolves.toMatchObject({
      ok: true,
      status: 200
    })
    expect(apiTokenStore.rotateToken().success).toBe(true)
    const newToken = apiTokenStore.revealToken().token
    expect(newToken).not.toBe(oldToken)
    expect(
      (
        await fetch(`${serviceUrl}/api/v1/contact`, {
          headers: { Authorization: `Bearer ${oldToken}` }
        })
      ).status
    ).toBe(401)
    expect(
      (
        await fetch(`${serviceUrl}/api/v1/contact`, {
          headers: { Authorization: `Bearer ${newToken}` }
        })
      ).status
    ).toBe(200)
    await expect(testLocalApiRequest({ endpointId: 'contact' })).resolves.toMatchObject({
      ok: true,
      status: 200
    })
    const curl = buildLocalApiCurlCommand({ endpointId: 'contact', query: { type: 'group' } })
    expect(curl.success).toBe(true)
    expect(curl.command).toContain(`Authorization: Bearer ${newToken}`)
    expect(curl.command).not.toContain(`token=${newToken}`)

    await apiServer.stop()
    await expect(fetch(`${serviceUrl}/api/v1/health`)).rejects.toThrow()
  })

  it('fails closed when Electron safeStorage is unavailable', async () => {
    fixture.storageAvailable = false
    const state = await apiServer.start('127.0.0.1', 0)
    expect(state).toMatchObject({ running: false, host: '127.0.0.1', port: 0 })
    expect(state.error).toContain('系统安全存储不可用')
    expect(apiServer.isRunning()).toBe(false)
  })
})
