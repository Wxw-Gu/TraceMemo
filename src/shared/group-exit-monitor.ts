import type { WechatActionResult } from './wechat-action'

export interface GroupExitMonitorMember {
  wxid: string
  nickname?: string
  groupNickname?: string
  wechatNickname?: string
  remark?: string
  avatar?: string
}

export type GroupExitNotificationStatus =
  | 'not_requested'
  | 'pending'
  | 'sent'
  | 'blocked'
  | 'failed'

export interface GroupExitNotificationState {
  status: GroupExitNotificationStatus
  actionId?: string
  decision?: WechatActionResult['decision']
  errorCode?: string
  reason?: string
  startedAt?: string
  finishedAt?: string
}

export interface GroupExitMonitorEvent {
  id: string
  contactId: string
  roomId: string
  groupName: string
  memberWxid: string
  memberName: string
  /** 联系人表中的微信昵称。 */
  wechatName?: string
  /** 成员在本群的备注。 */
  groupRemark?: string
  /** 通讯录备注。 */
  contactRemark?: string
  previousCount: number
  currentCount: number
  delta: number
  message: string
  detectedAt: number
  /** 可选通知的结果；退群检测与通知发送彼此独立。 */
  notificationStatus?: GroupExitNotificationStatus
  notification?: GroupExitNotificationState
}

const LEGACY_GROUP_EXIT_NOTIFICATION_TEMPLATE = [
  '[退群监测]',
  '',
  '用户: {user}',
  '',
  '群备注: {groupRemark}',
  '',
  '微信号: {wxid}',
  '',
  '退群时间: {time}'
].join('\n')

/** 管理页预览和自动通知共用的模板。 */
export const GROUP_EXIT_NOTIFICATION_TEMPLATE = [
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

export const GROUP_EXIT_NOTIFICATION_TEMPLATE_MAX_LENGTH = 2_000
export const GROUP_EXIT_NOTIFICATION_TEMPLATE_PLACEHOLDERS = [
  'user',
  'groupRemark',
  'wxid',
  'previousCount',
  'currentCount',
  'time'
] as const

export interface GroupExitNotificationTemplateValidation {
  valid: boolean
  template?: string
  error?: string
}

const GROUP_EXIT_NOTIFICATION_TEMPLATE_PLACEHOLDER_PATTERN = /\{([^{}]+)\}/g
const supportedTemplatePlaceholders = new Set<string>(GROUP_EXIT_NOTIFICATION_TEMPLATE_PLACEHOLDERS)

export function validateGroupExitNotificationTemplate(
  value: unknown
): GroupExitNotificationTemplateValidation {
  const template = typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : ''
  if (!template) return { valid: false, error: '模板不能为空' }
  if (template.length > GROUP_EXIT_NOTIFICATION_TEMPLATE_MAX_LENGTH) {
    return {
      valid: false,
      error: `模板不能超过 ${GROUP_EXIT_NOTIFICATION_TEMPLATE_MAX_LENGTH} 个字符`
    }
  }
  const unsupported = Array.from(
    template.matchAll(GROUP_EXIT_NOTIFICATION_TEMPLATE_PLACEHOLDER_PATTERN),
    (match) => match[1]
  ).filter((placeholder) => !supportedTemplatePlaceholders.has(placeholder))
  if (unsupported.length) {
    return { valid: false, error: `不支持的占位符: ${Array.from(new Set(unsupported)).join(', ')}` }
  }
  return { valid: true, template }
}

export function normalizeGroupExitNotificationTemplate(value: unknown): string {
  const template = typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : ''
  if (template === LEGACY_GROUP_EXIT_NOTIFICATION_TEMPLATE) {
    return GROUP_EXIT_NOTIFICATION_TEMPLATE
  }
  const result = validateGroupExitNotificationTemplate(value)
  return result.valid && result.template ? result.template : GROUP_EXIT_NOTIFICATION_TEMPLATE
}

export function formatGroupExitMonitorTime(timestamp: number): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return '未知'
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** 根据模板生成通知文本。 */
export function renderGroupExitMonitorNotification(
  event: GroupExitMonitorEvent,
  template = GROUP_EXIT_NOTIFICATION_TEMPLATE
): string {
  const user =
    event.wechatName?.trim() || event.memberName?.trim() || event.memberWxid || '未读取到'
  const groupRemark = event.groupRemark?.trim() || '未设置'
  const wxid = event.memberWxid?.trim() || '未读取到'
  const values = {
    user,
    groupRemark,
    wxid,
    previousCount: String(event.previousCount),
    currentCount: String(event.currentCount),
    time: formatGroupExitMonitorTime(event.detectedAt)
  }
  return normalizeGroupExitNotificationTemplate(template).replace(
    /\{(user|groupRemark|wxid|previousCount|currentCount|time)\}/g,
    (placeholder) => {
      if (placeholder === '{user}') return values.user
      if (placeholder === '{groupRemark}') return values.groupRemark
      if (placeholder === '{wxid}') return values.wxid
      if (placeholder === '{previousCount}') return values.previousCount
      if (placeholder === '{currentCount}') return values.currentCount
      return values.time
    }
  )
}

/** 主进程中的辅助函数，供生成通知和预览时共用。 */
export function buildMemberLeftNotification(
  event: GroupExitMonitorEvent,
  template = GROUP_EXIT_NOTIFICATION_TEMPLATE
): string {
  return renderGroupExitMonitorNotification(event, template)
}

export interface GroupExitMonitorState {
  events: GroupExitMonitorEvent[]
  running: boolean
  nativeMonitorActive: boolean
  monitoredGroupCount: number
  /** 是否已设置监控范围。 */
  monitorSelectionConfigured?: boolean
  /** 管理页选中的群。 */
  monitoredRoomIds?: string[]
  /** 需要发送通知的群。 */
  notificationRoomIds?: string[]
  /** 自动通知模板。 */
  notificationTemplate?: string
  lastCheckedAt?: number
  lastReadAt: number
  unreadCount: number
}

export function groupExitMemberName(member: GroupExitMonitorMember): string {
  return (
    member.groupNickname?.trim() ||
    member.wechatNickname?.trim() ||
    member.remark?.trim() ||
    member.nickname?.trim() ||
    member.wxid
  )
}

/** 返回前一份快照中已经不在当前快照的成员。 */
export function findRemovedGroupMembers(
  previous: GroupExitMonitorMember[],
  next: GroupExitMonitorMember[]
): GroupExitMonitorMember[] {
  const nextWxids = new Set(next.map((member) => member.wxid).filter(Boolean))
  const seen = new Set<string>()
  return previous.filter(
    (member) =>
      Boolean(member.wxid) &&
      !nextWxids.has(member.wxid) &&
      !seen.has(member.wxid) &&
      seen.add(member.wxid)
  )
}
