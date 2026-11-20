/**
 * Agent 任务的共享契约。
 *
 * 这些类型会同时出现在主进程、HTTP 响应与测试里，所以只放**可序列化**的字段，
 * 不放 provider 私有对象、不放开头、不放任何凭证。
 */

export type AgentTaskStatus =
  | 'queued'
  | 'submitting'
  | 'submitted'
  | 'completed'
  | 'failed'
  | 'timeout'
  | 'offline'
  | 'auth_failed'

export type AgentTaskErrorKind =
  | 'offline'
  | 'auth_missing'
  | 'auth_expired'
  | 'timeout'
  | 'http_error'
  | 'invalid_response'
  /** 提交过程中进程退出：无法确认远端是否已收到，**不允许重试**。 */
  | 'ambiguous_submission'
  | 'internal'

export type AgentTaskReplyRole = 'user' | 'assistant' | 'other'

export interface AgentTaskReply {
  messageId: string
  role: AgentTaskReplyRole
  text: string
  createdAt?: string
}

export interface AgentTaskRecord {
  id: string
  provider: string
  /** 触发任务的会话 md5（与 `messageRef.c` 同口径）。 */
  conversationId: string
  /** `${sessionId}:${localId}`：同一条微信消息只允许提交一次。 */
  triggerKey: string
  /** 去掉 `/ai` 前缀后的指令。 */
  prompt: string
  status: AgentTaskStatus
  /** epoch 毫秒。 */
  createdAt: number
  updatedAt: number
  submittedAt?: number
  completedAt?: number
  /** WorkBuddy `POST /openapi/v2/localassistant/message` 返回的 `message_id`。 */
  externalMessageId?: string
  /** 增量轮询的游标（最后一条已消费回复的 `message_id`）。 */
  lastReplyId?: string
  errorKind?: AgentTaskErrorKind
  errorMessage?: string
  replies: AgentTaskReply[]
}

/** 对外展示时使用的安全视图：不包含会话 username、wxid、凭证。 */
export interface AgentTaskView {
  id: string
  provider: string
  conversationId: string
  status: AgentTaskStatus
  prompt: string
  createdAt: number
  updatedAt: number
  submittedAt?: number
  completedAt?: number
  externalMessageId?: string
  errorKind?: AgentTaskErrorKind
  errorMessage?: string
  replies: AgentTaskReply[]
}
