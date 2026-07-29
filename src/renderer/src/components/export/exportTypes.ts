import type { Contact, Message } from '../../../../shared/types'
import type {
  ExportJobProgress,
  ExportMessageKind,
  ExportNameMode,
  ExportRequest,
  ExportResult,
  ExportTaskRecord
} from '../../../../shared/export'

export type ExportRange = 'today' | 'threeDays' | 'sevenDays' | 'custom'
export type ExportFormat = 'html' | 'csv' | 'json' | 'markdown'
export type ExportStatus = 'idle' | 'running' | 'completed'

export interface GroupMemberName {
  wxid: string
  nickname: string
  groupNickname: string
  wechatNickname: string
  remark: string
  avatar: string
}

export interface SelfInfo {
  wxid: string
  nickname: string
  avatar?: string
  accountRoot: string
}

export interface ExportWorkspaceProps {
  contacts: Contact[]
  selectedContact: Contact | null
  previewMessages: Message[]
  selfInfo: SelfInfo | null
  dbReady: boolean
  onSelectContact: (contact: Contact) => void
  onOpenSettings: () => void
  exportTasks: ExportTaskRecord[]
  onStartExport: (request: ExportRequest) => Promise<ExportResult>
  onCancelExport: (jobId: string) => Promise<void>
}

export type { Contact, ExportJobProgress, ExportMessageKind, Message, ExportNameMode, ExportTaskRecord }
