import type { GroupExitMonitorEvent } from './group-exit-monitor'
import type { Message } from './types'

/**
 * 退群事件在档案消息流里的标记类型。
 *
 * 复用它自己的 `type` 值而不是靠 `from === 'system'` 判断，是因为**真实微信也会发系统消息**
 * （入群通知、撤回提示等）。两者都走系统消息的分支渲染，但必须能被区分出来 ——
 * 退群事件是**本地推断的产物**，不是微信的原话，展示上不能让人误以为是。
 */
export const GROUP_EXIT_EVENT_MESSAGE_TYPE = 'group-exit-event'

/** 这条档案消息是不是退群推断事件。 */
export function isGroupExitEventMessage(message: Message): boolean {
  return message.type === GROUP_EXIT_EVENT_MESSAGE_TYPE
}

const pad2 = (value: number): string => String(value).padStart(2, '0')

/** 本地时区的 `YYYY-MM-DD HH:mm`。 */
function formatLocalDateTime(epochMs: number): string {
  const date = new Date(epochMs)
  if (Number.isNaN(date.getTime())) return ''
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  )
}

/**
 * 把一个退群事件映射成档案里的消息条目。
 *
 * ⚠️ **单位陷阱**：`Message.createTime` 全项目都是 **epoch 秒**
 * （见 `messageGrouping.getMessageTime`：`new Date(timestamp * 1000)`），
 * 而事件的 `detectedAt` 是 **epoch 毫秒**。这里必须 `/1000`，
 * 否则事件会被排到 55000 年之后，或者干脆从时间轴上消失。
 */
export function toGroupExitEventMessage(event: GroupExitMonitorEvent): Message {
  const detectedAtMs = Number(event.detectedAt) || 0
  return {
    id: `group-exit:${event.id}`,
    from: 'system',
    type: GROUP_EXIT_EVENT_MESSAGE_TYPE,
    datetime: formatLocalDateTime(detectedAtMs),
    // 文本用事件自带的渲染结果（含"退群时间"等模板字段），不再二次拼接。
    content: event.message,
    isSender: false,
    senderId: event.memberWxid,
    name: event.memberName,
    createTime: Math.floor(detectedAtMs / 1000),
    sessionId: event.roomId
  }
}

/**
 * 把退群事件合并进档案消息流，按时间升序排列（与 `MessageList` 的预期一致）。
 *
 * 已存在的同 id 消息不重复插入，所以重复调用是幂等的 ——
 * `getState` 会随着广播反复刷新，没有这层去重就会越插越多。
 */
export function mergeGroupExitEvents(
  messages: Message[],
  events: GroupExitMonitorEvent[]
): Message[] {
  const existingIds = new Set(messages.map((message) => message.id))
  const extra = events
    .map(toGroupExitEventMessage)
    .filter((message) => !existingIds.has(message.id))
  if (!extra.length) return messages

  const combined = [...messages, ...extra]
  combined.sort((a, b) => {
    const left = Number(a.createTime) || 0
    const right = Number(b.createTime) || 0
    if (left !== right) return left - right
    // 同一秒内保持输入顺序稳定，避免每次渲染都抖动。
    return 0
  })
  return combined
}
