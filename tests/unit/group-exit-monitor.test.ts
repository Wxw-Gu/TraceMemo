import { describe, expect, it } from 'vitest'
import {
  findRemovedGroupMembers,
  groupExitMemberName,
  normalizeGroupExitNotificationTemplate,
  renderGroupExitMonitorNotification,
  validateGroupExitNotificationTemplate
} from '../../src/shared/group-exit-monitor'

describe('group exit monitor member diff', () => {
  it('compares wxid sets and keeps the removed member metadata', () => {
    const removed = findRemovedGroupMembers(
      [
        { wxid: 'wxid_alice', groupNickname: '小艾' },
        { wxid: 'wxid_bob', nickname: '小博' },
        { wxid: 'wxid_bob', nickname: '重复行' }
      ],
      [{ wxid: 'wxid_alice', groupNickname: '小艾' }]
    )

    expect(removed).toEqual([{ wxid: 'wxid_bob', nickname: '小博' }])
  })

  it('uses group nickname before contact fallbacks', () => {
    expect(
      groupExitMemberName({
        wxid: 'wxid_fixture',
        nickname: '微信昵称',
        wechatNickname: '微信昵称字段',
        remark: '备注名',
        groupNickname: '群昵称'
      })
    ).toBe('群昵称')
    expect(groupExitMemberName({ wxid: 'wxid_fixture' })).toBe('wxid_fixture')
  })

  it('uses the WeChat nickname when a group nickname is unavailable', () => {
    expect(
      groupExitMemberName({
        wxid: 'wxid_fixture',
        wechatNickname: '微信名',
        remark: '通讯录备注'
      })
    ).toBe('微信名')
  })

  it('renders the notification template with a fallback for a missing group remark', () => {
    const message = renderGroupExitMonitorNotification({
      id: 'event-1',
      contactId: 'group-md5',
      roomId: '测试群@chatroom',
      groupName: '测试群',
      memberWxid: 'wxid_fixture',
      memberName: '群昵称',
      wechatName: '微信名',
      groupRemark: '',
      previousCount: 240,
      currentCount: 239,
      delta: -1,
      message: '群昵称退出了测试群',
      detectedAt: new Date(2026, 7, 31, 0, 19, 7).getTime()
    })

    expect(message).toContain('[退群监测]')
    expect(message).toContain('用户: 微信名')
    expect(message).toContain('群备注: 未设置')
    expect(message).toContain('微信号: wxid_fixture')
    expect(message).toContain('退群时间: 2026-08-31 00:19:07')
  })

  it('validates custom notification templates and rejects unknown placeholders', () => {
    expect(validateGroupExitNotificationTemplate(' 用户: {user} ')).toEqual({
      valid: true,
      template: '用户: {user}'
    })
    expect(validateGroupExitNotificationTemplate('用户: {unknown}')).toEqual({
      valid: false,
      error: '不支持的占位符: unknown'
    })
    expect(normalizeGroupExitNotificationTemplate('')).toContain('[退群监测]')
  })

  it('renders a saved custom template with all supported fields', () => {
    const message = renderGroupExitMonitorNotification(
      {
        id: 'event-2',
        contactId: 'group-md5',
        roomId: '测试群@chatroom',
        groupName: '测试群',
        memberWxid: 'wxid_fixture',
        memberName: '群昵称',
        wechatName: '微信名',
        groupRemark: '群内昵称',
        previousCount: 2,
        currentCount: 1,
        delta: -1,
        message: '群昵称退出了测试群',
        detectedAt: new Date(2026, 7, 31, 0, 19, 7).getTime()
      },
      '{user}|{groupRemark}|{wxid}|{time}'
    )
    expect(message).toBe('微信名|群内昵称|wxid_fixture|2026-08-31 00:19:07')
  })
})
