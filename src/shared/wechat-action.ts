export type WechatActionOrigin =
  | 'member_monitor'
  | 'scheduled_report'
  | 'user_tts'
  | 'unknown'
  | (string & {})

export type WechatActionPurpose =
  | 'member_left_notification'
  | 'scheduled_report'
  | 'tts_voice'
  | (string & {})

export type WechatActionTriggerType = 'automation' | 'user'

export interface WechatActionRecipient {
  type: 'group' | 'contact'
  id: string
  name?: string
}

export type WechatActionContent =
  | { type: 'text'; text: string }
  | { type: 'image'; path: string }
  | { type: 'voice'; path: string }

export interface WechatActionRequest {
  /** 可选的操作编号；未提供时会自动生成。 */
  id?: string
  /** 用于避免同一自动操作被重复执行的标识。 */
  idempotencyKey?: string
  origin: WechatActionOrigin
  purpose: WechatActionPurpose
  triggerType: WechatActionTriggerType
  sourceId?: string
  executionId?: string
  recipient: WechatActionRecipient
  content: WechatActionContent
  metadata?: Record<string, unknown>
}

export type WechatActionStatus = 'sent' | 'blocked' | 'failed'
export type WechatActionDecision = 'allow' | 'block'

export type WechatActionErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_RECIPIENT'
  | 'ACTION_NOT_ALLOWED'
  | 'RECIPIENT_SCOPE_VIOLATION'
  | 'SEND_CAPABILITY_UNAVAILABLE'
  | 'SEND_NOT_READY'
  | 'SEND_FAILED'
  | 'POLICY_BLOCKED'
  | 'UNKNOWN'
  | (string & {})

export interface WechatActionResult {
  actionId: string
  status: WechatActionStatus
  decision: WechatActionDecision
  errorCode?: WechatActionErrorCode
  reason?: string
  startedAt: string
  finishedAt: string
  sendResult?: unknown
}

export interface PolicyDecision {
  decision: 'allow' | 'block' | 'require_review'
  source: 'deterministic' | 'ai'
  reasonCode?: WechatActionErrorCode
  reason?: string
}

export interface WechatActionMemberEventReference {
  id: string
  roomId: string
}

export interface WechatActionAuditRecord {
  actionId: string
  idempotencyKey?: string
  origin: WechatActionOrigin
  purpose: WechatActionPurpose
  triggerType: WechatActionTriggerType
  sourceId?: string
  executionId?: string
  recipientType: WechatActionRecipient['type']
  recipientId: string
  contentType: WechatActionContent['type']
  contentPreview?: string
  contentHash?: string
  createdAt: string
  startedAt: string
  finishedAt: string
  decision: WechatActionDecision
  decisionReason?: string
  sendStatus: WechatActionStatus
  errorCode?: WechatActionErrorCode
}
