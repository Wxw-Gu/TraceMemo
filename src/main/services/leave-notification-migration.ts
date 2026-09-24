import {
  LEAVE_NOTIFICATION_DEFAULT_TARGET_TYPE,
  normalizeLeaveNotificationTemplate,
  type LeaveNotificationTarget
} from '../../shared/automation'

/**
 * 旧「退群监控 → 通知群聊 / 模板」配置 → 新「自动化 → 退群通知」规则的**纯映射器**。
 *
 * 单独成文件是为了能直接单测：这是整轮迁移里**唯一会改变用户既有行为**的地方，
 * 不允许只靠"跑一遍看看"来验证。
 *
 * ## 旧语义（实测自 `group-exit-monitor-service.ts`）
 *
 * `notificationRoomIds` **不是**"统一通知接收目标列表"，而是
 * **"哪些被监控群要在自己群里通报成员退出"**（per-group 多值）：
 * - `applyCurrentMemberships()` 只在 `notificationRoomIds.has(roomId)` 时通知；
 * - `notifyGroup()` 的收件人**恒等于事件所在群**。
 *
 * ## 新语义
 *
 * 单值目标：`source_chat` / `self` / `file_transfer` / `contact`。
 *
 * ⇒ 两者**只在一种情况下等价**：旧配置把**每一个**被监控群都勾上了通知。
 * 严格子集无法表达，按保守策略处理，绝不"随便取第一个群"。
 */

export interface LegacyLeaveNotificationState {
  monitoredRoomIds: string[]
  notificationRoomIds: string[]
  notificationTemplate?: unknown
}

export type LeaveNotificationMigrationOutcome =
  /** 旧配置从不通知任何人 ⇒ 迁移成"关闭"，行为完全一致。 */
  | 'lossless_off'
  /** 旧配置在**每个**被监控群里通报 ⇒ 等价于 `source_chat`，行为完全一致。 */
  | 'lossless_source_chat'
  /** 旧配置只在**部分**群里通报 ⇒ 单值目标无法表达，需用户重选。 */
  | 'needs_review'

export interface LeaveNotificationMigrationPlan {
  outcome: LeaveNotificationMigrationOutcome
  enabled: boolean
  target: LeaveNotificationTarget
  targetNeedsReview: boolean
  template: string
}

function uniqueRoomIds(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  const result: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const roomId = String(value || '').trim()
    if (!roomId || seen.has(roomId)) continue
    seen.add(roomId)
    result.push(roomId)
  }
  return result
}

export function planLeaveNotificationMigration(
  legacy: LegacyLeaveNotificationState
): LeaveNotificationMigrationPlan {
  const monitored = uniqueRoomIds(legacy.monitoredRoomIds)
  const monitoredSet = new Set(monitored)
  // 再夹一次：防止脏状态文件把范围外的群带进来。
  const notifications = uniqueRoomIds(legacy.notificationRoomIds).filter((roomId) =>
    monitoredSet.has(roomId)
  )
  // 模板永远是无损迁移的那一项：它就是用户写的那段文字。
  const template = normalizeLeaveNotificationTemplate(legacy.notificationTemplate)
  const defaultTarget: LeaveNotificationTarget = { type: LEAVE_NOTIFICATION_DEFAULT_TARGET_TYPE }

  if (!notifications.length) {
    // 旧语义是"从不通知" ⇒ 关掉，避免迁移后突然开始发消息。
    return {
      outcome: 'lossless_off',
      enabled: false,
      target: defaultTarget,
      targetNeedsReview: false,
      template
    }
  }

  if (monitored.length > 0 && notifications.length === monitored.length) {
    // 每个被监控群都在自己群里通报 ⇔ 单值的 `source_chat`。
    return {
      outcome: 'lossless_source_chat',
      enabled: true,
      target: { type: 'source_chat' },
      targetNeedsReview: false,
      template
    }
  }

  // 部分勾选：**不能**无损映射。不取第一个群、不改写成当前群聊、保持关闭、要求重选。
  return {
    outcome: 'needs_review',
    enabled: false,
    target: defaultTarget,
    targetNeedsReview: true,
    template
  }
}
