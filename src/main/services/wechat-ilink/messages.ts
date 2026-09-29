import {
  ILINK_ITEM_TYPE_TEXT,
  type ILinkMessageItem,
  type ILinkWeixinMessage,
  type WechatInboundItem,
  type WechatInboundMessage
} from './types'

/**
 * 把协议原始消息归一化成 Agent Hub 消费的形状。
 *
 * 关键点是 `context_token` **必须完整透传**：它属于会话上下文，
 * 回复同一个会话时要原样回传，缺失会导致回复落到错误的会话线程。
 */
export function normalizeInboundMessage(
  accountId: string,
  raw: ILinkWeixinMessage
): WechatInboundMessage | undefined {
  const fromUserId = String(raw.from_user_id ?? '').trim()
  if (!fromUserId) return undefined

  const items: WechatInboundItem[] = (raw.item_list ?? []).map((item) => {
    const normalized: WechatInboundItem = { type: Number(item.type ?? 0) }
    const text = itemText(item)
    if (text) normalized.text = text
    return normalized
  })

  const message: WechatInboundMessage = {
    accountId,
    fromUserId,
    messageId:
      raw.message_id !== undefined && raw.message_id !== null ? String(raw.message_id) : '',
    messageType: Number(raw.message_type ?? 0),
    items,
    receivedAt: Date.now()
  }
  if (raw.seq !== undefined && raw.seq !== null) message.seq = Number(raw.seq)
  const sessionId = String(raw.session_id ?? '').trim()
  if (sessionId) message.sessionId = sessionId
  const groupId = String(raw.group_id ?? '').trim()
  if (groupId) message.groupId = groupId
  const contextToken = String(raw.context_token ?? '').trim()
  if (contextToken) message.contextToken = contextToken
  return message
}

function itemText(item: ILinkMessageItem): string {
  const direct = String(item.text_item?.text ?? '').trim()
  if (direct) return direct
  // 语音条目的 text 是微信侧语音转文字结果，保留以便上层按需使用。
  return String(item.voice_item?.text ?? '').trim()
}

/** 拼接入站消息中的文本片段：只有类型为「文本」的条目参与拼接。 */
export function extractInboundText(items: WechatInboundItem[] | undefined): string {
  return (items ?? [])
    .filter((item) => item.type === ILINK_ITEM_TYPE_TEXT && item.text?.trim())
    .map((item) => item.text!.trim())
    .join(' ')
}
