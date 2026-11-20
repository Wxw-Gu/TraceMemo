/** 消息身份的唯一真源：Knowledge 索引、图片 OCR binding、messageRef 三处必须用同一份。 */
import type * as chat from '../services/chat-service'

/** localId 跨分片会重号，必须带上 create_time 才唯一；serverId 会被复用，不能当身份。 */
export function sourceMessageId(message: chat.FormattedMessage): string {
  if (message.localId) return `local:${message.createTime || 0}:${message.localId}`
  if (message.id) return String(message.id)
  return `${message.createTime || 0}:${message.serverId || message.content}`
}
