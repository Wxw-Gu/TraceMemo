import type { Message } from './types'

export type ExportFormat = 'html' | 'csv' | 'json' | 'markdown'
export type ExportMessageKind =
  | 'text'
  | 'image'
  | 'video'
  | 'voice'
  | 'sticker'
  | 'file'
  | 'share'
  | 'location'
  | 'system'

export type ExportNameMode = 'groupNickname' | 'remark' | 'wechatNickname'
export type ExportContactType = 'group' | 'user'

export interface ExportTarget {
  userMd5: string
  name: string
  type: 'user' | 'group'
  avatarUrl?: string
  nameMode?: ExportNameMode
  nameMap?: Record<string, string>
  avatarUrls?: Record<string, string>
}

export interface ExportRequest {
  jobId: string
  scope?: 'selected' | 'all'
  allContactTypes?: ExportContactType[]
  targets: ExportTarget[]
  format: ExportFormat
  outputName: string
  startTime?: number
  endTime?: number
  kinds: ExportMessageKind[]
  includeMedia: boolean
  includeVoiceTranscripts?: boolean
  preferOriginal?: boolean
  fallbackThumbnail?: boolean
  keepMissing?: boolean
  includeAvatars?: boolean
  zip?: boolean
}

export interface ExportJobProgress {
  jobId: string
  phase:
    | 'reading'
    | 'parsing'
    | 'media'
    | 'transcribing'
    | 'writing'
    | 'compressing'
    | 'completed'
    | 'cancelled'
    | 'failed'
  processed: number
  total?: number
  percent?: number
  outputPath?: string
  error?: string
  currentTargetIndex?: number
  currentTargetCount?: number
  currentTargetName?: string
  currentTargetType?: ExportContactType
}

export interface ExportTaskRecord {
  jobId: string
  scope?: 'selected' | 'all'
  allContactTypes?: ExportContactType[]
  targetIds: string[]
  targetNames: string[]
  targetLabel: string
  format: ExportFormat
  includeVoiceTranscripts?: boolean
  zip?: boolean
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
