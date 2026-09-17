/**
 * Agent Hub 对话记录（收发记录）。
 *
 * 这是**产品数据**，与「运行日志」明确分工：
 * - 运行日志（`agent-hub.log`）只记流程与故障，会脱敏，不保留完整正文；
 * - 对话记录保存完整收发内容，用于在应用内回看"机器人到底和谁说了什么"。
 *
 * 隐私边界：仅本机保存（`<userData>/agent-hub/conversations.json`，权限 0600），
 * 不上传任何服务商，也不写入日志。
 */

export type AgentHubMessageDirection = 'in' | 'out'

export type AgentHubMessageKind = 'text' | 'image' | 'voice' | 'file' | 'video' | 'system'

export type AgentHubMessageStatus = 'sent' | 'failed'

export interface AgentHubConversationMessage {
  id: string
  direction: AgentHubMessageDirection
  kind: AgentHubMessageKind
  /** 文本内容；媒体消息记录文件名或 URL，不记录二进制。 */
  text: string
  createdAt: number
  /** 仅出站消息有发送状态。 */
  status?: AgentHubMessageStatus
  /** 出站失败时的错误码（如 STALE_TOKEN / SEND_FAILED）。 */
  errorCode?: string
  /** 服务端 message_id：仅入站消息有，用于和日志对照。 */
  messageId?: string
}

export interface AgentHubConversation {
  /** 会话标识：入站为 from_user_id，出站为接收者 id。 */
  userId: string
  accountId?: string
  firstAt: number
  lastAt: number
  messages: AgentHubConversationMessage[]
}

export interface AgentHubConversationSummary {
  userId: string
  accountId?: string
  firstAt: number
  lastAt: number
  messageCount: number
  /** 列表里显示的最后一句话（已按 kind 处理，媒体显示成中文占位）。 */
  lastPreview: string
  lastDirection: AgentHubMessageDirection
}

export const AGENT_HUB_KIND_LABELS: Record<AgentHubMessageKind, string> = {
  text: '文字',
  image: '图片',
  voice: '语音',
  file: '文件',
  video: '视频',
  system: '系统消息'
}

/** 媒体类消息在列表 / 气泡里的占位文案。 */
export function agentHubKindPlaceholder(kind: AgentHubMessageKind): string {
  if (kind === 'text' || kind === 'system') return ''
  return `[${AGENT_HUB_KIND_LABELS[kind]}]`
}
