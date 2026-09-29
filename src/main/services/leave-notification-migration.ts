import {
  normalizeLeaveNotificationRoomIds,
  normalizeLeaveNotificationTemplate,
  type LeaveNotificationNotifyScope,
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
 * 旧版是**两层**配置，缺一不可：
 * 1. **管理群聊**（`monitoredRoomIds`）= 监测哪些群有人退出；
 * 2. **通知群聊**（`notificationRoomIds`）= 上面这批群里，**哪些要真的发通知**
 *    —— 即对第 1 层的二次勾选。
 *
 * `notificationRoomIds` **不是**"统一通知接收目标列表"，而是
 * **"哪些被监控群要在自己群里通报成员退出"**（per-group 多值）：
 * - `applyCurrentMemberships()` 只在 `notificationRoomIds.has(roomId)` 时通知；
 * - `notifyGroup()` 的收件人**恒等于事件所在群**。
 *
 * ## 新语义
 *
 * 拆成**两个正交维度**，恰好一一对应旧版那两层：
 * - `target`      ← 旧版第 2 层里"发回本群"这个事实 ⇒ 恒为 `source_chat`；
 * - `notifyScope` / `notifyRoomIds` ← 旧版第 2 层是"哪些群"，逐字保留。
 *
 * ⇒ **迁移现在是无损的**。早期版本把目标压成单值、丢掉了第 2 层的"哪些群"，
 * 于是部分勾选只能判成 `needs_review` 并强制停用；恢复 `notifyScope` 之后
 * 这个特例整体消失，用户不会再有"规则被无辜停用"的体验。
 */

export interface LegacyLeaveNotificationState {
  monitoredRoomIds: string[]
  notificationRoomIds: string[]
  notificationTemplate?: unknown
}

export type LeaveNotificationMigrationOutcome =
  /** 旧配置从不通知任何人 ⇒ 迁移成"关闭"，行为完全一致。 */
  | 'lossless_off'
  /** 旧配置在**每个**被监控群里通报 ⇒ `notifyScope: 'all'`，行为完全一致。 */
  | 'lossless_all_groups'
  /** 旧配置只在**部分**群里通报 ⇒ `notifyScope: 'selected'` + 原样保留那份勾选。 */
  | 'lossless_selected_groups'

export interface LeaveNotificationMigrationPlan {
  outcome: LeaveNotificationMigrationOutcome
  enabled: boolean
  target: LeaveNotificationTarget
  notifyScope: LeaveNotificationNotifyScope
  notifyRoomIds: string[]
  targetNeedsReview: boolean
  template: string
}

function uniqueRoomIds(values: unknown): string[] {
  return normalizeLeaveNotificationRoomIds(values)
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
  // 旧版收件人恒为事件所在群 ⇒ 无论勾了几个群，目标都是 source_chat。
  const target: LeaveNotificationTarget = { type: 'source_chat' }

  if (!notifications.length) {
    // 旧语义是"从不通知" ⇒ 关掉，避免迁移后突然开始发消息。
    // 同时把范围写成 `selected` + 空集：配置本身也精确表达"一个都不通知"。
    return {
      outcome: 'lossless_off',
      enabled: false,
      target,
      notifyScope: 'selected',
      notifyRoomIds: [],
      targetNeedsReview: false,
      template
    }
  }

  if (monitored.length > 0 && notifications.length === monitored.length) {
    // 每个被监控群都在自己群里通报 ⇒ 等价于"全部已监控群聊"。
    return {
      outcome: 'lossless_all_groups',
      enabled: true,
      target,
      notifyScope: 'all',
      notifyRoomIds: [],
      targetNeedsReview: false,
      template
    }
  }

  // 部分勾选：**无损**保留那份子集，不再降级成 needs_review。
  return {
    outcome: 'lossless_selected_groups',
    enabled: true,
    target,
    notifyScope: 'selected',
    notifyRoomIds: notifications,
    targetNeedsReview: false,
    template
  }
}
