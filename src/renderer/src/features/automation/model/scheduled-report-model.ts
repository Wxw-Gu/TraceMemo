import {
  DEFAULT_REPORT_TEMPLATE,
  REPORT_TEMPLATES,
  getReportTemplate,
  type SelectableReportTemplateId
} from '../../../../../shared/report-templates'
import type {
  ScheduledReportMemberNameMode,
  ScheduledReportMessageType,
  ScheduledReportRange
} from '../../../../../shared/scheduled-report'
import {
  DEFAULT_REPORT_IMAGE_POSTFIX_TEXT
} from '../../../../../shared/personal-wechat'
import {
  AUTOMATION_REPLY_DELAY_DEFAULT_SECONDS,
  SCHEDULED_REPORT_DEFAULT_MEMBER_NAME_MODE,
  SCHEDULED_REPORT_DEFAULT_RANGE,
  SCHEDULED_REPORT_DEFAULT_TEMPLATE_ID,
  SCHEDULED_REPORT_DEFAULT_TIMEOUT_SECONDS,
  SCHEDULED_REPORT_DEFAULT_TARGET_TYPE,
  SCHEDULED_REPORT_MEMBER_NAME_OPTIONS,
  SCHEDULED_REPORT_POSTFIX_MAX_LENGTH,
  SCHEDULED_REPORT_RANGE_LABELS,
  SCHEDULED_REPORT_TARGET_OPTIONS,
  normalizeScheduledReportConfig,
  scheduledReportTargetLabel,
  type AutomationRule,
  type AutomationRuleDraft,
  type ScheduledReportAutomationConfig,
  type ScheduledReportTargetType
} from '../../../../../shared/automation'
import { type SummaryMessageType } from '../../../utils/group-report'

/**
 * 定时日报编辑器的**真实模型**（唯一一份）。
 *
 * 与迁移前的 `scheduled-report-preview.ts` 的根本区别：
 * 那时这一层只读旧 `ScheduledReportTask`、保存不落盘；现在
 * `scheduled_report` 已经是真实的 `AutomationRuleType`，
 * 编辑器产出的草稿会经 `automation:*` IPC **真写入** `AutomationRuleStore`。
 *
 * 所以这里只剩两类东西：
 * 1. 草稿 ↔ `ScheduledReportAutomationConfig` 的双向映射；
 * 2. 纯展示格式化函数（时间 / 范围 / 模板名）。
 *
 * **不再有** `loadScheduledReportTasks()` 这类"只读预览数据层"。
 */

/**
 * 编辑器草稿。
 *
 * 字段与 `ScheduledReportAutomationConfig` 一一对应（外加 `name` / `enabled`），
 * 唯一多出来的是 `targetContactId`：真实模型里它是 `target.contactId`，
 * 摊平只是为了表单好用。
 */
export interface ScheduledReportDraft {
  name: string
  enabled: boolean
  /** 每天的执行时间 `HH:mm`。 */
  scheduleTime: string
  /** 日报来源群：生成**哪个群**的日报（稳定会话 id）。 */
  group: string
  reportRange: ScheduledReportRange
  messageTypes: SummaryMessageType[]
  memberNameMode: ScheduledReportMemberNameMode
  timeoutSeconds: number
  templateId: SelectableReportTemplateId
  targetType: ScheduledReportTargetType
  targetContactId: string
  /**
   * 日报图片发送成功后补发的那句话（「后置词」）。
   *
   * 与手动发送日报图片里的后置词同一件事，但这里**按规则存**。
   * 空字符串 = 只发图片。
   */
  postfixText: string
}

/**
 * 新建规则时「纳入的消息类型」的默认值：**只勾选「文本」**。
 *
 * 以前这里是全选（对齐迁移前的旧「定时日报」页面）。改成只选文本是刻意的产品口径：
 * 日报默认只吃文本，想要图片 / 语音等再手动勾 —— 与日报页（今日日报）的默认值保持一致。
 *
 * 存量规则**不受影响**：`createDraftFromRule` 读的是规则自己存的 `messageTypes`，
 * 只有「新建」才会用到这个默认值。
 */
export const SCHEDULED_REPORT_DEFAULT_MESSAGE_TYPES: SummaryMessageType[] = ['text']

/** 日报范围选项（文案来自共享层，避免同一份配置出现两种叫法）。 */
export const SCHEDULED_REPORT_RANGE_OPTIONS: ReadonlyArray<{
  value: ScheduledReportRange
  label: string
}> = (['today', 'yesterday', '7days', 'recent24h'] as ScheduledReportRange[]).map((value) => ({
  value,
  label: SCHEDULED_REPORT_RANGE_LABELS[value]
}))

/** 成员名称选项（共享层唯一来源）。 */
export { SCHEDULED_REPORT_MEMBER_NAME_OPTIONS, SCHEDULED_REPORT_TARGET_OPTIONS }

/**
 * 后置词输入框的约束与占位文案。
 *
 * 两个都从共享层转出，**刻意不让编辑器直接 import shared** ——
 * 这样「手动发送」与「定时日报」两个入口的 200 字上限和占位句只有一份定义。
 */
export { SCHEDULED_REPORT_POSTFIX_MAX_LENGTH, DEFAULT_REPORT_IMAGE_POSTFIX_TEXT }

/** 发送目标四选一（共享层唯一来源）。 */
export type { ScheduledReportTargetType }

/** 模板选项（默认模板 + 社区模板）。 */
export const SCHEDULED_REPORT_TEMPLATE_SELECT_OPTIONS: ReadonlyArray<{
  value: SelectableReportTemplateId
  label: string
}> = [
  { value: DEFAULT_REPORT_TEMPLATE.id, label: DEFAULT_REPORT_TEMPLATE.name },
  ...REPORT_TEMPLATES.map((template) => ({
    value: template.id,
    label: `${template.label} · ${template.name}`
  }))
]

/** 与旧页面同语义的范围文案。 */
export function scheduledReportRangeLabel(range: ScheduledReportRange): string {
  return SCHEDULED_REPORT_RANGE_LABELS[range] ?? SCHEDULED_REPORT_RANGE_LABELS.today
}

/** 模板的展示名（列表 / 编辑器 / 预览必须是同一个称呼）。 */
export function scheduledReportTemplateLabel(templateId?: string): string {
  return getReportTemplate(templateId).name
}

/** 发送目标的展示名（列表用；不再需要"target 是否等于 group"的猜测）。 */
export function scheduledReportTargetDisplayName(
  config: ScheduledReportAutomationConfig | undefined,
  resolveGroupDisplay: (raw: string) => string
): string {
  const target = config?.target
  if (!target) return ''
  if (target.type === 'source_chat') {
    const group = resolveGroupDisplay(config.report.sourceConversationId)
    return group ? `${scheduledReportTargetLabel('source_chat')}（${group}）` : scheduledReportTargetLabel('source_chat')
  }
  if (target.type === 'contact') return scheduledReportTargetLabel('contact')
  return scheduledReportTargetLabel(target.type)
}

/** 新建草稿：目标默认「自己」，避免任何形式的"没选就发到群里"。 */
export function createEmptyScheduledReportDraft(): ScheduledReportDraft {
  return {
    name: '',
    enabled: true,
    scheduleTime: '18:30',
    group: '',
    reportRange: SCHEDULED_REPORT_DEFAULT_RANGE,
    messageTypes: [...SCHEDULED_REPORT_DEFAULT_MESSAGE_TYPES],
    memberNameMode: SCHEDULED_REPORT_DEFAULT_MEMBER_NAME_MODE,
    timeoutSeconds: SCHEDULED_REPORT_DEFAULT_TIMEOUT_SECONDS,
    templateId: SCHEDULED_REPORT_DEFAULT_TEMPLATE_ID,
    targetType: SCHEDULED_REPORT_DEFAULT_TARGET_TYPE,
    targetContactId: '',
    // 刻意留空：新建规则默认**不**补发任何文本，用户明确要才填。
    postfixText: ''
  }
}

/** 真实规则 → 编辑器草稿。 */
export function createDraftFromRule(rule: AutomationRule): ScheduledReportDraft {
  const config = normalizeScheduledReportConfig(rule.scheduledReport)
  return {
    name: rule.name,
    enabled: rule.enabled,
    scheduleTime: config.schedule.time,
    group: config.report.sourceConversationId,
    reportRange: config.report.range,
    messageTypes: config.report.messageTypes.length
      ? (config.report.messageTypes as SummaryMessageType[])
      : [...SCHEDULED_REPORT_DEFAULT_MESSAGE_TYPES],
    memberNameMode: config.report.memberNameMode,
    timeoutSeconds: config.report.timeoutSeconds,
    templateId: config.report.templateId,
    targetType: config.target.type,
    targetContactId: config.target.contactId ?? '',
    postfixText: config.postfixText ?? ''
  }
}

/**
 * 草稿 → `AutomationRuleDraft`（真正落盘的那一份）。
 *
 * 定时日报由**时间驱动**，不参与消息匹配；`trigger` / `scope` / `conditions` /
 * `actions` / `cooldownSeconds` 这几个字段保留只是为了 schema 完整
 * （`matchAutomationRule` 对 `scheduled_report` 是硬分派，永不读它们）。
 *
 * 显式清掉 `targetNeedsReview`：用户手动保存一次即代表"目标已确认"。
 * 旧的 `legacyTarget` / `legacySourceGroup` 也在这里丢弃 ——
 * 它们只服务于"让用户看清原来配的是什么"，保存之后就不再需要。
 */
export function draftToAutomationRuleDraft(draft: ScheduledReportDraft): AutomationRuleDraft {
  return {
    name: draft.name.trim(),
    enabled: draft.enabled,
    ruleType: 'scheduled_report',
    trigger: 'message',
    scope: 'group',
    conditions: {
      requireMentionMe: false,
      keyword: '',
      keywordMatchMode: 'contains',
      conversationIds: [],
      ignoreSelf: true
    },
    actions: [],
    // 不套用消息型规则的 cooldown：定时规则有自己的 ruleId inFlight 锁。
    cooldownSeconds: 0,
    replyDelaySeconds: AUTOMATION_REPLY_DELAY_DEFAULT_SECONDS,
    scheduledReport: normalizeScheduledReportConfig({
      schedule: { time: draft.scheduleTime },
      report: {
        sourceConversationId: draft.group,
        range: draft.reportRange,
        messageTypes: draft.messageTypes as ScheduledReportMessageType[],
        templateId: draft.templateId,
        memberNameMode: draft.memberNameMode,
        timeoutSeconds: draft.timeoutSeconds
      },
      target: {
        type: draft.targetType,
        ...(draft.targetType === 'contact' ? { contactId: draft.targetContactId } : {})
      },
      postfixText: draft.postfixText
    })
  }
}

/**
 * 时间展示：`今日 18:30` / `明日 18:30`。
 *
 * 只服务编辑器里的"预计下次执行"（草稿还没落盘，没有真实 `nextRunAt` 可读）。
 */
export function formatScheduledSlot(scheduleTime: string, now = new Date()): string {
  const [hour, minute] = parseScheduleTime(scheduleTime)
  const slot = new Date(now)
  slot.setSeconds(0, 0)
  slot.setHours(hour, minute)
  if (slot.getTime() <= now.getTime()) slot.setDate(slot.getDate() + 1)
  const isToday = slot.toDateString() === now.toDateString()
  return `${isToday ? '今日' : '明日'} ${pad2(hour)}:${pad2(minute)}`
}

/** 把真实的 `nextRunAt`（ISO）格式化成旧页面同款文案。 */
export function formatNextRunAt(value?: string): string {
  if (!value) return '尚未执行'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '时间未知'
  const now = new Date()
  const dayLabel =
    date.toDateString() === now.toDateString() ? '今日' : date.toLocaleDateString('zh-CN')
  return `${dayLabel} ${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
}

export function parseScheduleTime(value: string): [number, number] {
  const matched = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim())
  if (!matched) return [18, 30]
  const hour = Math.min(23, Math.max(0, Number(matched[1])))
  const minute = Math.min(59, Math.max(0, Number(matched[2])))
  return [hour, minute]
}

export function composeScheduleTime(hour: number, minute: number): string {
  return `${pad2(Math.min(23, Math.max(0, hour)))}:${pad2(Math.min(59, Math.max(0, minute)))}`
}

/**
 * 把规则里存的群标识解析成**能给用户看**的名字。
 *
 * 迁移过来的老数据可能仍是会话 md5 / 群名 / roomId 三种形态之一；
 * 直接渲染就会把内部标识暴露给用户。能对上群名就用群名；
 * 明显是内部标识又对不上时显示「未知群聊」，**绝不显示裸 id**。
 */
export function resolveGroupDisplayName(
  raw: string,
  groups: Array<{ id: string; name: string }>
): string {
  const value = String(raw ?? '').trim()
  if (!value) return ''
  const matched = groups.find((group) => group.id === value) ?? groups.find((g) => g.name === value)
  if (matched) return matched.name
  return looksLikeInternalIdentifier(value) ? '未知群聊' : value
}

/** 内部标识形态：room id / 16 进制 hash / 纯数字串。 */
function looksLikeInternalIdentifier(value: string): boolean {
  return (
    value.includes('@chatroom') || /^[0-9a-f]{16,}$/i.test(value) || /^\d{6,}$/.test(value)
  )
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}
