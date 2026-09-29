import {
  LEAVE_NOTIFICATION_TARGET_OPTIONS,
  leaveNotificationTargetLabel,
  type LeaveNotificationConfig
} from '../../shared/automation'
import type { GroupMemberExitedEvent } from '../../shared/group-exit-event'
import {
  automationContactDisplayName,
  filterSendableFriendContacts as filterSendable,
  isSendableFriendContact as isSendable,
  resolveAutomationTarget,
  type AutomationTargetContact,
  type AutomationTargetResolution,
  type ResolvedAutomationTarget
} from './automation-wechat-target'

/**
 * 退群通知的**目标解析**（薄适配层）。
 *
 * 真正的判定在 `automation-wechat-target.ts` —— 那里才是**唯一实现**，
 * 定时日报与退群通知共用它。这里只有两件事：
 * 1. 把 `LeaveNotificationConfig` + 退群事件摊平成中性输入；
 * 2. 提供退群通知专属文案，保持既有调用方 / 测试不变。
 *
 * ⚠️ 这里**不允许**再出现一份 switch / 判定逻辑 —— 两套并存迟早分叉。
 */

/** 解析所需的最小联系人结构（`FormattedContact` 结构上可赋值给它）。 */
export type LeaveNotificationCandidateContact = AutomationTargetContact

export type ResolvedLeaveNotificationTarget = ResolvedAutomationTarget

export type LeaveNotificationTargetResolution = AutomationTargetResolution

/** 退群通知的目标文案（唯一一份）。 */
export const LEAVE_NOTIFICATION_TARGET_MESSAGES = {
  options: LEAVE_NOTIFICATION_TARGET_OPTIONS,
  invalidTarget: '退群通知的发送目标无效，请重新选择',
  sourceMissing: '无法确定发生退群的群聊，本次通知未发送',
  sourceRecipientName: '当前群聊',
  sourceDisplayName: '发生退群事件的群聊',
  selfMissing: '无法确定当前登录的微信账号，本次通知未发送',
  contactNotChosen: '还没有选择通知联系人，请重新选择',
  contactUnavailable: '通知联系人已不存在或当前无法发送，请重新选择'
} as const

/** 联系人显示名：备注 → 微信昵称 → 会话昵称 → 兜底称呼。**永不回落到 wxid**。 */
export function leaveNotificationContactDisplayName(contact: AutomationTargetContact): string {
  return automationContactDisplayName(contact)
}

/** 这个联系人能不能作为「指定好友」的发送目标（与定时日报共用同一条判定）。 */
export function isSendableFriendContact(
  contact: AutomationTargetContact,
  selfWxid?: string
): boolean {
  return isSendable(contact, selfWxid)
}

/** 供 UI 用的「可选好友」过滤（与运行时同一套判定）。 */
export function filterSendableFriendContacts<T extends AutomationTargetContact>(
  contacts: T[],
  selfWxid?: string
): T[] {
  return filterSendable(contacts, selfWxid)
}

export function resolveLeaveNotificationTarget(input: {
  config: LeaveNotificationConfig | undefined
  event: GroupMemberExitedEvent
  contacts: LeaveNotificationCandidateContact[]
  /** 当前登录账号的 wxid；拿不到时传空串。 */
  selfWxid?: string
}): LeaveNotificationTargetResolution {
  const config = input.config
  if (!config) return { ok: false, error: '退群通知尚未配置发送目标' }
  return resolveAutomationTarget(
    {
      targetType: config.target?.type as never,
      sourceConversationId: String(input.event.conversationId || '').trim(),
      sourceDisplayName: String(input.event.groupName || '').trim(),
      ...(config.target?.contactId ? { contactId: config.target.contactId } : {}),
      contacts: input.contacts,
      ...(input.selfWxid ? { selfWxid: input.selfWxid } : {})
    },
    LEAVE_NOTIFICATION_TARGET_MESSAGES
  )
}

/** 目标类型 → 界面短标签（保持既有导出面）。 */
export { leaveNotificationTargetLabel }
