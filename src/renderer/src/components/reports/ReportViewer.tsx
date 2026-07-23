import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { GeneratedReportRecord } from './types'
import { ReportEmptyState } from './ReportEmptyState'
import { ReportToolbar } from './ReportToolbar'
import { ReportZoomBar } from './ReportZoomBar'

interface ReportViewerProps {
  report: GeneratedReportRecord | null
  hasReports: boolean
  onBackToConfigure: () => void
  onRegenerate: () => void
  onCopyImage: (report: GeneratedReportRecord) => Promise<{ success: boolean; error?: string }>
  onReveal: (report: GeneratedReportRecord) => Promise<{ success: boolean; error?: string }>
}

export function ReportViewer({
  report,
  hasReports,
  onBackToConfigure,
  onRegenerate,
  onCopyImage,
  onReveal
}: ReportViewerProps): React.ReactElement {
  const [zoom, setZoom] = useState(1)
  const [status, setStatus] = useState('')
  const [imageError, setImageError] = useState('')
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null)
  const viewportRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setStatus('')
      setImageError('')
      setZoom(1)
      setNaturalSize(null)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [report?.id])

  const title = useMemo(() => (report ? `${report.contactName} 群聊日报` : 'AI 日报'), [report])

  const fitWidth = (): void => {
    const viewport = viewportRef.current
    if (!viewport || !naturalSize?.width) return
    const nextZoom = Math.min(2, Math.max(0.25, (viewport.clientWidth - 48) / naturalSize.width))
    setZoom(Number(nextZoom.toFixed(2)))
  }

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
          onRegenerate={onRegenerate}
          onCopyImage={() => void handleCopy()}
          onReveal={() => void handleReveal()}
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
                width: naturalSize ? `${Math.round(naturalSize.width * zoom)}px` : undefined
              }}
              onLoad={(event) => {
                const image = event.currentTarget
                const nextSize = {
                  width: image.naturalWidth,
                  height: image.naturalHeight
                }
                setNaturalSize(nextSize)
                const viewport = viewportRef.current
                if (viewport && nextSize.width > viewport.clientWidth - 48) {
                  const fittedZoom = Math.max(0.25, (viewport.clientWidth - 48) / nextSize.width)
                  setZoom(Number(fittedZoom.toFixed(2)))
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
      <ReportZoomBar zoom={zoom} onZoomChange={setZoom} onFitWidth={fitWidth} />
    </main>
  )
}
