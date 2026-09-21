export type WechatActionOrigin =
  | 'member_monitor'
  | 'scheduled_report'
  | 'user_tts'
  /**
   * 用户在界面上**手动**触发的发送（发送日报图片、给群发统计文本等）。
   *
   * 立项规则：**所有发送都必须经过 `WechatActionGateway`**。手动发送在改造前是
   * 从 IPC 直连 `PersonalWechatSendService` 的，因此没有审计记录、没有幂等、
   * 也不进 Send Log —— 排查「消息到底发没发出去」时会缺一份证据。
   */
  | 'user_manual'
  /** Automation v1（@我生成日报）。与 `shared/automation.ts` 的 AUTOMATION_SEND_ORIGIN 一致。 */
  | 'automation'
  | 'unknown'
  | (string & {})

export type WechatActionPurpose =
  | 'member_left_notification'
  | 'scheduled_report'
  | 'tts_voice'
  /** 用户手动发送图片（日报图片 / 群成员统计图）。 */
  | 'manual_image'
  /** 用户手动发送文本。 */
  | 'manual_text'
  /**
   * Automation v1 的两个用途。
   *
   * ⚠️ 这两个值必须同步登记进 `wechat-action-gateway.ts` 的
   * `AUTOMATION_PURPOSE_ALLOWLIST`，否则会被策略层以 `ACTION_NOT_ALLOWED` 拦下。
   * 与 `shared/automation.ts` 的 `AUTOMATION_SEND_PURPOSE` 保持一致。
   */
  | 'automation_reply'
  | 'automation_report'
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
  recipientName?: string
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
