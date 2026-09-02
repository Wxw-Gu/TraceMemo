import React, { useState } from 'react'
import type { GeneratedReportRecord } from './types'
import { ReportExportStatus } from './ReportExportStatus'
import { Button } from '../ui'

interface ReportSettingsPanelProps {
  report: GeneratedReportRecord | null
  onReveal: (report: GeneratedReportRecord) => Promise<{ success: boolean; error?: string }>
}

const formatGeneratedAt = (value: string): string => {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return value
  return date.toLocaleString('zh-CN', { hour12: false })
}

export function ReportSettingsPanel({
  report,
  onReveal
}: ReportSettingsPanelProps): React.ReactElement {
  const [copyStatus, setCopyStatus] = useState('')
  const path = report?.pngPath || report?.htmlPath || ''

  const copyPath = async (): Promise<void> => {
    if (!path) return
    try {
      await navigator.clipboard.writeText(path)
      setCopyStatus('文件路径已复制')
    } catch (error) {
      setCopyStatus(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <aside className="report-settings-panel">
      <header>
        <h2>报告信息</h2>
        <p>当前选中报告的本地资产状态</p>
      </header>
      <section className="report-settings-section">
        <h3>生成信息</h3>
        {report ? (
          <div className="report-export-list">
            <div>
              <span>生成时间</span>
              <b>{formatGeneratedAt(report.generatedAt)}</b>
            </div>
            <div>
              <span>消息数量</span>
              <b>{report.messageCount} 条</b>
            </div>
            <div>
              <span>总结范围</span>
              <b>{report.dateRange}</b>
            </div>
          </div>
        ) : (
          <p>尚未选择报告。</p>
        )}
      </section>
      <ReportExportStatus report={report} onReveal={onReveal} />
      <section className="report-settings-section">
        <h3>文件路径</h3>
        {path ? (
          <>
            <code>{path}</code>
            <Button variant="outline" size="sm" onClick={() => void copyPath()}>
              复制文件路径
            </Button>
            {copyStatus && <p>{copyStatus}</p>}
          </>
        ) : (
          <p>当前报告缺少文件路径。</p>
        )}
      </section>
      <section className="report-settings-section muted">
        <h3>说明</h3>
        <p>删除历史日报只会删除本地生成报告，不会影响微信聊天记录。</p>
      </section>
    </aside>
  )
}
