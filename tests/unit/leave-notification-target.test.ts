import { describe, expect, it } from 'vitest'

import {
  filterSendableFriendContacts,
  isSendableFriendContact,
  leaveNotificationContactDisplayName,
  resolveLeaveNotificationTarget,
  type LeaveNotificationCandidateContact
} from '../../src/main/services/leave-notification-target'
import type { GroupMemberExitedEvent } from '../../src/shared/group-exit-event'
import { WECHAT_FILE_HELPER_USERNAME } from '../../src/shared/wechat-identities'
import type { LeaveNotificationConfig } from '../../src/shared/automation'

/**
 * 退群通知的**目标解析**。
 *
 * 这是整轮迁移里最不能出错的一处：解析错就等于发错人，而发出去的消息撤不回来。
 * 所以这里把四种目标、失效、不可发送、自身身份缺失全部穷举。
 */

const EVENT: GroupMemberExitedEvent = {
  eventId: 'room@chatroom:wxid_member:1700000000000:1',
  conversationId: 'room@chatroom',
  groupName: '产品测试群',
  groupRemark: '',
  memberId: 'wxid_member',
  memberName: '张三',
  previousCount: 243,
  currentCount: 242,
  occurredAt: 1_700_000_000_000
}

const FRIEND: LeaveNotificationCandidateContact = {
  m_nsUsrName: 'wxid_friend',
  m_nsNickName: '好友昵称',
  remark: '好友备注',
  type: 'user'
}

const contacts: LeaveNotificationCandidateContact[] = [
  FRIEND,
  { m_nsUsrName: 'room@chatroom', m_nsNickName: '测试群', type: 'group' },
  { m_nsUsrName: 'gh_official', m_nsNickName: '某公众号', type: 'user', isOfficialAccount: true },
  { m_nsUsrName: WECHAT_FILE_HELPER_USERNAME, m_nsNickName: '文件传输助手', type: 'user' },
  { m_nsUsrName: 'wxid_self', m_nsNickName: '我自己', type: 'user' }
]

/**
 * 构造一份合法配置。
 *
 * 本文件关心的是**目标解析**，通知范围（`notifyScope`）与之正交，
 * 所以在这里统一补默认值 —— 契约再新增字段时也只改这一处，
 * 不必去逐个补十几处字面量（那才是漏字段的根源）。
 */
function config(overrides: Partial<LeaveNotificationConfig> = {}): LeaveNotificationConfig {
  return {
    target: { type: 'source_chat' },
    template: '',
    notifyScope: 'all',
    notifyRoomIds: [],
    ...overrides
  }
}

function resolve(
  config: LeaveNotificationConfig,
  overrides: { selfWxid?: string; event?: GroupMemberExitedEvent } = {}
) {
  return resolveLeaveNotificationTarget({
    config,
    event: overrides.event ?? EVENT,
    contacts,
    selfWxid: overrides.selfWxid ?? 'wxid_self'
  })
}

describe('leaveNotificationTarget · 四种目标', () => {
  it('当前群聊 = 事件所在群，不是"最后活跃会话"', () => {
    const result = resolve(config())

    expect(result).toEqual({
      ok: true,
      target: {
        recipient: { type: 'group', id: 'room@chatroom', name: '产品测试群' },
        displayName: '产品测试群'
      }
    })
  })

  it('当前群聊在群名缺失时用中性称呼，不回落成 roomId', () => {
    // 事件里没带群名，但本地联系人表里有这个群 ⇒ 用会话昵称，
    // 比「当前群聊」更具体，且**仍然不是** roomId。
    const withNickname = resolveLeaveNotificationTarget({
      config: config(),
      event: { ...EVENT, groupName: undefined },
      contacts,
      selfWxid: 'wxid_self'
    })
    expect(withNickname.ok).toBe(true)
    if (withNickname.ok) {
      expect(withNickname.target.recipient.name).toBe('测试群')
      expect(withNickname.target.displayName).toBe('测试群')
    }

    // 群名与联系人表**都**拿不到 ⇒ 退到中性称呼。
    // 唯一不能发生的事是把 roomId / wxid 当显示名吐出去。
    const fallback = resolveLeaveNotificationTarget({
      config: config(),
      event: { ...EVENT, groupName: undefined },
      contacts: [],
      selfWxid: 'wxid_self'
    })
    expect(fallback.ok).toBe(true)
    if (fallback.ok) {
      expect(fallback.target.recipient.name).toBe('当前群聊')
      expect(fallback.target.displayName).toBe('发生退群事件的群聊')
      // `recipient.id` 本来就该是真实会话 id（发送要用它），
      // 这条断言约束的是**显示名**：不许把 id 当称呼给人看。
      expect(fallback.target.recipient.name).not.toContain('@chatroom')
      expect(fallback.target.displayName).not.toContain('@chatroom')
    }
  })

  it('当前群聊在缺少 conversationId 时直接失败', () => {
    const result = resolveLeaveNotificationTarget({
      config: config(),
      event: { ...EVENT, conversationId: '' },
      contacts,
      selfWxid: 'wxid_self'
    })

    expect(result.ok).toBe(false)
  })

  it('发给自己 = 当前登录账号的真实 wxid', () => {
    const result = resolve(config({ target: { type: 'self' } }), { selfWxid: 'wxid_me' })

    expect(result).toEqual({
      ok: true,
      target: {
        recipient: { type: 'contact', id: 'wxid_me', name: '我' },
        displayName: '我'
      }
    })
  })

  /*
   * 拿不到自身身份时必须**报 blocker**，绝不偷偷 fallback 到文件传输助手 ——
   * 那会让用户以为"发给自己"生效了，实际消息去了别处。
   */
  it('拿不到自身身份时失败，且不 fallback 文件传输助手', () => {
    const result = resolve(config({ target: { type: 'self' } }), { selfWxid: '' })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('当前登录的微信账号')
      expect(result.error).not.toContain('文件传输助手')
    }
  })

  it('文件传输助手用协议级固定身份，不靠昵称搜索', () => {
    const result = resolve(config({ target: { type: 'file_transfer' } }))

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.target.recipient).toEqual({
        type: 'contact',
        id: WECHAT_FILE_HELPER_USERNAME,
        name: '文件传输助手'
      })
    }
  })

  it('指定好友用稳定 id，显示名用备注', () => {
    const result = resolve(
      config({ target: { type: 'contact', contactId: 'wxid_friend' } })
    )

    expect(result).toEqual({
      ok: true,
      target: {
        recipient: { type: 'contact', id: 'wxid_friend', name: '好友备注' },
        displayName: '好友备注'
      }
    })
  })
})

describe('leaveNotificationTarget · 失效与非法', () => {
  it('联系人不在了 → 失败，且不往别处发', () => {
    const result = resolve(config({ target: { type: 'contact', contactId: 'wxid_gone' } }))

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('已不存在或当前无法发送')
  })

  it('还没选好友 → 失败并提示重新选择', () => {
    const result = resolve(config({ target: { type: 'contact' } }))

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('还没有选择通知联系人')
  })

  it('把群 / 公众号 / 文件传输助手 / 自己填进「指定好友」也会被拒', () => {
    for (const contactId of [
      'room@chatroom',
      'gh_official',
      WECHAT_FILE_HELPER_USERNAME,
      'wxid_self'
    ]) {
      const result = resolve(config({ target: { type: 'contact', contactId } }))
      expect(result.ok).toBe(false)
    }
  })

  it('未配置配置项 → 失败', () => {
    expect(resolveLeaveNotificationTarget({
      config: undefined,
      event: EVENT,
      contacts,
      selfWxid: 'wxid_self'
    }).ok).toBe(false)
  })

  it('未知目标类型 → 失败（不允许静默当成默认值）', () => {
    const result = resolve(config({ target: { type: 'webhook' as never } }))
    expect(result.ok).toBe(false)
  })
})

describe('leaveNotificationTarget · 可选好友过滤', () => {
  it('排除群 / 公众号 / 文件传输助手 / 自己', () => {
    const sendable = filterSendableFriendContacts(contacts, 'wxid_self').map(
      (contact) => contact.m_nsUsrName
    )

    expect(sendable).toEqual(['wxid_friend'])
  })

  it('UI 选择器与运行时判定共用同一个函数', () => {
    for (const contact of contacts) {
      expect(isSendableFriendContact(contact, 'wxid_self')).toBe(
        filterSendableFriendContacts([contact], 'wxid_self').length === 1
      )
    }
  })

  it('显示名依次回落到备注 → 微信昵称 → 会话昵称 → 中性称呼，永不出现 wxid', () => {
    expect(leaveNotificationContactDisplayName(FRIEND)).toBe('好友备注')
    expect(
      leaveNotificationContactDisplayName({ m_nsUsrName: 'wxid_x', type: 'user' })
    ).toBe('指定好友')
  })
})
