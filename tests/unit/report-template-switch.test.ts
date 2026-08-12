import { describe, expect, it, vi } from 'vitest'
import type { GeneratedReportRecord } from '../../src/shared/report-history'
import { switchGeneratedReportTemplate } from '../../src/renderer/src/utils/report-template-switch'

const structuredReport = {
  id: 'report-1',
  contactId: 'group-1',
  contactName: '测试群',
  dateRange: '今天',
  messageCount: 10,
  generatedAt: '2026-08-12T10:00:00.000Z',
  reportDate: '2026-08-12',
  htmlStatus: 'ready',
  pngStatus: 'ready',
  templateId: 'mobile-feed',
  reportSnapshot: { overview: '已有内容' },
  reportMetadata: { groupName: '测试群' }
} as GeneratedReportRecord

describe('report template switching pipeline', () => {
  it('only exports the saved snapshot and updates the same history record', async () => {
    const api = {
      exportGroupReport: vi.fn(async () => ({
        success: true,
        imageDataUrl: 'data:image/png;base64,new',
        htmlPath: '/tmp/new.html',
        pngPath: '/tmp/new.png'
      })),
      exportGroupReportSnapshot: vi.fn(),
      prepareGeneratedReportTemplateSwitch: vi.fn(),
      updateGeneratedReportTemplate: vi.fn(async () => ({
        success: true,
        record: { ...structuredReport, templateId: 'mobile-dashboard' as const }
      }))
    }

    const result = await switchGeneratedReportTemplate(structuredReport, 'mobile-dashboard', api)

    expect(result.success).toBe(true)
    expect(api.exportGroupReport).toHaveBeenCalledTimes(1)
    expect(api.exportGroupReport).toHaveBeenCalledWith({
      report: structuredReport.reportSnapshot,
      metadata: structuredReport.reportMetadata,
      templateId: 'mobile-dashboard'
    })
    expect(api.updateGeneratedReportTemplate).toHaveBeenCalledWith({
      reportId: structuredReport.id,
      templateId: 'mobile-dashboard',
      generatedImage: 'data:image/png;base64,new',
      htmlPath: '/tmp/new.html',
      pngPath: '/tmp/new.png'
    })
  })

  it('switches an existing report back to the classic default without rerunning AI', async () => {
    const api = {
      exportGroupReport: vi.fn(async () => ({
        success: true,
        imageDataUrl: 'data:image/png;base64,classic',
        htmlPath: '/tmp/classic.html',
        pngPath: '/tmp/classic.png'
      })),
      exportGroupReportSnapshot: vi.fn(),
      prepareGeneratedReportTemplateSwitch: vi.fn(),
      updateGeneratedReportTemplate: vi.fn(async () => ({
        success: true,
        record: { ...structuredReport, templateId: 'v1' as const }
      }))
    }

    const result = await switchGeneratedReportTemplate(structuredReport, 'v1', api)

    expect(result.success).toBe(true)
    expect(api.exportGroupReport).toHaveBeenCalledWith({
      report: structuredReport.reportSnapshot,
      metadata: structuredReport.reportMetadata,
      templateId: 'v1'
    })
    expect(api.prepareGeneratedReportTemplateSwitch).not.toHaveBeenCalled()
    expect(api.updateGeneratedReportTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ reportId: structuredReport.id, templateId: 'v1' })
    )
  })

  it('migrates a legacy record from its saved HTML before switching', async () => {
    const api = {
      exportGroupReport: vi.fn(),
      exportGroupReportSnapshot: vi.fn(async () => ({
        success: true,
        imageDataUrl: 'data:image/png;base64,legacy-new',
        htmlPath: '/tmp/legacy-new.html',
        pngPath: '/tmp/legacy-new.png'
      })),
      prepareGeneratedReportTemplateSwitch: vi.fn(async () => ({
        success: true,
        snapshot: {
          groupName: '测试群',
          reportDate: '2026-08-12',
          values: { REPORT_TITLE: '测试群日报' }
        }
      })),
      updateGeneratedReportTemplate: vi.fn(async () => ({ success: true }))
    }
    const result = await switchGeneratedReportTemplate(
      { ...structuredReport, reportSnapshot: undefined, reportMetadata: undefined },
      'desktop-editorial',
      api
    )

    expect(result.success).toBe(true)
    expect(api.exportGroupReport).not.toHaveBeenCalled()
    expect(api.prepareGeneratedReportTemplateSwitch).toHaveBeenCalledWith('report-1')
    expect(api.exportGroupReportSnapshot).toHaveBeenCalledWith({
      snapshot: expect.objectContaining({ groupName: '测试群' }),
      templateId: 'desktop-editorial'
    })
  })

  it('does not call any pipeline step when a legacy record cannot be migrated', async () => {
    const api = {
      exportGroupReport: vi.fn(),
      exportGroupReportSnapshot: vi.fn(),
      prepareGeneratedReportTemplateSwitch: vi.fn(async () => ({
        success: false,
        error: '当前日报缺少 HTML 文件，无法迁移旧模板数据'
      })),
      updateGeneratedReportTemplate: vi.fn()
    }
    const result = await switchGeneratedReportTemplate(
      { ...structuredReport, reportSnapshot: undefined, reportMetadata: undefined },
      'desktop-editorial',
      api
    )

    expect(result).toEqual({ success: false, error: '当前日报缺少 HTML 文件，无法迁移旧模板数据' })
    expect(api.exportGroupReport).not.toHaveBeenCalled()
    expect(api.updateGeneratedReportTemplate).not.toHaveBeenCalled()
  })
})
