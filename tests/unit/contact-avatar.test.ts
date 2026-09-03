import { describe, expect, it } from 'vitest'
import type { Contact } from '../../src/shared/types'
import { selectContactAvatarRefreshUsernames } from '../../src/renderer/src/utils/contact-avatar'

const contact = (username: string, avatar?: string): Contact => ({
  m_nsUsrName: username,
  m_nsNickName: username,
  md5: username,
  type: username.endsWith('@chatroom') ? 'group' : 'user',
  avatar
})

describe('selectContactAvatarRefreshUsernames', () => {
  it('refreshes valid contacts even when they already have a cached avatar', () => {
    expect(
      selectContactAvatarRefreshUsernames([
        contact('wxid_with_stale_avatar', 'https://old.example/avatar.jpg'),
        contact('wxid_without_avatar'),
        contact('room@chatroom', 'https://old.example/group.jpg')
      ])
    ).toEqual(['wxid_with_stale_avatar', 'wxid_without_avatar', 'room@chatroom'])
  })

  it('deduplicates usernames and skips synthetic contacts', () => {
    expect(
      selectContactAvatarRefreshUsernames([
        contact('wxid_same'),
        contact('wxid_same'),
        contact('Group_fixture'),
        contact('Unknown_fixture')
      ])
    ).toEqual(['wxid_same'])
  })
})
