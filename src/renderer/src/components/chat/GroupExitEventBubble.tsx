import React from 'react'
import type { Message } from '../../../../shared/types'

interface GroupExitEventBubbleProps {
  message: Message
}

/**
 * 退群推断事件在档案里的展示。
 *
 * ⚠️ 与真实微信系统消息**必须视觉可区分**，原因不是审美：
 * 这条内容**不是微信说的话**，而是 TraceMemo 通过「群成员快照前后对比」推断出来的。
 * 两者的可信度完全不同 —— 微信系统消息是事实原文，这条是推断产物，
 * 而且它记录的是**检测时刻**（可能比真实退群时间晚几分钟到几天）。
 *
 * 所以它带一个「本地推断」标记，且样式与 `wechat-system-message` 明确区分。
 */
export function GroupExitEventBubble({ message }: GroupExitEventBubbleProps): React.ReactElement {
  return (
    <div className="group-exit-event-row">
      <div className="group-exit-event-bubble">
        <span className="group-exit-event-tag">本地推断</span>
        <span className="group-exit-event-text">{message.content}</span>
      </div>
    </div>
  )
}
