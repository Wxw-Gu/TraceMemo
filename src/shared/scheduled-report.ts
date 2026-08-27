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
export type ScheduledReportExecutionStatus = 'running' | 'success' | 'failed'

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
  startedAt: string
  finishedAt?: string
  status: ScheduledReportExecutionStatus
  error?: string
  message?: string
  scheduledSlot?: string
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
