import {
  buildGroupExitNotificationValues,
  renderGroupExitNotificationTemplate,
  type GroupExitMonitorEvent
} from './group-exit-monitor'

/**
 * GroupMemberExitedEvent —— 退群监控交给自动化消费的**稳定事件契约**。
 *
 * 为什么不让 Automation 直接吃 `GroupExitMonitorEvent`：
 * 后者是退群监控的**存储形态**（含 delta / message 展示串 / 历史通知状态），
 * 会随监控自身的演进而变。Automation 只需要「谁、在哪个群、什么时候、人数怎么变」，
 * 所以这里显式定义一份最小契约 + 一个纯映射函数。
 *
 * `eventId` 是**唯一键**，直接复用退群记录自己的 id（`GroupExitMonitorEvent.id`）——
 * 不允许用昵称 / 群名 / 显示文本做唯一键。
 */

export interface GroupMemberExitedEvent {
  /** 稳定事件 id（= 退群记录的 id）。Automation 侧幂等以它为准。 */
  eventId: string
  /** 发生退群的群（`xxx@chatroom`）。`source_chat` 目标就是它。 */
  conversationId: string
  /** 群显示名（用户可读，用于日志/展示，**不是**唯一键）。 */
  groupName?: string
  /** 成员在本群的备注。 */
  groupRemark?: string
  /** 退群成员的稳定 id（wxid）。唯一键之一，但**不进用户可见日志**。 */
  memberId: string
  /** 成员显示名（用户可读）。 */
  memberName?: string
  /** 联系人表里的微信昵称。 */
  wechatNickname?: string
  /** 通讯录备注。 */
  contactRemark?: string
  previousCount: number
  currentCount: number
  /** 事件发生时间（epoch ms）。 */
  occurredAt: number
}

/** 纯映射：退群记录 → 自动化事件。 */
export function toGroupMemberExitedEvent(event: GroupExitMonitorEvent): GroupMemberExitedEvent {
  const groupName = String(event.groupName || '').trim()
  const groupRemark = String(event.groupRemark || '').trim()
  const memberName = String(event.memberName || '').trim()
  const wechatNickname = String(event.wechatName || '').trim()
  const contactRemark = String(event.contactRemark || '').trim()
  return {
    eventId: String(event.id || '').trim(),
    conversationId: String(event.roomId || '').trim(),
    ...(groupName ? { groupName } : {}),
    ...(groupRemark ? { groupRemark } : {}),
    memberId: String(event.memberWxid || '').trim(),
    ...(memberName ? { memberName } : {}),
    ...(wechatNickname ? { wechatNickname } : {}),
    ...(contactRemark ? { contactRemark } : {}),
    previousCount: Number(event.previousCount) || 0,
    currentCount: Number(event.currentCount) || 0,
    occurredAt: Number(event.detectedAt) || 0
  }
}

/**
 * 渲染退群通知文本。
 *
 * **复用**退群监控那份唯一的插值实现（`renderGroupExitNotificationTemplate`）——
 * 迁移不允许产生第二套模板 regex，否则预览与实发迟早不一致。
 */
export function renderLeaveNotificationText(
  event: GroupMemberExitedEvent,
  template: string
): string {
  return renderGroupExitNotificationTemplate(
    template,
    buildGroupExitNotificationValues({
      groupName: event.groupName,
      wechatNickname: event.wechatNickname,
      memberName: event.memberName,
      memberId: event.memberId,
      groupRemark: event.groupRemark,
      previousCount: event.previousCount,
      currentCount: event.currentCount,
      occurredAt: event.occurredAt
    })
  )
}

/**
 * **只服务效果预览**的样本事件。
 *
 * 它永远不会进入发送路径：渲染层拿它把模板渲染出来给用户看。
 * 时间取"此刻"，所以预览里显示的是当前时间，而不是一个伪造的历史日期。
 * 集中定义在这里，避免散落的假数据被误当成真实事件。
 *
 * ⚠️ **样本必须与真实数据同形**，否则预览会骗人：
 * `groupRemark` 是「退群成员**在本群的昵称**」（真实来源 `member.groupNickname`），
 * 不是群名；群名是 `groupName`。两者取不同的值，区别才看得出来。
 */
export function createGroupExitPreviewSample(now: number): GroupMemberExitedEvent {
  return {
    eventId: 'preview-sample',
    conversationId: 'preview@chatroom',
    groupName: 'TraceMemo 交流群',
    // 成员在本群的昵称：刻意与 groupName 取不同的值，一眼能看出两者不是一回事。
    groupRemark: '小张',
    // 明确是占位符，**不要**长得像真实账号 —— 预览里的 {wxid} 不是任何人的 wxid。
    memberId: 'wxid_xxxxx',
    memberName: '张三',
    wechatNickname: '张三',
    previousCount: 243,
    currentCount: 242,
    occurredAt: now
  }
}
