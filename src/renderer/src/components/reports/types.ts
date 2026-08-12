import { Contact } from '../../../../shared/types'
export type {
  GeneratedReportRecord,
  ReportAssetStatus,
  ReportHistoryResult,
  SaveGeneratedReportRequest,
  SaveGeneratedReportResult,
  UpdateGeneratedReportTemplateRequest,
  UpdateGeneratedReportTemplateResult
} from '../../../../shared/report-history'

export type ReportWorkspaceView = 'configure' | 'result'

export const contactDisplayName = (contact: Contact | null): string =>
  contact?.m_nsNickName?.trim() || contact?.m_nsUsrName || '未命名群聊'
