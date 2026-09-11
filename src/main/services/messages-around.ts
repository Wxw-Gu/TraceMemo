import { normalizeMessageIdentity } from '../../shared/local-query-api'

/**
 * 「跳到原消息」的时间窗口规则。
 *
 * 抽成纯函数是因为它承载一条必须成立的性质：**锚点加载必须围绕 messageRef 的时间位置，
 * 不能退化成加载整段会话历史** —— 最大会话可达数十万条消息，整段读既慢又会挤爆 IPC。
 */
export const MESSAGES_AROUND_MAX_WINDOW = 2000

/** 默认锚点半径 6 小时；真实数据上时间窗口是稀疏的，±6h 的量级很小。 */
export const MESSAGES_AROUND_DEFAULT_RADIUS_SECONDS = 6 * 3600
export const MESSAGES_AROUND_MIN_RADIUS_SECONDS = 60
export const MESSAGES_AROUND_MAX_RADIUS_SECONDS = 24 * 3600
export const MESSAGES_AROUND_MAX_WIDEN_FACTOR = 12
export const MESSAGES_AROUND_MAX_WIDEN_SECONDS = 3 * 24 * 3600

export const normalizeRadiusSeconds = (radiusSeconds?: number): number =>
  Math.max(
    MESSAGES_AROUND_MIN_RADIUS_SECONDS,
    Math.min(radiusSeconds || MESSAGES_AROUND_DEFAULT_RADIUS_SECONDS, MESSAGES_AROUND_MAX_RADIUS_SECONDS)
  )

export const widenRadiusSeconds = (baseRadius: number): number =>
  Math.min(baseRadius * MESSAGES_AROUND_MAX_WIDEN_FACTOR, MESSAGES_AROUND_MAX_WIDEN_SECONDS)

/**
 * 需要尝试的半径列表。
 *
 * **没有时间锚点时返回空数组** —— 这不是"退化成一个半径为 0 的查询"。
 * 半径 0 会变成 `start=undefined / end=undefined`，也就是整段会话历史；
 * 调用方必须据此直接给出「已打开对应会话，但暂时无法定位原消息」的降级文案。
 */
export const messagesAroundRadii = (
  anchorSeconds: number | undefined,
  baseRadius: number,
  widenRadius: number
): number[] => (anchorSeconds && anchorSeconds > 0 ? [baseRadius, widenRadius] : [])

/** 有界窗口 + 精确身份定位。窗口按上限截断，绝不返回整段历史。 */
export const sliceMessagesAroundWindow = <T extends { id?: unknown }>(
  messages: T[],
  conversationId: string,
  targetMessageId: string,
  maxWindowMessages: number = MESSAGES_AROUND_MAX_WINDOW
): { window: T[]; index: number; truncated: boolean } => {
  const truncated = messages.length > maxWindowMessages
  const window = truncated ? messages.slice(0, maxWindowMessages) : messages
  const index = window.findIndex(
    (message) =>
      normalizeMessageIdentity(conversationId, String(message.id ?? ''))?.messageId === targetMessageId
  )
  return { window, index, truncated }
}
