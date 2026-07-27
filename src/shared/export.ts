import type { Message } from './types'

export type ExportFormat = 'html' | 'csv' | 'json' | 'markdown'
export type ExportMessageKind =
  | 'text'
  | 'image'
  | 'video'
  | 'voice'
  | 'sticker'
  | 'share'
  | 'location'
  | 'system'

export type ExportNameMode = 'groupNickname' | 'remark' | 'wechatNickname'

export interface ExportRequest {
  jobId: string
  userMd5: string
  name: string
  format: ExportFormat
  outputName: string
  startTime?: number
  endTime?: number
  kinds: ExportMessageKind[]
  includeMedia: boolean
  includeAvatars?: boolean
  avatarUrls?: Record<string, string>
  nameMode?: ExportNameMode
  nameMap?: Record<string, string>
  zip?: boolean
}

export interface ExportJobProgress {
  jobId: string
  phase: 'reading' | 'writing' | 'completed' | 'cancelled' | 'failed'
  processed: number
  total?: number
  percent?: number
  outputPath?: string
  error?: string
}

export interface ExportTaskRecord {
  jobId: string
  contactId: string
  contactName: string
  format: ExportFormat
  status: 'running' | 'completed' | 'cancelled' | 'failed'
  progress: ExportJobProgress
  createdAt: number
}

export interface ExportResult {
  success: boolean
  outputPath?: string
  messageCount?: number
  error?: string
}
export type ExportRendererApi = {
  startExport: (request: ExportRequest) => Promise<ExportResult>
  cancelExport: (jobId: string) => Promise<{ success: boolean }>
  revealExport: (path: string) => Promise<{ success: boolean; error?: string }>
  onExportProgress: (callback: (progress: ExportJobProgress) => void) => () => void
}

export type ExportMessage = Message
