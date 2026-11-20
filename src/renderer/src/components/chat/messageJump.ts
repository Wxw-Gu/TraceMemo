import type { MessageGroupModel } from './messageGrouping'

/**
 * 证据 → 归档侧的定位结果。
 *
 * `messageId` 刻意返回**归档侧真实出现的 id**（而不是传入的 id）：
 * `MessageGroup` 的高亮是拿 `message.id` 直接比对的，返回归一化后的值会让
 * `local:` 前缀不同的情况静默失配 —— 表现为"跳过去了但没有高亮"。
 */
export interface MessageJumpTarget {
  groupIndex: number
  messageId?: string
  /** true = 按稳定身份精确命中；false = 退化到按时间戳找最近的一条。 */
  exact: boolean
}

/**
 * 证据侧是 `local:<create_time>:<local_id>`，归档侧只有 `local_id`：取最后一段，否则跳转全落空。
 */
export const normalizeJumpMessageId = (value: string | undefined | null): string => {
  const text = String(value ?? '').replace(/^local:/, '')
  const parts = text.split(':')
  return parts.length === 2 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1])
    ? parts[1]
    : text
}

/**
 * 解析跳转目标。
 *
 * 顺序（不能倒过来）：
 * 1. **稳定身份优先**：证据带 messageRef 时，落在哪一条就是哪一条。
 *    这是唯一能正确处理"同一秒多条消息"的方式 —— 秒级时间戳只能找到"附近"。
 * 2. 退化为按时间找第一条 `createTime >= jumpToTime` 的消息（老证据 / 无引用路径）。
 *    找不到（目标已被删除 / 清理）→ null，调用方必须给出诚实文案。
 */
export const resolveMessageJumpTarget = (
  groups: MessageGroupModel[],
  jumpToTime: number | null | undefined,
  jumpToMessageId: string | null | undefined
): MessageJumpTarget | null => {
  const wantedId = normalizeJumpMessageId(jumpToMessageId)
  if (wantedId) {
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
      const hit = groups[groupIndex].messages.find(
        (message) => normalizeJumpMessageId(message.id) === wantedId
      )
      if (hit) return { groupIndex, messageId: hit.id, exact: true }
    }
  }
  if (jumpToTime === undefined || jumpToTime === null) return null
  const groupIndex = groups.findIndex((group) =>
    group.messages.some((message) => (message.createTime || 0) >= jumpToTime)
  )
  if (groupIndex < 0) return null
  const message = groups[groupIndex].messages.find((item) => (item.createTime || 0) >= jumpToTime)
  return { groupIndex, messageId: message?.id, exact: false }
}
