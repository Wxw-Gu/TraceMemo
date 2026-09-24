import {
  LEAVE_NOTIFICATION_TARGET_OPTIONS,
  leaveNotificationTargetLabel,
  type LeaveNotificationConfig
} from '../../shared/automation'
import type { GroupMemberExitedEvent } from '../../shared/group-exit-event'
import { WECHAT_FILE_HELPER_USERNAME, isFileHelperUsername } from '../../shared/wechat-identities'

/**
 * 退群通知的**目标解析**。
 *
 * 纯函数（联系人清单与自身身份由调用方注入），因为这里最容易出错、
 * 也最需要被单测穷举：发错人是不可撤销的。
 *
 * 四条规则：
 * 1. `source_chat` 取**事件所在群**（`event.conversationId`），
 *    不是"当前正在看的聊天"，也不是"最后一个活跃会话"。
 * 2. 目标解析失败 → **报错**，绝不 fallback 到别的目标（尤其不许偷偷发文件助手）。
 * 3. 只允许出现在选项表里的目标类型。
 * 4. 显示名不带 wxid：日志与界面只出现用户能看懂的称呼。
 */

/** 解析所需的最小联系人结构（`FormattedContact` 结构上可赋值给它）。 */
export interface LeaveNotificationCandidateContact {
  m_nsUsrName: string
  m_nsNickName?: string
  type: 'user' | 'group'
  isOfficialAccount?: boolean
  wechatNickname?: string
  remark?: string
}

export interface ResolvedLeaveNotificationTarget {
  recipient: { type: 'group' | 'contact'; id: string; name: string }
  /** 用户可读的目标名，直接进执行日志的 `detail`。 */
  displayName: string
}

export type LeaveNotificationTargetResolution =
  | { ok: true; target: ResolvedLeaveNotificationTarget }
  | { ok: false; error: string }

/** 联系人显示名：备注 → 微信昵称 → 会话昵称 → 兜底称呼。**永不回落到 wxid**。 */
export function leaveNotificationContactDisplayName(
  contact: LeaveNotificationCandidateContact
): string {
  return (
    contact.remark?.trim() ||
    contact.wechatNickname?.trim() ||
    contact.m_nsNickName?.trim() ||
    '指定好友'
  )
}

/**
 * 这个联系人能不能作为「指定好友」的发送目标。
 *
 * 排除：群聊、公众号（`gh_`）、文件传输助手、自己。
 * UI 的联系人选择器与运行时的目标解析**共用这一条判定**，
 * 否则会出现"能选但发不出去"。
 */
export function isSendableFriendContact(
  contact: LeaveNotificationCandidateContact,
  selfWxid?: string
): boolean {
  if (contact.type !== 'user') return false
  if (contact.isOfficialAccount) return false
  const username = String(contact.m_nsUsrName || '').trim()
  if (!username) return false
  if (isFileHelperUsername(username)) return false
  const self = String(selfWxid || '').trim()
  if (self && username === self) return false
  return true
}

/** 供 UI 用的「可选好友」过滤（与运行时同一套判定）。 */
export function filterSendableFriendContacts<T extends LeaveNotificationCandidateContact>(
  contacts: T[],
  selfWxid?: string
): T[] {
  return contacts.filter((contact) => isSendableFriendContact(contact, selfWxid))
}

export function resolveLeaveNotificationTarget(input: {
  config: LeaveNotificationConfig | undefined
  event: GroupMemberExitedEvent
  contacts: LeaveNotificationCandidateContact[]
  /** 当前登录账号的 wxid；拿不到时传空串。 */
  selfWxid?: string
}): LeaveNotificationTargetResolution {
  const config = input.config
  if (!config) {
    return { ok: false, error: '退群通知尚未配置发送目标' }
  }
  const known = LEAVE_NOTIFICATION_TARGET_OPTIONS.some(
    (option) => option.type === config.target?.type
  )
  if (!known) {
    return { ok: false, error: '退群通知的发送目标无效，请重新选择' }
  }

  switch (config.target.type) {
    case 'source_chat': {
      const conversationId = String(input.event.conversationId || '').trim()
      if (!conversationId) {
        return { ok: false, error: '无法确定发生退群的群聊，本次通知未发送' }
      }
      const groupName = String(input.event.groupName || '').trim()
      return {
        ok: true,
        target: {
          recipient: {
            type: 'group',
            id: conversationId,
            name: groupName || '当前群聊'
          },
          displayName: groupName || '发生退群事件的群聊'
        }
      }
    }

    case 'self': {
      const selfWxid = String(input.selfWxid || '').trim()
      if (!selfWxid) {
        // 明确报错，不 fallback。§「不要偷偷 fallback 文件传输助手」。
        return { ok: false, error: '无法确定当前登录的微信账号，本次通知未发送' }
      }
      return {
        ok: true,
        target: {
          recipient: { type: 'contact', id: selfWxid, name: '我' },
          displayName: '我'
        }
      }
    }

    case 'file_transfer':
      return {
        ok: true,
        target: {
          recipient: {
            type: 'contact',
            id: WECHAT_FILE_HELPER_USERNAME,
            name: leaveNotificationTargetLabel('file_transfer')
          },
          displayName: leaveNotificationTargetLabel('file_transfer')
        }
      }

    case 'contact': {
      const contactId = String(config.target.contactId || '').trim()
      if (!contactId) {
        return { ok: false, error: '还没有选择通知联系人，请重新选择' }
      }
      const contact = input.contacts.find(
        (item) => String(item.m_nsUsrName || '').trim() === contactId
      )
      if (!contact || !isSendableFriendContact(contact, input.selfWxid)) {
        // §「如果之前选择的联系人被删除 / 不可发送 / 找不到，规则不要偷偷发给其它地方」。
        return { ok: false, error: '通知联系人已不存在或当前无法发送，请重新选择' }
      }
      const displayName = leaveNotificationContactDisplayName(contact)
      return {
        ok: true,
        target: {
          recipient: { type: 'contact', id: contactId, name: displayName },
          displayName
        }
      }
    }
  }
}
