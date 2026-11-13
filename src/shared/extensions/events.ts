import type { ExtensionMessageType, ExtensionSubscriptions } from './manifest'

/**
 * 投递给扩展的规范化消息事件。
 *
 * **字段契约**
 * - `timestamp` 是 **epoch 毫秒**（MessageListener 内部是 epoch 秒，换算只在主进程做一次）。
 * - `eventId` 对同一条微信消息稳定：`message:<sha1(sessionId:localId)>`，
 *   扩展重启、后台补投都拿到同一个值，可直接用于幂等。
 * - `text` 只在可安全还原为纯文本时出现；图片 / 语音 / 视频等不带正文。
 */
export interface ExtensionMessageEvent {
  eventId: string
  accountId: string
  conversationId: string
  messageId: string
  senderId?: string
  senderName?: string
  isGroup: boolean
  isSelf: boolean
  type: ExtensionMessageType
  text?: string
  /** 真正 @ 到当前登录账号（来自 `atuserlist` ∩ 自身 username），不是正文里的 `@昵称`。 */
  mentionsMe: boolean
  timestamp: number
}

/** 事件协议版本。未来的持久化队列 / 可靠投递必须保持向后兼容。 */
export const EXTENSION_EVENT_PROTOCOL_VERSION = 1

export interface ExtensionEventEnvelope {
  version: number
  kind: 'message.received'
  event: ExtensionMessageEvent
}

/**
 * 微信 `local_type` / `messageType` → 扩展侧消息类型。
 *
 * 未列出的类型归到 `other`：扩展宁可收到一个明确的 `other`，
 * 也不要因为宿主新增类型而静默收不到事件。
 */
export function mapWechatMessageType(messageType: number): ExtensionMessageType {
  switch (Number(messageType)) {
    case 1:
      return 'text'
    case 3:
      return 'image'
    case 34:
      return 'voice'
    case 43:
      return 'video'
    case 47:
      return 'sticker'
    case 49:
      return 'link'
    case 10000:
    case 10002:
      return 'system'
    default:
      return 'other'
  }
}

export interface BuildExtensionMessageEventInput {
  eventId: string
  accountId: string
  conversationId: string
  messageId: string
  senderId?: string
  senderName?: string
  isGroup: boolean
  isSelf: boolean
  messageType: number
  content?: string
  mentionsMe: boolean
  /** epoch 秒，与 MessageListener 同口径。 */
  createTimeSeconds: number
}

export function buildExtensionMessageEvent(
  input: BuildExtensionMessageEventInput
): ExtensionMessageEvent {
  const type = mapWechatMessageType(input.messageType)
  const text = type === 'text' ? String(input.content ?? '') : ''
  return {
    eventId: input.eventId,
    accountId: input.accountId,
    conversationId: input.conversationId,
    messageId: input.messageId,
    ...(input.senderId ? { senderId: input.senderId } : {}),
    ...(input.senderName ? { senderName: input.senderName } : {}),
    isGroup: input.isGroup,
    isSelf: input.isSelf,
    type,
    ...(text ? { text } : {}),
    mentionsMe: input.mentionsMe,
    timestamp: Math.round(input.createTimeSeconds * 1000)
  }
}

/**
 * manifest 级订阅过滤。
 *
 * 这一层只做「扩展作者声明过的粗筛」；用户级的开关是扩展的启用状态与权限授予，
 * 不在事件总线里再做第二套真相。
 */
export function shouldDeliverExtensionEvent(
  subscriptions: ExtensionSubscriptions | undefined,
  event: ExtensionMessageEvent
): boolean {
  if (!subscriptions) return false
  if (!subscriptions.includeSelf && event.isSelf) return false
  if (subscriptions.requireMentionMe && !event.mentionsMe) return false
  if (!subscriptions.messageTypes.includes(event.type)) return false
  if (
    subscriptions.conversationIds.length > 0 &&
    !subscriptions.conversationIds.includes(event.conversationId)
  ) {
    return false
  }
  return true
}
