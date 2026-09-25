import {
  DEFAULT_REPORT_TEMPLATE,
  REPORT_TEMPLATES,
  SELECTABLE_REPORT_TEMPLATES,
  getReportTemplate,
  type SelectableReportTemplateId
} from '../../../../../shared/report-templates'
import type {
  ScheduledReportMemberNameMode,
  ScheduledReportRange,
  ScheduledReportTask
} from '../../../../../shared/scheduled-report'
import { SUMMARY_TYPE_OPTIONS, type SummaryMessageType } from '../../../utils/group-report'

/**
 * 定时日报编辑态的模型与只读数据层。
 *
 * 对外唯一的接触面是 `window.api.listScheduledReports`（**只读**）：
 * 不写、不执行、不动 scheduler / store / schema。
 *
 * 所有字段都来自 `shared/scheduled-report.ts` 的真实模型，**不发明后端不存在的选项**：
 * - `schedule.type` 只有 `'daily'` ⇒ 界面只给"每天 + 时间"；
 * - `target` 是单个群（`type: 'wechat_group'`）⇒ 界面只给群聊目标；
 * - `templateId` 真实存在 ⇒ 界面可以给模板选择。
 */

/**
 * 编辑器的草稿：字段与**旧「定时日报」真实配置**一一对应，
 * 没有任何"想象出来的"配置，也没有丢掉任何一项已有能力。
 */
export interface ScheduledReportDraft {
  name: string
  /** 每天的执行时间 `HH:mm`，对应真实的 `schedule: { type: 'daily', time }`。 */
  scheduleTime: string
  reportRange: ScheduledReportRange
  /** 日报来源群：生成**哪个群**的日报。 */
  group: string
  /** 纳入的消息类型（真实 `messageTypes`）。 */
  messageTypes: SummaryMessageType[]
  /** 成员名称显示方式（真实 `memberNameMode`）。 */
  memberNameMode: ScheduledReportMemberNameMode
  /** 日报生成超时（真实 `timeoutSeconds`，旧页面 30–1800 秒）。 */
  timeoutSeconds: number
  templateId: SelectableReportTemplateId
  /**
   * 发送目标的**类型**。
   *
   * 这是本层的概念：真实的 `ScheduledReportTask.target` 只是一个字符串
   * （目前只表达"某个微信群"）。四选一里的「自己 / 文件传输助手 / 指定好友」
   * 在真实模型里还没有对应的类型化表达 —— 真实迁移时应当照退群通知的做法，
   * 给 target 一个带类型的模型与解析器。
   */
  targetType: ScheduledReportTargetType
  /** `targetType === 'source_chat'` 时的目标群（= 来源群，旧页面就是这个语义）。 */
  target: string
  /** `targetType === 'contact'` 时的联系人。 */
  targetContactId: string
  enabled: boolean
}

/** 全部消息类型（旧页面默认全选）。 */
export const ALL_SCHEDULED_REPORT_MESSAGE_TYPES: SummaryMessageType[] = SUMMARY_TYPE_OPTIONS.map(
  (option) => option.value
)

/** 成员名称选项（与旧页面一致）。 */
export const SCHEDULED_REPORT_MEMBER_NAME_OPTIONS: ReadonlyArray<{
  value: ScheduledReportMemberNameMode
  label: string
}> = [
  { value: 'groupNickname', label: '群昵称' },
  { value: 'wechatNickname', label: '微信昵称' },
  { value: 'remark', label: '通讯录备注' }
]

/**
 * 发送目标四选一。
 *
 * 第一项与退群通知不同：定时日报没有"当前消息所在群"这个概念，
 * 所以是「日报来源群」。刻意**不提供"指定其他群聊"** ——
 * 生成 A 群日报却发到 B 群是很容易让人误解的配置。
 */
export type ScheduledReportTargetType = 'source_chat' | 'self' | 'file_transfer' | 'contact'

export const SCHEDULED_REPORT_TARGET_OPTIONS: ReadonlyArray<{
  type: ScheduledReportTargetType
  label: string
  description: string
}> = [
  {
    type: 'file_transfer',
    label: '文件传输助手',
    description: '将生成的日报发送到文件传输助手。'
  },
  {
    type: 'source_chat',
    label: '发送到日报来源群',
    description: '把生成的日报发送回用于生成日报的那个群。'
  },
  {
    type: 'self',
    label: '发给自己',
    description: '将生成的日报发送到当前登录微信账号自己的会话。'
  },
  {
    type: 'contact',
    label: '指定好友',
    description: '将生成的日报发送给一个指定联系人。'
  }
]

/** 新建时的默认发送目标：文件传输助手（不会误打扰群聊）。 */
export const DEFAULT_SCHEDULED_REPORT_TARGET_TYPE: ScheduledReportTargetType = 'file_transfer'

/** 模板选项：与旧页面同一套定义（默认模板 + REPORT_TEMPLATES）。 */
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

/** 日报范围选项。文案与旧「日报 → 定时日报」页面保持一致。 */
export const SCHEDULED_REPORT_RANGE_OPTIONS: ReadonlyArray<{
  value: ScheduledReportRange
  label: string
}> = [
  { value: 'today', label: '今日' },
  { value: 'yesterday', label: '昨日' },
  { value: '7days', label: '近 7 天' },
  { value: 'recent24h', label: '最近24小时' }
]

/** 可选日报模板（真实定义来自 `report-templates.ts`）。 */
export const SCHEDULED_REPORT_TEMPLATE_OPTIONS = SELECTABLE_REPORT_TEMPLATES.map((template) => ({
  value: template.id,
  label: template.label
}))

export const DEFAULT_SCHEDULED_REPORT_TEMPLATE_ID: SelectableReportTemplateId = 'v1'

/** 与旧页面同语义的范围文案（`近 7 天` 的空格等细节刻意保持一致）。 */
export function scheduledReportRangeLabel(range: ScheduledReportRange): string {
  return (
    SCHEDULED_REPORT_RANGE_OPTIONS.find((option) => option.value === range)?.label ??
    SCHEDULED_REPORT_RANGE_OPTIONS[0].label
  )
}

/**
 * 时间展示：`今日 18:30` / `明日 18:30`。
 *
 * 这里只服务**本地草稿预览**（用户刚改完时间就要看到结果），
 * 所以用"今日/明日"表达相对关系；真实任务的 `nextRunAt` 展示沿用旧页面语义。
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

/** 把真实的 `nextRunAt` 格式化成旧页面同款文案。 */
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

export function createEmptyScheduledReportDraft(): ScheduledReportDraft {
  return {
    name: '',
    scheduleTime: '18:30',
    reportRange: 'today',
    group: '',
    // 与旧页面一致：默认纳入全部消息类型。
    messageTypes: [...ALL_SCHEDULED_REPORT_MESSAGE_TYPES],
    memberNameMode: 'groupNickname',
    timeoutSeconds: 300,
    templateId: DEFAULT_SCHEDULED_REPORT_TEMPLATE_ID,
    // 默认发到文件传输助手：不会误打扰任何群聊。
    targetType: DEFAULT_SCHEDULED_REPORT_TARGET_TYPE,
    target: '',
    targetContactId: '',
    enabled: true
  }
}

/** 真实任务 → 编辑器草稿（只用于**预览**，保存不落盘）。 */
export function createDraftFromTask(task: ScheduledReportTask): ScheduledReportDraft {
  return {
    name: task.name,
    scheduleTime: task.scheduleTime,
    reportRange: task.reportRange,
    group: task.group,
    messageTypes: task.messageTypes?.length
      ? (task.messageTypes as SummaryMessageType[])
      : [...ALL_SCHEDULED_REPORT_MESSAGE_TYPES],
    memberNameMode: task.memberNameMode ?? 'groupNickname',
    timeoutSeconds: task.timeoutSeconds ?? 300,
    templateId: task.templateId ?? DEFAULT_SCHEDULED_REPORT_TEMPLATE_ID,
    // 旧页面里「发送到」恒等于来源群（只读展示），所以历史任务一律按"发回来源群"回显。
    targetType: 'source_chat',
    target: task.target,
    targetContactId: '',
    enabled: task.enabled
  }
}

/**
 * 把任务里存的群标识解析成**能给用户看**的名字。
 *
 * `ScheduledReportTask.group/target` 的真实类型是 "human-readable group name or room id"，
 * 实际数据里两种都可能出现（纯数字 room id 与 16 进制 hash）。
 * 直接渲染就会把内部标识暴露给用户，所以这里做一次显示名解析：
 * 能对上群名就用群名；明显是内部标识又对不上时显示「未知群聊」，**绝不显示裸 id**。
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

/**
 * 模板的**展示名**。
 *
 * 用 `name`（"经典日报"）而不是 `label`（"默认模板"）：
 * 同一个模板在列表、预览、选择器里必须是同一个称呼，
 * 否则同一份配置会出现两种叫法。
 */
export function scheduledReportTemplateLabel(templateId?: string): string {
  return getReportTemplate(templateId).name
}

/**
 * 只读加载现有定时日报任务。
 *
 * **唯一的读取入口**，也是本文件与真实系统唯一的接触面：
 * - 不调用 create / update / delete / execute / toggle；
 * - 接口不存在或失败时返回空数组，让界面走空态，而不是伪造数据。
 */
export async function loadScheduledReportTasks(): Promise<ScheduledReportTask[]> {
  const target = (globalThis as { api?: Record<string, unknown> }).api
  const loader = target?.listScheduledReports
  if (typeof loader !== 'function') return []
  try {
    const tasks = await (loader as () => Promise<unknown>).call(target)
    return Array.isArray(tasks) ? (tasks as ScheduledReportTask[]) : []
  } catch {
    return []
  }
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}
