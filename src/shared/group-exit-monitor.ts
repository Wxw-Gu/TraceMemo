export interface GroupExitMonitorMember {
  wxid: string
  nickname?: string
  groupNickname?: string
  wechatNickname?: string
  remark?: string
  avatar?: string
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

export const GROUP_EXIT_NOTIFICATION_TEMPLATE_MAX_LENGTH = 2_000
export const GROUP_EXIT_NOTIFICATION_TEMPLATE_PLACEHOLDERS = [
  // 群名排在最前：通知一旦发给「文件传输助手 / 自己 / 指定好友」，
  // 收件人第一件要知道的事就是**哪个群**退的人。
  'groupName',
  'user',
  'groupRemark',
  'wxid',
  'previousCount',
  'currentCount',
  'time'
] as const

/**
 * 每个变量的**中文含义**（编辑器悬停提示用）。
 *
 * 为什么必须有：变量清单原先只有 `{groupRemark}` 这种符号，用户看不出含义 ——
 * 实测有人把 `{groupRemark}` 当成"群名"（它其实是**成员在本群的昵称**），
 * 于是以为通知里已经有群名了。这类误会只能靠把含义写出来消除。
 */
export const GROUP_EXIT_NOTIFICATION_PLACEHOLDER_LABELS: Record<
  (typeof GROUP_EXIT_NOTIFICATION_TEMPLATE_PLACEHOLDERS)[number],
  string
> = {
  groupName: '群聊名（发生退群的群）',
  user: '退群成员的显示名',
  groupRemark: '退群成员在本群的昵称（不是群名）',
  wxid: '成员的微信号',
  previousCount: '退群前人数',
  currentCount: '退群后人数',
  time: '退群时间'
}

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

/**
 * 模板插值的**唯一实现**。
 *
 * 退群监控的「复制退群信息」与自动化的「退群通知」都走这里 ——
 * 迁移不允许产生第二套 regex，否则预览与实际发送迟早不一致。
 */
export function renderGroupExitNotificationTemplate(
  template: string,
  values: GroupExitNotificationValues
): string {
  return normalizeGroupExitNotificationTemplate(template).replace(
    /\{(groupName|user|groupRemark|wxid|previousCount|currentCount|time)\}/g,
    (placeholder) => {
      if (placeholder === '{groupName}') return values.groupName
      if (placeholder === '{user}') return values.user
      if (placeholder === '{groupRemark}') return values.groupRemark
      if (placeholder === '{wxid}') return values.wxid
      if (placeholder === '{previousCount}') return values.previousCount
      if (placeholder === '{currentCount}') return values.currentCount
      return values.time
    }
  )
}

export interface GroupExitNotificationValues {
  /** 发生退群的**群显示名**（含群备注）。 */
  groupName: string
  /** 退群成员的显示名（微信名 → 群昵称 → 微信号 依次回退）。 */
  user: string
  /** 退群成员**在本群的昵称**。⚠️ 不是群名 —— 群名是 `groupName`。 */
  groupRemark: string
  wxid: string
  previousCount: string
  currentCount: string
  time: string
}

/**
 * 变量取值的**唯一实现**，含全部 fallback 规则。
 *
 * ⚠️ 这些 fallback 是历史产品行为（`未读取到` / `未设置`），迁移**不得**改变输出：
 * 退群监控与自动化都从这里取值，所以不存在"两处 fallback 漂移"的可能。
 */
export function buildGroupExitNotificationValues(input: {
  groupName?: string
  wechatNickname?: string
  memberName?: string
  memberId?: string
  groupRemark?: string
  previousCount: number
  currentCount: number
  occurredAt: number
}): GroupExitNotificationValues {
  return {
    groupName: input.groupName?.trim() || '未读取到',
    user: input.wechatNickname?.trim() || input.memberName?.trim() || input.memberId || '未读取到',
    groupRemark: input.groupRemark?.trim() || '未设置',
    wxid: input.memberId?.trim() || '未读取到',
    previousCount: String(input.previousCount),
    currentCount: String(input.currentCount),
    time: formatGroupExitMonitorTime(input.occurredAt)
  }
}

/** 根据模板生成通知文本（退群监控侧入口，保持既有签名与输出）。 */
export function renderGroupExitMonitorNotification(
  event: GroupExitMonitorEvent,
  template = GROUP_EXIT_NOTIFICATION_TEMPLATE
): string {
  return renderGroupExitNotificationTemplate(
    template,
    buildGroupExitNotificationValues({
      groupName: event.groupName,
      wechatNickname: event.wechatName,
      memberName: event.memberName,
      memberId: event.memberWxid,
      groupRemark: event.groupRemark,
      previousCount: event.previousCount,
      currentCount: event.currentCount,
      occurredAt: event.detectedAt
    })
  )
}

export interface GroupExitMonitorState {
  /** 最近一批事件（一次回报最多带回这么多条，避免把整部历史推过 IPC）。 */
  events: GroupExitMonitorEvent[]
  /** 永久保留的事件总数；`events` 只是其中最近的若干条。 */
  totalEventCount?: number
  enabled: boolean
  running: boolean
  nativeMonitorActive: boolean
  monitoredGroupCount: number
  /** 是否已设置监控范围。 */
  monitorSelectionConfigured?: boolean
  /** 管理页选中的群。 */
  monitoredRoomIds?: string[]
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

/**
 * 把 `群聊: {groupName}` 补进一份**已有**模板。
 *
 * 放在 shared 而不是 main：主进程的模板升级迁移要用它，
 * 编辑器的「一键补上群聊名」也要用它 —— 只允许有一份实现。
 *
 * 三条约束：
 * 1. **幂等**：已经含 `{groupName}` 就原样返回；
 * 2. **不破坏用户内容**：只在标题行后插入一行，其余文本与顺序一字不动；
 * 3. 调用方负责"只补一次"—— 否则用户删掉这一行后重启它又回来，
 *    那种"删不掉"的行为比缺失信息更糟。
 */
export function insertGroupNamePlaceholder(template: string): string {
  const normalized = String(template ?? '').replace(/\r\n?/g, '\n')
  if (!normalized.trim()) return template
  if (normalized.includes('{groupName}')) return template

  const lines = normalized.split('\n')
  const titleIndex = lines.findIndex((line) => line.trim())
  // 首行是标题（`[退群监测]` 这类）就插在它后面，否则插到最前面。
  const insertAt = titleIndex >= 0 && lines[titleIndex].trim().startsWith('[') ? titleIndex + 1 : 0
  // 前后各留一个空行（与标题、与下文都分开）；紧随其后的多余空行由下面的压缩处理掉。
  return [...lines.slice(0, insertAt), '', '群聊: {groupName}', '', ...lines.slice(insertAt)]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
