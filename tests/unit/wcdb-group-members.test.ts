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

  it('reads only member ids without hydrating names or avatars', async () => {
    const getGroupMembers = vi.fn()
    const callJsonAsync = vi.fn(async () => [
      ...groupMemberRows,
      { username: 'wxid-other' },
      { username: 'wxid-member' },
      { username: '' }
    ])
    const getGroupNicknamesAsync = vi.fn()
    const readContactMemberNamesAsync = vi.fn()
    const hydrateAvatarUrlsAsync = vi.fn()
    const client = Object.assign(Object.create(Wcdb4Client.prototype), {
      wcdbGetGroupMembers: getGroupMembers,
      callJsonAsync,
      getGroupNicknamesAsync,
      readContactMemberNamesAsync,
      hydrateAvatarUrlsAsync
    }) as Wcdb4Client

    await expect(client.getGroupMemberIdsAsync('fixture@chatroom')).resolves.toEqual([
      'wxid-member',
      'wxid-other'
    ])
    expect(callJsonAsync).toHaveBeenCalledOnce()
    expect(getGroupNicknamesAsync).not.toHaveBeenCalled()
    expect(readContactMemberNamesAsync).not.toHaveBeenCalled()
    expect(hydrateAvatarUrlsAsync).not.toHaveBeenCalled()
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

  it('uses the group nickname for message sender display before contact display names', () => {
    const client = Object.assign(Object.create(Wcdb4Client.prototype), {
      accountRoot: '/fixture/account',
      displayNameCache: new Map([['wxid-member', '通讯录昵称']]),
      getGroupNicknames: vi.fn(() => new Map([['wxid-member', '真实群昵称']])),
      avatarCache: new Map<string, string>(),
      myWxid: '',
      wxid: ''
    }) as Wcdb4Client

    const finalizeMessages = (
      client as unknown as {
        finalizeMessages: (
          username: string,
          rows: Record<string, unknown>[]
        ) => Array<{ senderNickname?: string }>
      }
    ).finalizeMessages

    expect(
      finalizeMessages.call(client, 'fixture@chatroom', [
        {
          sender_username: 'wxid-member',
          create_time: 1731327263,
          local_id: 1,
          local_type: 1,
          msg_content: 'fixture'
        }
      ])
    ).toMatchObject([{ senderNickname: '真实群昵称' }])
    expect(client.getGroupNicknames).toHaveBeenCalledWith('fixture@chatroom')
  })
})

describe('WCDB group member batch', () => {
  it('reads 200 rooms with one batch call and no legacy member call', async () => {
    const roomIds = Array.from({ length: 200 }, (_, index) => `room-${index}@chatroom`)
    const batchResult = roomIds.map((roomId, index) => ({
      roomId,
      status: 'ok',
      memberWxids: [`wxid_${index}`]
    }))
    const batchAsync = vi.fn(
      (
        _handle: number,
        _roomIdsJson: string,
        outJson: [unknown],
        callback: (error: unknown, result: number) => void
      ) => {
        outJson[0] = 'batch-json-pointer'
        callback(null, 0)
      }
    )
    const legacyAsync = vi.fn()
    const batchBinding = Object.assign(vi.fn(), { async: batchAsync })
    const legacyBinding = Object.assign(vi.fn(), { async: legacyAsync })
    const client = Object.assign(Object.create(Wcdb4Client.prototype), {
      wcdbGetGroupMembersBatch: batchBinding,
      wcdbGetGroupMembers: legacyBinding,
      handle: 42,
      closing: false,
      nativeCallsInFlight: new Set<Promise<unknown>>(),
      koffi: { decode: vi.fn(() => JSON.stringify(batchResult)) },
      wcdbFreeString: vi.fn()
    }) as Wcdb4Client

    await expect(client.getGroupMemberIdsBatchAsync(roomIds)).resolves.toEqual(batchResult)
    expect(batchAsync).toHaveBeenCalledOnce()
    expect(batchAsync).toHaveBeenCalledWith(
      42,
      JSON.stringify(roomIds),
      expect.any(Array),
      expect.any(Function)
    )
    expect(legacyAsync).not.toHaveBeenCalled()
  })

  it('trims and deduplicates room ids while preserving request order', async () => {
    const batchBinding = vi.fn()
    const requestedRoomIds = ['b@chatroom', 'a@chatroom']
    const callJsonAsync = vi.fn(async () =>
      requestedRoomIds.map((roomId) => ({ roomId, status: 'ok', memberWxids: [] }))
    )
    const client = Object.assign(Object.create(Wcdb4Client.prototype), {
      wcdbGetGroupMembersBatch: batchBinding,
      callJsonAsync
    }) as Wcdb4Client

    await expect(
      client.getGroupMemberIdsBatchAsync([
        ' b@chatroom ',
        'a@chatroom',
        'b@chatroom',
        '',
        ' a@chatroom '
      ])
    ).resolves.toEqual([
      { roomId: 'b@chatroom', status: 'ok', memberWxids: [] },
      { roomId: 'a@chatroom', status: 'ok', memberWxids: [] }
    ])
    expect(callJsonAsync).toHaveBeenCalledWith(batchBinding, JSON.stringify(requestedRoomIds))
  })

  it.each([
    ['non-array result', { roomId: 'a@chatroom' }],
    ['missing room result', [{ roomId: 'a@chatroom', status: 'ok', memberWxids: ['wxid_a'] }]],
    [
      'duplicate room result',
      [
        { roomId: 'a@chatroom', status: 'ok', memberWxids: ['wxid_a'] },
        { roomId: 'a@chatroom', status: 'ok', memberWxids: ['wxid_b'] }
      ]
    ],
    [
      'unknown status',
      [
        { roomId: 'a@chatroom', status: 'stale', memberWxids: ['wxid_a'] },
        { roomId: 'b@chatroom', status: 'ok', memberWxids: ['wxid_b'] }
      ]
    ],
    [
      'malformed member list',
      [
        { roomId: 'a@chatroom', status: 'ok', memberWxids: ['wxid_a'] },
        { roomId: 'b@chatroom', status: 'ok', memberWxids: [null] }
      ]
    ]
  ])('rejects an invalid batch: %s', async (_name, rawResult) => {
    const batchBinding = vi.fn()
    const callJsonAsync = vi.fn(async () => rawResult)
    const client = Object.assign(Object.create(Wcdb4Client.prototype), {
      wcdbGetGroupMembersBatch: batchBinding,
      callJsonAsync
    }) as Wcdb4Client

    await expect(
      client.getGroupMemberIdsBatchAsync(['a@chatroom', 'b@chatroom'])
    ).resolves.toBeNull()
  })
})
