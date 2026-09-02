import type { SelectableReportTemplateId } from './report-templates'

export type ScheduledReportRange = 'today' | 'yesterday' | '7days' | 'recent24h'
export type ScheduledReportMessageType =
  | 'text'
  | 'image'
  | 'sticker'
  | 'video'
  | 'voice'
  | 'share'
  | 'system'
export type ScheduledReportMemberNameMode = 'groupNickname' | 'wechatNickname' | 'remark'
export type ScheduledReportExecutionStatus =
  | 'running'
  | 'success'
  | 'waiting_to_send'
  | 'partial_success'
  | 'failed'
  | 'waiting_for_recovery'
  | 'skipped'

export type ScheduledReportExecutionStage =
  | 'precheck'
  | 'data'
  | 'ai'
  | 'report'
  | 'persist'
  | 'send'
  | 'notify'

export type ScheduledReportSendStatus = 'pending' | 'success' | 'failed' | 'unavailable'
export type ScheduledReportNotificationStatus =
  | 'pending'
  | 'sent'
  | 'failed'
  | 'not_needed'
  | 'suppressed'

export type ScheduledReportNotificationType = 'failure' | 'partial_success' | 'recovery'
export type ScheduledReportNotificationSeverity = 'info' | 'warning' | 'error'
export type ScheduledReportNotificationDeliveryStatus = 'pending' | 'sent' | 'failed' | 'suppressed'

export type ScheduledReportNotificationCapabilityReason =
  | 'agent_hub_offline'
  | 'connector_offline'
  | 'recipient_not_bound'
  | 'send_failed'
  | 'settings_persist_failed'

export interface ScheduledReportNotificationSettings {
  enabled: boolean
}

export interface ScheduledReportNotificationSettingsResult {
  success: boolean
  data: ScheduledReportNotificationSettings
  reason?: ScheduledReportNotificationCapabilityReason
  error?: string
}

export interface ScheduledReportNotificationCapability {
  ready: boolean
  recipient?: string
  reason?: ScheduledReportNotificationCapabilityReason
  error?: string
}

export interface ScheduledReportNotification {
  id: string
  executionId: string
  taskId: string
  type: ScheduledReportNotificationType
  severity: ScheduledReportNotificationSeverity
  title: string
  message: string
  dedupeKey: string
  channel: 'agent_hub'
  recipient?: string
  status: ScheduledReportNotificationDeliveryStatus
  createdAt: string
  sentAt?: string
  attempts: number
  lastError?: string
  suppressedAt?: string
}

export interface ScheduledReportTask {
  id: string
  name: string
  /** Human-readable group name or WeChat room id. */
  group: string
  scheduleTime: string
  reportRange: ScheduledReportRange
  messageTypes?: ScheduledReportMessageType[]
  templateId?: SelectableReportTemplateId
  memberNameMode?: ScheduledReportMemberNameMode
  timeoutSeconds?: number
  /** Current implementation targets one specified WeChat group. */
  target: string
  enabled: boolean
  createdAt: string
  updatedAt: string
  lastRunAt?: string
  nextRunAt: string
  /** Internal idempotency marker for a daily scheduled slot. */
  lastScheduledSlot?: string
}

export interface ScheduledReportExecution {
  id: string
  taskId: string
  /** Missing on old executions; normalized reads treat them as scheduled runs. */
  triggerType?: 'scheduled' | 'manual'
  startedAt: string
  finishedAt?: string
  status: ScheduledReportExecutionStatus
  error?: string
  message?: string
  scheduledSlot?: string
  currentStage?: ScheduledReportExecutionStage
  failedStage?: ScheduledReportExecutionStage
  errorCode?: string
  technicalMessage?: string
  userTitle?: string
  userMessage?: string
  suggestedAction?: string
  retryable?: boolean
  retryCount?: number
  reportId?: string
  htmlPath?: string
  pngPath?: string
  sendTarget?: string
  sendStatus?: ScheduledReportSendStatus
  sendError?: string
  notificationStatus?: ScheduledReportNotificationStatus
}

export interface ScheduledReportCreateInput {
  name: string
  group: string
  scheduleTime: string
  reportRange?: ScheduledReportRange
  messageTypes?: ScheduledReportMessageType[]
  templateId?: SelectableReportTemplateId
  memberNameMode?: ScheduledReportMemberNameMode
  timeoutSeconds?: number
  target?: string
  enabled?: boolean
}

export type ScheduledReportUpdateInput = Partial<
  Pick<
    ScheduledReportCreateInput,
    | 'name'
    | 'group'
    | 'scheduleTime'
    | 'reportRange'
    | 'messageTypes'
    | 'templateId'
    | 'memberNameMode'
    | 'timeoutSeconds'
    | 'target'
    | 'enabled'
  >
>

export interface ScheduledReportResult<T> {
  success: boolean
  data?: T
  error?: string
}
