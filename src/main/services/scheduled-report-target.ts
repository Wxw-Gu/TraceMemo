import {
  SCHEDULED_REPORT_TARGET_OPTIONS,
  scheduledReportTargetLabel,
  type ScheduledReportAutomationConfig
} from '../../shared/automation'
import {
  resolveAutomationTarget,
  resolveGroupConversationId,
  resolveGroupDisplayName,
  type AutomationTargetContact,
  type AutomationTargetResolution
} from './automation-wechat-target'

/**
 * 定时日报的**目标解析**（薄适配层）。
 *
 * 判定逻辑在 `automation-wechat-target.ts`，与退群通知**共用同一份**。
 * 差异只有一处：来源会话不是"事件所在群"，而是**这条规则配置的日报来源群**。
 */

/** 定时日报的目标文案（唯一一份）。 */
export const SCHEDULED_REPORT_TARGET_MESSAGES = {
  options: SCHEDULED_REPORT_TARGET_OPTIONS,
  invalidTarget: '定时日报的发送目标无效，请重新选择',
  sourceMissing: '无法确定日报来源群，本次日报未发送',
  sourceRecipientName: '日报来源群',
  sourceDisplayName: '日报来源群',
  selfMissing: '无法确定当前登录的微信账号，本次日报未发送',
  contactNotChosen: '还没有选择发送联系人，请重新选择',
  contactUnavailable: '发送联系人已不存在或当前无法发送，请重新选择'
} as const

export function resolveScheduledReportTarget(input: {
  config: ScheduledReportAutomationConfig | undefined
  contacts: AutomationTargetContact[]
  /** 当前登录账号的 wxid；拿不到时传空串。 */
  selfWxid?: string
}): AutomationTargetResolution {
  const config = input.config
  if (!config) return { ok: false, error: '定时日报尚未配置发送目标' }
  const sourceConversationId = String(config.report?.sourceConversationId || '').trim()
  return resolveAutomationTarget(
    {
      targetType: config.target?.type as never,
      sourceConversationId,
      // 来源群的可读名从通讯录解析；解析不到时由中性层给兜底称呼。
      sourceDisplayName: resolveGroupDisplayName(sourceConversationId, input.contacts),
      ...(config.target?.contactId ? { contactId: config.target.contactId } : {}),
      contacts: input.contacts,
      ...(input.selfWxid ? { selfWxid: input.selfWxid } : {})
    },
    SCHEDULED_REPORT_TARGET_MESSAGES
  )
}

/**
 * 日报来源群的可读显示名（执行日志的 `sourceDisplayName` 用它）。
 *
 * **绝不回落到裸 id**：解析不到就说「日报来源群」。
 */
export function scheduledReportSourceDisplayName(
  config: ScheduledReportAutomationConfig | undefined,
  contacts: AutomationTargetContact[]
): string {
  const raw = String(config?.report?.sourceConversationId || '').trim()
  if (!raw) return '日报来源群'
  return resolveGroupDisplayName(raw, contacts) || '日报来源群'
}

/** 日报来源群解析成稳定会话 id（执行前预检用；解析不到返回 undefined）。 */
export function scheduledReportSourceConversationId(
  config: ScheduledReportAutomationConfig | undefined,
  contacts: AutomationTargetContact[]
): string | undefined {
  return resolveGroupConversationId(
    String(config?.report?.sourceConversationId || ''),
    contacts
  )
}

export { scheduledReportTargetLabel }
