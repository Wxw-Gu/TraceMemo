import type {
  GroupDailyReport,
  GroupReportMetadata,
  GroupReportRenderSnapshot
} from './group-report'
import type { SelectableReportTemplateId } from './report-templates'

export type ReportAssetStatus = 'ready' | 'missing'

export interface GeneratedReportRecord {
  id: string
  contactId: string
  contactName: string
  contactAvatar?: string
  dateRange: string
  messageCount: number
  generatedAt: string
  reportDate: string
  htmlPath?: string
  pngPath?: string
  jsonPath?: string
  htmlStatus: ReportAssetStatus
  pngStatus: ReportAssetStatus
  generatedImage?: string
  imageSize?: {
    width: number
    height: number
  }
  duration?: number
  /** 文字总结模型；modelName 保留为旧记录兼容字段。 */
  textModelName?: string
  /** 图片理解模型。 */
  imageModelName?: string
  modelName?: string
  tokenUsage?: {
    input?: number
    output?: number
    total?: number
    estimated?: boolean
  }
  fileSize?: {
    html?: number
    png?: number
  }
  generationLogs?: {
    label: string
    startedAt: string
    endedAt: string
    duration: number
  }[]
  /** 新版报告保存结构化快照，模板切换时只重新渲染，不再调用 AI。 */
  reportSnapshot?: GroupDailyReport
  reportMetadata?: GroupReportMetadata
  reportRenderSnapshot?: GroupReportRenderSnapshot
  templateId?: SelectableReportTemplateId
}

export interface SaveGeneratedReportRequest {
  contactId: string
  contactName: string
  contactAvatar?: string
  dateRange: string
  messageCount: number
  generatedAt: string
  generatedImage?: string
  htmlPath?: string
  pngPath?: string
  duration?: number
  textModelName?: string
  imageModelName?: string
  modelName?: string
  tokenUsage?: {
    input?: number
    output?: number
    total?: number
    estimated?: boolean
  }
  generationLogs?: {
    label: string
    startedAt: string
    endedAt: string
    duration: number
  }[]
  reportSnapshot?: GroupDailyReport
  reportMetadata?: GroupReportMetadata
  templateId?: SelectableReportTemplateId
}

export interface UpdateGeneratedReportTemplateRequest {
  reportId: string
  templateId: SelectableReportTemplateId
  generatedImage?: string
  htmlPath?: string
  pngPath?: string
}

export interface PrepareGeneratedReportTemplateSwitchRequest {
  reportId: string
}

export interface PrepareGeneratedReportTemplateSwitchResult {
  success: boolean
  snapshot?: GroupReportRenderSnapshot
  error?: string
}

export interface ReportHistoryResult {
  success: boolean
  reports?: GeneratedReportRecord[]
  error?: string
}

export interface SaveGeneratedReportResult {
  success: boolean
  record?: GeneratedReportRecord
  error?: string
}

export type UpdateGeneratedReportTemplateResult = SaveGeneratedReportResult

export interface DeleteGeneratedReportResult {
  success: boolean
  deletedId?: string
  error?: string
}
