/**
 * 消息身份的**唯一真源**。
 *
 * 这个规则同时被三处需要：
 * - Knowledge 索引写入 `knowledge_messages.message_id`
 * - 图片文字索引的 binding（必须与 Knowledge 里的 message_id 完全一致，否则 OCR 文本贴不到消息上）
 * - Evidence → 档案跳转的 messageRef
 *
 * 任何一处各自复制一份，都会在 `local:` 前缀上静默失配（项目里已经有这个坑的历史注释），
 * 所以抽成一个模块，谁都不许再抄。
 */
import type * as chat from '../services/chat-service'

/**
 * 源消息 → 稳定消息 id。
 *
 * 降级顺序刻意保守：`localId` 是 WCDB 行内最稳的本地 id；其次用消息自带 id；
 * 最后才退化成「时间 + 服务端 id / 内容」的组合（仅在极端缺字段时命中）。
 */
export function sourceMessageId(message: chat.FormattedMessage): string {
  if (message.localId) return `local:${message.localId}`
  if (message.id) return String(message.id)
  return `${message.createTime || 0}:${message.serverId || message.content}`
}
