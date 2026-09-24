import * as React from 'react'
import {
  describeMonitoredScope,
  leaveNotificationTargetLabel,
  type LeaveNotificationConfig
} from '../../../../shared/automation'
import {
  createGroupExitPreviewSample,
  renderLeaveNotificationText
} from '../../../../shared/group-exit-event'

/**
 * LeaveNotificationPreview —— 右侧「效果预览」。
 *
 * 与左侧表单逐项联动：改模板 → 气泡变；改发送目标 → 顶部收件会话与底部「通知目标」一起变。
 *
 * **绝不发送**：即使规则已经真实接通，这里也只做渲染 ——
 * 它拿的是 `GROUP_EXIT_PREVIEW_SAMPLE` 样本事件，不碰 `WechatActionGateway`。
 * 模板渲染复用 shared 的唯一实现，所以预览与实发不会出现两套结果。
 */

export interface LeaveNotificationPreviewProps {
  config: LeaveNotificationConfig
  /** 「指定好友」已选联系人的显示名；未选 / 不是该目标时传空串。 */
  contactName: string
  /** 真实已监控群聊数量（来自退群监控）。 */
  monitoredCount: number
}

export function LeaveNotificationPreview({
  config,
  contactName,
  monitoredCount
}: LeaveNotificationPreviewProps): React.ReactElement {
  // 样本事件只服务预览；时间取"此刻"，不伪造历史日期。
  const sample = React.useMemo(() => createGroupExitPreviewSample(Date.now()), [])

  const chatTitle = React.useMemo((): string => {
    switch (config.target.type) {
      case 'source_chat':
        return sample.groupName || '当前群聊'
      case 'self':
        return '我'
      case 'file_transfer':
        return leaveNotificationTargetLabel('file_transfer')
      case 'contact':
        return contactName.trim() || '未选择好友'
    }
  }, [config.target.type, contactName, sample.groupName])

  const targetSummary = React.useMemo((): string => {
    switch (config.target.type) {
      case 'source_chat':
        return '发生退群事件的群聊'
      case 'self':
        return '我'
      case 'file_transfer':
        return leaveNotificationTargetLabel('file_transfer')
      case 'contact':
        return contactName.trim() || '未选择好友'
    }
  }, [config.target.type, contactName])

  const bubbleText = renderLeaveNotificationText(sample, config.template).trim() || '（模板为空）'

  return (
    <section className="automation-preview" aria-label="效果模拟预览">
      <div className="automation-preview-heading">
        <h3>效果预览</h3>
        <span className="automation-preview-badge">仅预览，不会真实发送</span>
      </div>

      <div className="automation-preview-phone">
        <div className="automation-preview-chat-title" data-testid="leave-preview-recipient">
          <span>{chatTitle}</span>
        </div>
        <div className="automation-preview-chat">
          {/* 退群监控产生的系统事件，不来自任何消息文本 */}
          <p className="automation-preview-system">检测到成员退出</p>

          <div className="automation-chat-row outgoing">
            <div className="automation-chat-body">
              <span className="automation-chat-name">我</span>
              <span className="automation-chat-bubble pre">{bubbleText}</span>
            </div>
            <span className="automation-chat-avatar self" aria-hidden="true">
              我
            </span>
          </div>
        </div>
      </div>

      <dl className="automation-preview-facts">
        <div>
          <dt>触发事件</dt>
          <dd>成员退出</dd>
        </div>
        <div>
          <dt>监控来源</dt>
          <dd>{describeMonitoredScope(monitoredCount)}</dd>
        </div>
        <div>
          <dt>通知目标</dt>
          <dd>{targetSummary}</dd>
        </div>
      </dl>
    </section>
  )
}
