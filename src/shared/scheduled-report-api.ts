import type { ScheduledReportRange, ScheduledReportExecution } from './scheduled-report'

export type ScheduledReportApiSchedule = {
  type: 'daily'
  time: string
}

export interface ScheduledReportApiGroupRef {
  talker?: string
  name?: string
}

export interface ScheduledReportApiTargetRef {
  type: 'wechat_group'
  talker?: string
  name?: string
}

export interface ScheduledReportApiTask {
  id: string
  name: string
  group: {
    talker: string
    name: string
  }
  schedule: ScheduledReportApiSchedule
  reportRange: ScheduledReportRange
  target: {
    type: 'wechat_group'
    talker: string
    name: string
  }
  enabled: boolean
  createdAt: string
  updatedAt: string
  lastRunAt?: string
  nextRunAt: string
}

export interface ScheduledReportApiCreateRequest {
  name?: string
  group: ScheduledReportApiGroupRef | string
  schedule: ScheduledReportApiSchedule
  reportRange?: ScheduledReportRange
  target?: ScheduledReportApiTargetRef
  enabled?: boolean
}

export interface ScheduledReportApiUpdateRequest {
  name?: string
  group?: ScheduledReportApiGroupRef | string
  schedule?: ScheduledReportApiSchedule
  reportRange?: ScheduledReportRange
  target?: ScheduledReportApiTargetRef
  enabled?: boolean
}

export type ScheduledReportApiExecution = ScheduledReportExecution
