import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/wxe-local-api-contact-search' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8').replace(/^encrypted:/, '')
  }
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
    testSend: vi.fn(async () => ({ success: true, status: 'sent' }))
  }
}))

// NOTE: chat-service is intentionally NOT mocked here — the HTTP layer must be
// exercised against the real contact search path so hydration is on the hook.
import type { WechatDb } from '../../src/main/wechat-db'
import { setChatDb } from '../../src/main/services/chat-service'
import { startHttpServer, type HttpServerHandle } from '../../src/main/http-server'

const TOKEN = 'B'.repeat(43)
const AUTH_HEADERS = { Authorization: `Bearer ${TOKEN}` }
const handles: HttpServerHandle[] = []

interface ContactSearchResponse {
  count: number
  contacts: Array<{ type: string; m_nsNickName: string }>
}

async function startServer(): Promise<string> {
  const handle = await startHttpServer('127.0.0.1', 0, { tokenProvider: () => TOKEN })
  handles.push(handle)
  return `http://${handle.host}:${handle.port}`
}

/**
 * A WechatDb stand-in that reproduces macOS behaviour: raw ids in the session
 * cache until `getSessionsAsync({ hydrateDisplayNames: true })` runs.
 */
function installMacOsStyleFixtureDb(): void {
  const userSession = { username: 'wxid_fixture_user', nickname: 'wxid_fixture_user' }
  const groupSession = { username: 'fixture_group@chatroom', nickname: 'fixture_group@chatroom' }

  const getSessionsAsync = vi.fn(async (options: { hydrateDisplayNames?: boolean }) => {
    if (options.hydrateDisplayNames) {
      userSession.nickname = '张三'
      groupSession.nickname = '张三的测试群'
    }
    return [userSession, groupSession]
  })

  const fakeDb = {
    close: vi.fn(),
    md5: (value: string) => `md5-${value}`,
    hydrateContactIdentitiesAsync: vi.fn(async () => undefined),
    getAllGroupContacts: () => ({ [`md5-${groupSession.username}`]: groupSession.nickname }),
    getUserList: () => [
      {
        m_nsUsrName: userSession.username,
        nickname: userSession.nickname,
        wxid: userSession.username
      },
      {
        m_nsUsrName: groupSession.username,
        nickname: groupSession.nickname
      }
    ],
    getWcdb4Client: () => ({ getSessionsAsync })
  } as unknown as WechatDb

  setChatDb(fakeDb)
}

describe('Local API contact search (Issue #51)', () => {
  beforeEach(() => installMacOsStyleFixtureDb())

  afterEach(async () => {
    await Promise.all(handles.splice(0).map((handle) => handle.close()))
    setChatDb(null)
  })

  it('returns the contact and the group when one keyword matches both', async () => {
    const base = await startServer()
    const response = await fetch(`${base}/api/v1/contact?filter=${encodeURIComponent('张三')}`, {
      headers: AUTH_HEADERS
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as ContactSearchResponse
    expect(body.count).toBe(2)
    expect(body.contacts.map((contact) => contact.type).sort()).toEqual(['group', 'user'])
  })

  it('keeps the type=user and type=group filters intact', async () => {
    const base = await startServer()
    const query = `filter=${encodeURIComponent('张三')}`

    const users = (await (
      await fetch(`${base}/api/v1/contact?${query}&type=user`, { headers: AUTH_HEADERS })
    ).json()) as ContactSearchResponse
    expect(users.count).toBe(1)
    expect(users.contacts.every((contact) => contact.type === 'user')).toBe(true)
    expect(users.contacts.some((contact) => contact.m_nsNickName === '张三')).toBe(true)

    const groups = (await (
      await fetch(`${base}/api/v1/contact?${query}&type=group`, { headers: AUTH_HEADERS })
    ).json()) as ContactSearchResponse
    expect(groups.count).toBe(1)
    expect(groups.contacts.every((contact) => contact.type === 'group')).toBe(true)
  })

  it('hydrates group names before the chatroom keyword search runs', async () => {
    const base = await startServer()
    const response = await fetch(`${base}/api/v1/chatroom?keyword=${encodeURIComponent('张三')}`, {
      headers: AUTH_HEADERS
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { count: number }
    expect(body.count).toBe(1)
  })
})
