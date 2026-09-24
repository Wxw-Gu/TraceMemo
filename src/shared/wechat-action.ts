export type WechatActionOrigin =
  /**
   * 退群监控历史发送用的来源。
   *
   * 迁移后**没有任何生产者**了（退群监控不再自己发送）。保留它只为两件事：
   * 让磁盘上的历史 audit 记录仍能正常显示，以及让类型仍是穷举的。
   */
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
  /** Automation（@我生成日报 / 退群通知）。与 `shared/automation.ts` 的 AUTOMATION_SEND_ORIGIN 一致。 */
  | 'automation'
  | 'unknown'
  | (string & {})

export type WechatActionPurpose =
  /**
   * 历史用途：退群监控自己发通知。
   *
   * 迁移后**没有任何生产者**，也已从 `AUTOMATION_PURPOSE_ALLOWLIST` 摘除 ——
   * 即"旧链路在代码上已经不可能再发出去"。保留类型成员只为让历史 audit 记录可读
   * （界面仍把它显示成「退群通知」）。
   */
  | 'member_left_notification'
  | 'scheduled_report'
  | 'tts_voice'
  /** 用户手动发送图片（日报图片 / 群成员统计图）。 */
  | 'manual_image'
  /** 用户手动发送文本。 */
  | 'manual_text'
  /** 用户确认后的日报图片；进入 automation 队列以复用 3 秒发送间隔。 */
  | 'manual_report_image'
  /** 日报图片成功后的后置词；只有图片 sent 后才会创建。 */
  | 'manual_report_postfix'
  /**
   * Automation 的三个用途。
   *
   * ⚠️ 这三个值必须同步登记进 `wechat-action-gateway.ts` 的
   * `AUTOMATION_PURPOSE_ALLOWLIST`，否则会被策略层以 `ACTION_NOT_ALLOWED` 拦下。
   * 与 `shared/automation.ts` 的 `AUTOMATION_SEND_PURPOSE` 保持一致。
   */
  | 'automation_reply'
  | 'automation_report'
  /** 退群通知（由 Automation 发出）。目标可以是群 / 自己 / 文件传输助手 / 指定好友。 */
  | 'automation_leave_notification'
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
