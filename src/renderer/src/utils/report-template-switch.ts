import type {
  GroupReportExportRequest,
  GroupReportExportResult,
  GroupReportRenderSnapshotExportRequest
} from '../../../shared/group-report'
import type {
  GeneratedReportRecord,
  PrepareGeneratedReportTemplateSwitchResult,
  UpdateGeneratedReportTemplateRequest,
  UpdateGeneratedReportTemplateResult
} from '../../../shared/report-history'
import type { SelectableReportTemplateId } from '../../../shared/report-templates'

interface ReportTemplateSwitchApi {
  exportGroupReport: (request: GroupReportExportRequest) => Promise<GroupReportExportResult>
  exportGroupReportSnapshot: (
    request: GroupReportRenderSnapshotExportRequest
  ) => Promise<GroupReportExportResult>
  prepareGeneratedReportTemplateSwitch: (
    reportId: string
  ) => Promise<PrepareGeneratedReportTemplateSwitchResult>
  updateGeneratedReportTemplate: (
    request: UpdateGeneratedReportTemplateRequest
  ) => Promise<UpdateGeneratedReportTemplateResult>
}

export async function switchGeneratedReportTemplate(
  report: GeneratedReportRecord,
  templateId: SelectableReportTemplateId,
  api: ReportTemplateSwitchApi
): Promise<UpdateGeneratedReportTemplateResult> {
  let exported: GroupReportExportResult
  if (report.reportSnapshot && report.reportMetadata) {
    exported = await api.exportGroupReport({
      report: report.reportSnapshot,
      metadata: report.reportMetadata,
      templateId
    })
  } else {
    const prepared = await api.prepareGeneratedReportTemplateSwitch(report.id)
    if (!prepared.success || !prepared.snapshot) {
      return {
        success: false,
        error: prepared.error || '旧报告缺少可迁移的本地内容'
      }
    }
    exported = await api.exportGroupReportSnapshot({
      snapshot: prepared.snapshot,
      templateId
    })
  }
  if (!exported.success || !exported.imageDataUrl || !exported.htmlPath || !exported.pngPath) {
    return { success: false, error: exported.error || '新模板导出失败' }
  }

  return api.updateGeneratedReportTemplate({
    reportId: report.id,
    templateId,
    generatedImage: exported.imageDataUrl,
    htmlPath: exported.htmlPath,
    pngPath: exported.pngPath
  })
}
