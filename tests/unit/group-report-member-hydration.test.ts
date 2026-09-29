import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))

import { hydrateGroupMemberIdentity } from '../../src/main/services/agent-group-report-service'
import type { Message } from '../../src/shared/types'

/**
 * 「Agent Hub 日报头像退化成首字」的回归。
 *
 * 旧实现用 `isInternalName(message.name)` 做整体早退，而 `listMessages` 产出的 `name`
 * 在真实群里通常是**已可读的昵称** → 整条记录被跳过 → `member.avatar` 永远补不上。
 * 这里锁死修正后的语义：头像只看 senderId 能不能命中真实群成员，与 name 是否可读无关。
 */

const AVATAR_ZHANG = 'http://wx.qlogo.cn/mmhead/zhang/0'
const AVATAR_LI = 'http://wx.qlogo.cn/mmhead/li/0'

const members = [
  {
    wxid: 'wxid_zhangsan',
    nickname: '张三',
    groupNickname: '张三（技术）',
    wechatNickname: '张三',
    remark: '',
    avatar: AVATAR_ZHANG
  },
  {
    wxid: 'wxid_lisi',
    nickname: '李四',
    groupNickname: '李四',
    wechatNickname: '李四',
    remark: '',
    avatar: AVATAR_LI
  },
  {
    wxid: 'wxid_noavatar',
    nickname: '王五',
    groupNickname: '王五',
    wechatNickname: '王五',
    remark: '',
    avatar: ''
  }
]

const message = (patch: Partial<Message>): Message =>
  ({
    id: 'local-1',
    from: 'user',
    type: '普通文本',
    datetime: '2026-09-17 10:00:00',
    content: '正文',
    isSender: false,
    name: '',
    createTime: 1_787_000_000,
    ...patch
  }) as Message

describe('hydrateGroupMemberIdentity — Agent Hub 日报成员注入', () => {
  it('message.name 已是正常中文昵称时，仍然补上 member.avatar', () => {
    const [result] = hydrateGroupMemberIdentity(
      [message({ senderId: 'wxid_zhangsan', name: '张三', img: '' })],
      members,
      'groupNickname'
    )
    // 这正是旧实现漏掉的那一条：name 可读 → 早退 → img 一直为空 → 导出层退化成首字头像
    expect(result.img).toBe(AVATAR_ZHANG)
  })

  it('message.name 仍是内部标识时，同时补显示名与头像', () => {
    const [result] = hydrateGroupMemberIdentity(
      [message({ senderId: 'wxid_lisi', name: 'wxid_lisi', img: '' })],
      members,
      'groupNickname'
    )
    expect(result.name).toBe('李四')
    expect(result.img).toBe(AVATAR_LI)
  })

  it('显示名按 memberNameMode 解析，且只采用可读名（不降级成 wxid / 空串）', () => {
    const [groupNickname] = hydrateGroupMemberIdentity(
      [message({ senderId: 'wxid_zhangsan', name: '张三', img: '' })],
      members,
      'groupNickname'
    )
    expect(groupNickname.name).toBe('张三（技术）')

    const [wechatNickname] = hydrateGroupMemberIdentity(
      [message({ senderId: 'wxid_zhangsan', name: '张三', img: '' })],
      members,
      'wechatNickname'
    )
    expect(wechatNickname.name).toBe('张三')

    // 快照只有 wxid 时解析结果是内部标识 → 保留原名，不写空、不退回 wxid
    const [keepOriginal] = hydrateGroupMemberIdentity(
      [message({ senderId: 'wxid_bare', name: '原始昵称', img: '' })],
      [
        {
          wxid: 'wxid_bare',
          nickname: '',
          groupNickname: '',
          wechatNickname: '',
          remark: '',
          avatar: AVATAR_LI
        }
      ],
      'groupNickname'
    )
    expect(keepOriginal.name).toBe('原始昵称')
    expect(keepOriginal.img).toBe(AVATAR_LI)
  })

  it('消息自带有效 img 时保持优先，不被快照覆盖', () => {
    const [result] = hydrateGroupMemberIdentity(
      [message({ senderId: 'wxid_zhangsan', name: '张三', img: 'http://keep/me.jpg' })],
      members,
      'groupNickname'
    )
    expect(result.img).toBe('http://keep/me.jpg')
  })

  it('快照没有头像时不写入空 img', () => {
    const [result] = hydrateGroupMemberIdentity(
      [message({ senderId: 'wxid_noavatar', name: '王五', img: '' })],
      members,
      'groupNickname'
    )
    expect(result.img).toBe('')
    expect(result.name).toBe('王五')
  })

  it('senderId 未命中群成员时整条消息原样返回', () => {
    const original = message({ senderId: 'wxid_unknown', name: '陌生人', img: '' })
    const [result] = hydrateGroupMemberIdentity([original], members, 'groupNickname')
    expect(result).toBe(original)
  })
})
