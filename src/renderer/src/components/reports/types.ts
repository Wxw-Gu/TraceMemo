import { Contact } from '../../../../shared/types'
import { displayContactName } from '../../../../shared/contact-name'
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
  displayContactName(contact, '未命名群聊')
