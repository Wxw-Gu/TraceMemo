import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { GeneratedReportRecord } from './types'
import { ReportEmptyState } from './ReportEmptyState'
import { ReportToolbar } from './ReportToolbar'
import { ReportZoomBar } from './ReportZoomBar'
import type { SelectableReportTemplateId } from '../../../../shared/report-templates'
import { WechatShareCardDialog } from './WechatShareCardDialog'

interface ReportViewerProps {
  report: GeneratedReportRecord | null
  hasReports: boolean
  onBackToConfigure: () => void
  onRegenerate: () => void
  onCopyImage: (report: GeneratedReportRecord) => Promise<{ success: boolean; error?: string }>
  onReveal: (report: GeneratedReportRecord) => Promise<{ success: boolean; error?: string }>
  onSwitchTemplate: (
    report: GeneratedReportRecord,
    templateId: SelectableReportTemplateId
  ) => Promise<{ success: boolean; error?: string }>
}

const calculateFitZoom = (
  viewportWidth: number,
  viewportHeight: number,
  imageWidth: number,
  imageHeight: number
): number =>
  Math.min(
    1,
    Math.min(
      Math.max(1, viewportWidth - 44) / imageWidth,
      Math.max(1, viewportHeight - 44) / imageHeight
    )
  )

const normalizeFitZoom = (value: number): number =>
  Math.max(0.0001, Math.floor(value * 10_000) / 10_000)

export function ReportViewer({
  report,
  hasReports,
  onBackToConfigure,
  onRegenerate,
  onCopyImage,
  onReveal,
  onSwitchTemplate
}: ReportViewerProps): React.ReactElement {
  const [zoom, setZoom] = useState(1)
  const [fitZoom, setFitZoom] = useState(1)
  const [status, setStatus] = useState('')
  const [imageError, setImageError] = useState('')
  const [isSwitchingTemplate, setIsSwitchingTemplate] = useState(false)
  const [shareDialogOpen, setShareDialogOpen] = useState(false)
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null)
  const viewportRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setStatus('')
      setImageError('')
      setIsSwitchingTemplate(false)
      setShareDialogOpen(false)
      setZoom(1)
      setFitZoom(1)
      setNaturalSize(null)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [report?.id])

  const title = useMemo(() => (report ? `${report.contactName} 群聊日报` : 'AI 日报'), [report])

  const measureFitZoom = (): number | null => {
    const viewport = viewportRef.current
    if (!viewport || !naturalSize?.width || !naturalSize.height) return null
    return calculateFitZoom(
      viewport.clientWidth,
      viewport.clientHeight,
      naturalSize.width,
      naturalSize.height
    )
  }

  const fitPage = (): void => {
    const nextFitZoom = measureFitZoom()
    if (!nextFitZoom) return
    setFitZoom(normalizeFitZoom(nextFitZoom))
    setZoom(1)
  }

  const showActualSize = (): void => {
    if (!fitZoom) return
    setZoom(Math.min(64, Math.max(0.25, Number((1 / fitZoom).toFixed(4)))))
  }

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport || !naturalSize?.width || !naturalSize.height) return
    const updateFitZoom = (): void => {
      const nextFitZoom = calculateFitZoom(
        viewport.clientWidth,
        viewport.clientHeight,
        naturalSize.width,
        naturalSize.height
      )
      setFitZoom(normalizeFitZoom(nextFitZoom))
    }
    updateFitZoom()
    const observer = new ResizeObserver(updateFitZoom)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [naturalSize?.height, naturalSize?.width])

  const handleCopy = async (): Promise<void> => {
    if (!report) return
    const result = await onCopyImage(report)
    setStatus(result.success ? '图片已复制' : result.error || '复制图片失败')
  }

  const handleReveal = async (): Promise<void> => {
    if (!report) return
    const result = await onReveal(report)
    setStatus(result.success ? '已打开报告所在文件夹' : result.error || '打开文件夹失败')
  }

  const handleSwitchTemplate = async (templateId: SelectableReportTemplateId): Promise<void> => {
    if (!report || isSwitchingTemplate) return
    if (report.templateId === templateId) {
      setStatus('当前已是所选模板')
      return
    }
    setIsSwitchingTemplate(true)
    setStatus('正在使用已有日报数据切换模板…')
    try {
      const result = await onSwitchTemplate(report, templateId)
      setStatus(result.success ? '模板已切换，无需重新生成内容' : result.error || '模板切换失败')
    } finally {
      setIsSwitchingTemplate(false)
    }
  }

  if (!report) {
    return (
      <main className="report-viewer">
        <ReportEmptyState
          icon="spark"
          title={hasReports ? '选择一份历史日报' : 'AI日报'}
          message={
            hasReports
              ? '从左侧历史报告中选择一份日报，查看本地保存的长图和文件信息。'
              : '还没有生成过日报。选择一个群聊，让 AI 自动整理讨论重点、热点话题和重要消息。'
          }
          actionLabel="开始生成日报"
          onAction={onBackToConfigure}
        />
      </main>
    )
  }

  return (
    <main className="report-viewer">
      <header className="report-viewer-header">
        <div>
          <h1>{title}</h1>
          <p>
            {report.dateRange} · 基于 {report.messageCount} 条消息生成 · AI 生成内容，请核对重要信息
          </p>
        </div>
        <ReportToolbar
          canCopyImage={Boolean(report.generatedImage)}
          canReveal={Boolean(report.pngPath || report.htmlPath)}
          canShare={Boolean(report.pngPath)}
          canSwitchTemplate={Boolean(
            (report.reportSnapshot && report.reportMetadata) ||
            report.reportRenderSnapshot ||
            (report.htmlStatus === 'ready' && report.htmlPath)
          )}
          currentTemplateId={report.templateId}
          isSwitchingTemplate={isSwitchingTemplate}
          onSwitchTemplate={(templateId) => void handleSwitchTemplate(templateId)}
          onRegenerate={onRegenerate}
          onCopyImage={() => void handleCopy()}
          onReveal={() => void handleReveal()}
          onShare={() => setShareDialogOpen(true)}
        />
      </header>
      {status && <div className="report-viewer-status">{status}</div>}
      <div className="report-viewer-stage" ref={viewportRef}>
        {report.generatedImage && !imageError ? (
          <div className="report-canvas">
            <img
              src={report.generatedImage}
              alt={title}
              style={{
                width: naturalSize
                  ? `${Math.max(1, Math.round(naturalSize.width * fitZoom * zoom))}px`
                  : undefined
              }}
              onLoad={(event) => {
                const image = event.currentTarget
                const nextSize = {
                  width: image.naturalWidth,
                  height: image.naturalHeight
                }
                setNaturalSize(nextSize)
                const viewport = viewportRef.current
                if (viewport) {
                  const fittedZoom = calculateFitZoom(
                    viewport.clientWidth,
                    viewport.clientHeight,
                    nextSize.width,
                    nextSize.height
                  )
                  setFitZoom(normalizeFitZoom(fittedZoom))
                  setZoom(1)
                }
              }}
              onError={() => {
                setImageError('日报图片加载失败')
              }}
            />
          </div>
        ) : (
          <ReportEmptyState
            title={imageError || '暂无 PNG 预览'}
            message={
              report.htmlPath
                ? 'HTML 已保存，可以打开文件夹查看报告文件。'
                : '当前记录没有可预览的报告文件。'
            }
            actionLabel="返回配置"
            onAction={onBackToConfigure}
          />
        )}
      </div>
      <ReportZoomBar
        zoom={zoom}
        onZoomChange={setZoom}
        onFitPage={fitPage}
        onActualSize={showActualSize}
      />
      {shareDialogOpen && report.pngPath && (
        <WechatShareCardDialog
          pngPath={report.pngPath}
          initialTitle={`${report.contactName}日报 · ${report.reportDate}`}
          initialDescription={`基于 ${report.messageCount} 条群聊消息生成的 AI 日报`}
          onClose={() => setShareDialogOpen(false)}
        />
      )}
    </main>
  )
}
