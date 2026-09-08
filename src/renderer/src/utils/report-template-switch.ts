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
import {
  decodeExternalReportTemplateId,
  type ReportTemplateRequestId,
  type ReportTemplateSelectionId
} from '../../../shared/report-templates'

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
  templateId: ReportTemplateSelectionId,
  api: ReportTemplateSwitchApi
): Promise<UpdateGeneratedReportTemplateResult> {
  const externalRef = decodeExternalReportTemplateId(templateId)
  const exportSelection = externalRef
    ? { templateRef: externalRef }
    : { templateId: templateId as ReportTemplateRequestId }
  let exported: GroupReportExportResult
  if (report.reportSnapshot && report.reportMetadata) {
    exported = await api.exportGroupReport({
      report: report.reportSnapshot,
      metadata: report.reportMetadata,
      ...exportSelection
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
      ...exportSelection
    })
  }
  if (!exported.success || !exported.imageDataUrl || !exported.htmlPath || !exported.pngPath) {
    return { success: false, error: exported.error || '新模板导出失败' }
  }

  return api.updateGeneratedReportTemplate({
    reportId: report.id,
    templateId,
    ...(externalRef ? { templateRef: externalRef } : {}),
    generatedImage: exported.imageDataUrl,
    htmlPath: exported.htmlPath,
    pngPath: exported.pngPath
  })
}
