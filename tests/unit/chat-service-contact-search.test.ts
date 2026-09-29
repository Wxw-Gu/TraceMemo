import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WechatDb } from '../../src/main/wechat-db'
import { listContacts, listContactsAsync, setChatDb } from '../../src/main/services/chat-service'

/**
 * Issue #51 root-cause evidence.
 *
 * `listContactsAsync` hydrates display names / identities before filtering,
 * while the synchronous `listContacts` reads whatever the session cache holds.
 * On macOS the session cache frequently only carries raw ids (mirrors the
 * production comment in `listContactsAsync`), so the sync path cannot match a
 * Chinese nickname even though hydration makes both the contact and the group
 * searchable.
 */

const HYDRATED_USER_NAME = '张三'
const HYDRATED_GROUP_NAME = '张三的测试群'

function createMacOsStyleFixtureDb(): WechatDb {
  // Before hydration the macOS session rows only expose raw identifiers.
  const userSession = { username: 'wxid_fixture_user', nickname: 'wxid_fixture_user' }
  const groupSession = { username: 'fixture_group@chatroom', nickname: 'fixture_group@chatroom' }

  const getSessionsAsync = vi.fn(async (options: { hydrateDisplayNames?: boolean }) => {
    if (options.hydrateDisplayNames) {
      userSession.nickname = HYDRATED_USER_NAME
      groupSession.nickname = HYDRATED_GROUP_NAME
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

  return fakeDb
}

describe('chat service contact search on un-hydrated macOS sessions', () => {
  afterEach(() => setChatDb(null))

  it('sync listContacts cannot see display names that only hydration provides', () => {
    setChatDb(createMacOsStyleFixtureDb())

    expect(listContacts('张三')).toEqual([])
  })

  it('async listContactsAsync hydrates first and returns both the contact and the group', async () => {
    setChatDb(createMacOsStyleFixtureDb())

    const matches = await listContactsAsync('张三')

    expect(matches.map((contact) => contact.type).sort()).toEqual(['group', 'user'])
    expect(matches.every((contact) => contact.m_nsNickName.includes('张三'))).toBe(true)
  })
})
