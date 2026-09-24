import { describe, expect, it } from 'vitest'
import { normalizeRoomInfoRow } from '../../src/main/wcdb4-client'

describe('normalizeRoomInfoRow', () => {
  it('maps versioned chatroom column aliases', () => {
    expect(
      normalizeRoomInfoRow('123@chatroom', {
        chatroomname: '123@chatroom',
        roomowner: 'wxid_owner',
        textannouncement: '群公告',
        announcement_editor_: 'wxid_editor',
        max_member_count: 500,
        chatroomnick: '测试群',
        openim_acct_type: '2'
      })
    ).toEqual({
      roomId: '123@chatroom',
      owner: 'wxid_owner',
      announcement: '群公告',
      announcementEditor: 'wxid_editor',
      maxMemberCount: 500,
      chatName: '测试群',
      openImAccountType: '2',
      isOpenIm: true
    })
    expect(normalizeRoomInfoRow('9@chatroom', { room_owner: 'wxid_b' })).toMatchObject({
      owner: 'wxid_b',
      isOpenIm: undefined
    })
  })
})
