import { describe, expect, it, vi } from 'vitest'
import { Wcdb4Client } from '../../src/main/wcdb4-client'

const groupMemberRows = [
  {
    username: 'wxid-member',
    // 某些微信数据版本会在这个字段返回通讯录备注，不能作为微信昵称使用。
    nickname: '被污染的接口备注',
    groupNickname: '行内群昵称',
    avatarUrl: 'https://example.com/member.jpg'
  }
]

const contactRows = [
  {
    username: 'wxid-member',
    nick_name: '真实微信昵称',
    remark: '真实通讯录备注'
  }
]

function expectedMember(overrides: Partial<Record<string, string>> = {}) {
  return {
    m_nsUsrName: 'wxid-member',
    nickname: '真实微信昵称',
    groupNickname: '真实群昵称',
    wechatNickname: '真实微信昵称',
    remark: '真实通讯录备注',
    m_nsHeadImgUrl: 'https://example.com/member.jpg',
    ...overrides
  }
}

describe('WCDB group member names', () => {
  it('uses contact nick_name and remark instead of the ambiguous synchronous member nickname', () => {
    const getGroupMembers = vi.fn(() => 0)
    const executeQuery = vi.fn(() => 0)
    const callJson = vi.fn((call: (handle: number, output: [null]) => number) => {
      const queryCount = executeQuery.mock.calls.length
      call(1, [null])
      return executeQuery.mock.calls.length > queryCount ? contactRows : groupMemberRows
    })
    const client = Object.assign(Object.create(Wcdb4Client.prototype), {
      wcdbGetGroupMembers: getGroupMembers,
      wcdbExecQuery: executeQuery,
      callJson,
      getGroupNicknames: vi.fn(() => new Map([['wxid-member', '真实群昵称']])),
      avatarCache: new Map<string, string>(),
      wcdbGetAvatarUrls: null
    }) as Wcdb4Client

    expect(client.getGroupMembers('fixture@chatroom')).toEqual([expectedMember()])
    expect(executeQuery).toHaveBeenCalledWith(
      1,
      'contact',
      '',
      expect.stringContaining('SELECT username, nick_name, remark FROM contact'),
      expect.any(Array)
    )
  })

  it('uses the same independent contact fields in the asynchronous snapshot path', async () => {
    const getGroupMembers = vi.fn()
    const executeQuery = vi.fn()
    const callJsonAsync = vi.fn(async (fn: unknown) => {
      if (fn === getGroupMembers) return groupMemberRows
      if (fn === executeQuery) return contactRows
      throw new Error('unexpected native query')
    })
    const client = Object.assign(Object.create(Wcdb4Client.prototype), {
      wcdbGetGroupMembers: getGroupMembers,
      wcdbExecQuery: executeQuery,
      callJsonAsync,
      getGroupNicknamesAsync: vi.fn(async () => new Map([['wxid-member', '真实群昵称']])),
      avatarCache: new Map<string, string>(),
      wcdbGetAvatarUrls: null
    }) as Wcdb4Client

    await expect(client.getGroupMembersAsync('fixture@chatroom')).resolves.toEqual([
      expectedMember()
    ])
    expect(callJsonAsync).toHaveBeenLastCalledWith(
      executeQuery,
      'contact',
      '',
      expect.stringContaining('SELECT username, nick_name, remark FROM contact')
    )
  })

  it('falls back to the group nickname without leaking an ambiguous member nickname', () => {
    const getGroupMembers = vi.fn(() => 0)
    const executeQuery = vi.fn(() => 0)
    const callJson = vi.fn((call: (handle: number, output: [null]) => number) => {
      const queryCount = executeQuery.mock.calls.length
      call(1, [null])
      if (executeQuery.mock.calls.length > queryCount)
        throw new Error('contact database unavailable')
      return groupMemberRows
    })
    const client = Object.assign(Object.create(Wcdb4Client.prototype), {
      wcdbGetGroupMembers: getGroupMembers,
      wcdbExecQuery: executeQuery,
      callJson,
      getGroupNicknames: vi.fn(() => new Map([['wxid-member', '真实群昵称']])),
      avatarCache: new Map<string, string>(),
      wcdbGetAvatarUrls: null
    }) as Wcdb4Client

    expect(client.getGroupMembers('fixture@chatroom')).toEqual([
      expectedMember({ nickname: '真实群昵称', wechatNickname: '', remark: '' })
    ])
  })
})
