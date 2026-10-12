import type {
  GroupDailyReport,
  GroupReportMetadata,
  GroupReportRenderSnapshot
} from './group-report'
import type { ReportTemplateSelectionId } from './report-templates'
import type { ReportTemplateRef } from './report-template-package'

export type ReportAssetStatus = 'ready' | 'missing'
/**
 * 日报的产出方式。
 *
 * - `manual`：用户在日报页手动生成；
 * - `scheduled`：定时日报（自动化里的时间驱动规则）；
 * - `automation`：消息型自动化「@我生成日报」触发产出。
 *
 * 三种都写进**同一条日报历史**（`report-history-service` 是唯一出口），
 * 这个字段只用于区分「谁触发的」，不参与任何可见性判断。
 */
export type GeneratedReportSource = 'manual' | 'scheduled' | 'automation'

export interface GeneratedReportRecord {
  id: string
  contactId: string
  contactName: string
  contactAvatar?: string
  source?: GeneratedReportSource
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
  templateId?: ReportTemplateSelectionId
}

export interface SaveGeneratedReportRequest {
  contactId: string
  contactName: string
  contactAvatar?: string
  source?: GeneratedReportSource
  dateRange: string
  messageCount: number
  generatedAt: string
  /** 实际覆盖的本地日期；缺省时由 generatedAt 推导。 */
  reportDate?: string
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
  templateId?: ReportTemplateSelectionId
}

export interface UpdateGeneratedReportTemplateRequest {
  reportId: string
  templateId: ReportTemplateSelectionId
  templateRef?: ReportTemplateRef
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
