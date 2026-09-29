import {
  LEAVE_NOTIFICATION_TARGET_OPTIONS,
  SCHEDULED_REPORT_TARGET_OPTIONS,
  leaveNotificationTargetLabel,
  scheduledReportTargetLabel
} from '../../shared/automation'
import { WECHAT_FILE_HELPER_USERNAME, isFileHelperUsername } from '../../shared/wechat-identities'

/**
 * **中性的微信发送目标解析**。
 *
 * 退群通知与定时日报的目标语义完全一致（来源会话 / 自己 / 文件传输助手 / 指定好友），
 * 差的只是"来源会话"从哪来：
 * - 退群通知 → 事件所在群（`event.conversationId`）；
 * - 定时日报 → 该规则配置的日报来源群（`config.report.sourceConversationId`）。
 *
 * ⇒ 所以**只允许有一份实现**（只保留一套 resolve）。
 * 两个业务各自只有一层薄适配（把参数摊平后交给这里），不重复任何判定逻辑。
 *
 * 五条规则（两边共用）：
 * 1. 目标解析失败 → **报错**，绝不 fallback 到别的目标（尤其不许偷偷发文件助手 / 来源群）；
 * 2. 只允许出现在选项表里的目标类型；
 * 3. 显示名不带 wxid / roomId：日志与界面只出现用户能看懂的称呼；
 * 4. 联系人必须**可发送**（排除群聊 / 公众号 / 文件传输助手 / 自己）；
 * 5. 只有 `source_chat` 用得到来源会话，其余目标完全不看它。
 */

/** 解析所需的最小联系人结构（main 侧 `FormattedContact` 结构上可赋值给它）。 */
export interface AutomationTargetContact {
  m_nsUsrName: string
  m_nsNickName?: string
  md5?: string
  type: 'user' | 'group'
  isOfficialAccount?: boolean
  wechatNickname?: string
  remark?: string
}

/** 目标类型（两个业务共用同一组字面量）。 */
export type AutomationTargetType = 'source_chat' | 'self' | 'file_transfer' | 'contact'

export interface ResolvedAutomationTarget {
  recipient: { type: 'group' | 'contact'; id: string; name: string }
  /** 用户可读的目标名，直接进执行日志的 `detail`。 */
  displayName: string
}

export type AutomationTargetResolution =
  | { ok: true; target: ResolvedAutomationTarget }
  | { ok: false; error: string }

/** 联系人的展示名：备注 → 微信昵称 → 会话昵称 → 兜底称呼。**永不回落到 wxid**。 */
export function automationContactDisplayName(contact: AutomationTargetContact): string {
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
  contact: AutomationTargetContact,
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
export function filterSendableFriendContacts<T extends AutomationTargetContact>(
  contacts: T[],
  selfWxid?: string
): T[] {
  return contacts.filter((contact) => isSendableFriendContact(contact, selfWxid))
}

/** 目标类型是否在（该业务的）选项表里。 */
function isKnownTargetType(
  type: string,
  options: ReadonlyArray<{ type: string }>
): boolean {
  return options.some((option) => option.type === type)
}

/**
 * 把群标识解析成**稳定会话 id**（`xxx@chatroom`）。
 *
 * 兼容三种历史形态：roomId 本身 / 会话 md5 / 群名。
 * 解析不出来返回 `undefined` —— 调用方必须如实报错，**不许回落**。
 */
export function resolveGroupConversationId(
  raw: string,
  contacts: AutomationTargetContact[]
): string | undefined {
  const value = String(raw || '').trim()
  if (!value) return undefined
  if (value.endsWith('@chatroom')) return value
  const matched = contacts.find(
    (contact) =>
      (contact.type === 'group' || contact.m_nsUsrName.endsWith('@chatroom')) &&
      (contact.md5 === value ||
        contact.m_nsUsrName === value ||
        contact.m_nsNickName?.trim() === value)
  )
  const conversationId = String(matched?.m_nsUsrName || '').trim()
  return conversationId.endsWith('@chatroom') ? conversationId : undefined
}

/** 群标识 → 可读群名（解析不到时返回空串，由调用方决定兜底文案）。 */
export function resolveGroupDisplayName(
  raw: string,
  contacts: AutomationTargetContact[]
): string {
  const value = String(raw || '').trim()
  if (!value) return ''
  const matched = contacts.find(
    (contact) =>
      contact.m_nsUsrName === value ||
      contact.md5 === value ||
      contact.m_nsNickName?.trim() === value
  )
  return String(matched?.m_nsNickName || '').trim()
}

export interface ResolveAutomationTargetInput {
  targetType: AutomationTargetType
  /**
   * `source_chat` 时使用：来源会话（退群事件所在群 / 日报来源群）。
   * 允许是 roomId / 会话 md5 / 群名 —— 一律经 `resolveGroupConversationId` 收敛。
   */
  sourceConversationId?: string
  /** 来源会话的可读名（拿不到时留空，由这里给兜底称呼）。 */
  sourceDisplayName?: string
  /** `contact` 时使用：稳定 id（wxid / username）。 */
  contactId?: string
  contacts: AutomationTargetContact[]
  /** 当前登录账号的 wxid；拿不到时传空串。 */
  selfWxid?: string
}

/**
 * 目标解析的**文案与类型表**（按业务注入）。
 *
 * 为什么把文案参数化而不是各写一份 switch：两个业务的**判定逻辑必须一模一样**，
 * 只有"主语"不同。文案集中放在这里，判定仍然只有一份。
 */
export interface AutomationTargetMessages {
  /** 目标类型表的单一来源（与 UI 选项同源）。 */
  options: ReadonlyArray<{ type: string }>
  /** 类型非法（伪造值 / 未知值）。 */
  invalidTarget: string
  /** `source_chat` 但来源会话拿不到。 */
  sourceMissing: string
  /** `source_chat` 且来源会话没有可读名时，`recipient.name` 的兜底。 */
  sourceRecipientName: string
  /** `source_chat` 且来源会话没有可读名时，`displayName` 的兜底。 */
  sourceDisplayName: string
  /** `self` 但拿不到自身身份。 */
  selfMissing: string
  /** `contact` 但没选联系人。 */
  contactNotChosen: string
  /** `contact` 但联系人失效 / 不可发送。 */
  contactUnavailable: string
}

/**
 * 中性目标解析。**唯一的实现**。
 */
export function resolveAutomationTarget(
  input: ResolveAutomationTargetInput,
  messages: AutomationTargetMessages
): AutomationTargetResolution {
  const type = input.targetType
  if (!type || !isKnownTargetType(type, messages.options)) {
    return { ok: false, error: messages.invalidTarget }
  }

  switch (type) {
    case 'source_chat': {
      const conversationId = resolveGroupConversationId(
        String(input.sourceConversationId || ''),
        input.contacts
      )
      if (!conversationId) return { ok: false, error: messages.sourceMissing }
      const explicitName = String(input.sourceDisplayName || '').trim()
      const resolvedName = resolveGroupDisplayName(conversationId, input.contacts)
      const name = explicitName || resolvedName || messages.sourceRecipientName
      const displayName = explicitName || resolvedName || messages.sourceDisplayName
      return {
        ok: true,
        target: {
          recipient: { type: 'group', id: conversationId, name },
          displayName
        }
      }
    }

    case 'self': {
      const selfWxid = String(input.selfWxid || '').trim()
      // 明确报错，不 fallback。
      if (!selfWxid) return { ok: false, error: messages.selfMissing }
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
            name: '文件传输助手'
          },
          displayName: '文件传输助手'
        }
      }

    case 'contact': {
      const contactId = String(input.contactId || '').trim()
      if (!contactId) return { ok: false, error: messages.contactNotChosen }
      const contact = input.contacts.find(
        (item) => String(item.m_nsUsrName || '').trim() === contactId
      )
      if (!contact || !isSendableFriendContact(contact, input.selfWxid)) {
        // 之前选择的联系人被删除 / 不可发送 / 找不到时，规则不偷偷改发别处。
        return { ok: false, error: messages.contactUnavailable }
      }
      const displayName = automationContactDisplayName(contact)
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

/** 退群通知的已知目标类型表（与文案同源）。 */
export const LEAVE_NOTIFICATION_TARGET_TYPES = LEAVE_NOTIFICATION_TARGET_OPTIONS

/** 定时日报的已知目标类型表（与文案同源）。 */
export const SCHEDULED_REPORT_TARGET_TYPES = SCHEDULED_REPORT_TARGET_OPTIONS

export { leaveNotificationTargetLabel, scheduledReportTargetLabel }
