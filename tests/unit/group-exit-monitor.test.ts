import { describe, expect, it } from 'vitest'
import {
  GROUP_EXIT_NOTIFICATION_TEMPLATE,
  findRemovedGroupMembers,
  groupExitMemberName,
  insertGroupNamePlaceholder,
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
    // 群名是**独立变量**，且默认模板第一行就是它 —— 通知发给别人时才认得出是哪个群。
    expect(message).toContain('群聊: 测试群')
    expect(message).toContain('用户: 微信名')
    expect(message).toContain('群备注: 未设置')
    expect(message).toContain('微信号: wxid_fixture')
    expect(message).toContain('人数: 240 -> 239')
    expect(message).toContain('退群时间: 2026-08-31 00:19:07')
  })

  /*
   * 回归：`{groupName}`（群名）与 `{groupRemark}`（成员在本群的昵称）是两个不同的东西。
   *
   * 起因是预览样本曾把群名填进 `groupRemark`，导致「群备注」看起来就是群名，
   * 于是没人发现模板里**根本没有群名变量** —— 通知发给好友时收件人不知道是哪个群。
   * 这条用例把两者钉死成不同的值。
   */
  it('keeps the group name and the member group nickname as two separate variables', () => {
    const message = renderGroupExitMonitorNotification(
      {
        id: 'event-3',
        contactId: 'group-md5',
        roomId: '测试群@chatroom',
        groupName: '产品测试群',
        memberWxid: 'wxid_fixture',
        memberName: '群昵称',
        wechatName: '微信名',
        groupRemark: '小张',
        previousCount: 3,
        currentCount: 2,
        delta: -1,
        message: '小张退出了产品测试群',
        detectedAt: new Date(2026, 7, 31, 0, 19, 7).getTime()
      },
      '{groupName} / {groupRemark}'
    )

    expect(message).toBe('产品测试群 / 小张')
    expect(message).not.toContain('{')
  })

  it('falls back to 未读取到 when the group name is unavailable', () => {
    const message = renderGroupExitMonitorNotification(
      {
        id: 'event-4',
        contactId: 'group-md5',
        roomId: '测试群@chatroom',
        groupName: '',
        memberWxid: 'wxid_fixture',
        memberName: '群昵称',
        groupRemark: '',
        previousCount: 2,
        currentCount: 1,
        delta: -1,
        message: '群昵称退出了测试群',
        detectedAt: new Date(2026, 7, 31, 0, 19, 7).getTime()
      },
      '群聊: {groupName}'
    )

    expect(message).toBe('群聊: 未读取到')
  })

  it('validates custom notification templates and rejects unknown placeholders', () => {
    expect(validateGroupExitNotificationTemplate(' 用户: {user} ')).toEqual({
      valid: true,
      template: '用户: {user}'
    })
    // 新增的群名变量必须被校验通过，否则用户存不下来。
    expect(validateGroupExitNotificationTemplate('群聊: {groupName}')).toEqual({
      valid: true,
      template: '群聊: {groupName}'
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
      '{groupName}|{user}|{groupRemark}|{wxid}|{previousCount}|{currentCount}|{time}'
    )
    expect(message).toBe('测试群|微信名|群内昵称|wxid_fixture|2|1|2026-08-31 00:19:07')
  })
})

describe('把群聊名补进已有模板', () => {
  /** 加上群名变量之前的默认模板（有「人数」行、没有「群聊」行）。 */
  const previousDefault = [
    '[退群监测]',
    '',
    '用户: {user}',
    '',
    '群备注: {groupRemark}',
    '',
    '微信号: {wxid}',
    '',
    '人数: {previousCount} -> {currentCount}',
    '',
    '退群时间: {time}'
  ].join('\n')

  it('插在标题行之后，其余内容一字不动', () => {
    const result = insertGroupNamePlaceholder(previousDefault)

    expect(result).toBe(
      [
        '[退群监测]',
        '',
        '群聊: {groupName}',
        '',
        '用户: {user}',
        '',
        '群备注: {groupRemark}',
        '',
        '微信号: {wxid}',
        '',
        '人数: {previousCount} -> {currentCount}',
        '',
        '退群时间: {time}'
      ].join('\n')
    )
    // 用户原有内容全部保留。
    for (const line of previousDefault.split('\n')) {
      if (line.trim()) expect(result).toContain(line)
    }
  })

  it('补完就是当前的默认模板形状', () => {
    expect(insertGroupNamePlaceholder(previousDefault)).toBe(GROUP_EXIT_NOTIFICATION_TEMPLATE)
  })

  it('已经含 {groupName} 时原样返回（幂等）', () => {
    const template = '[退群监测]\n\n群聊: {groupName}\n\n用户: {user}'
    expect(insertGroupNamePlaceholder(template)).toBe(template)
    // 连续补两次结果不变。
    expect(insertGroupNamePlaceholder(insertGroupNamePlaceholder(previousDefault))).toBe(
      insertGroupNamePlaceholder(previousDefault)
    )
  })

  it('没有标题行时插到最前面', () => {
    expect(insertGroupNamePlaceholder('用户: {user}')).toBe('群聊: {groupName}\n\n用户: {user}')
  })

  it('空模板原样返回，不硬造内容', () => {
    expect(insertGroupNamePlaceholder('')).toBe('')
    expect(insertGroupNamePlaceholder('   ')).toBe('   ')
  })

  it('不会留下连续空行', () => {
    expect(insertGroupNamePlaceholder('[退群监测]\n\n\n\n用户: {user}')).not.toMatch(/\n{3,}/)
  })
})
