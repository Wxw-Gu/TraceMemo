import React, { useState } from 'react'
import type { GeneratedReportRecord } from './types'

interface ReportInfoPanelProps {
  report: GeneratedReportRecord | null
  onReveal: (report: GeneratedReportRecord) => Promise<{ success: boolean; error?: string }>
}

const formatGeneratedAt = (value: string): string => {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return value
  return date.toLocaleString('zh-CN', { hour12: false })
}

const formatDuration = (value?: number): string => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '暂不可用'
  return `${(value / 1000).toFixed(1)}s`
}

const formatFileSize = (value?: number): string => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '暂不可用'
  if (value < 1024) return `${value}B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}KB`
  return `${(value / 1024 / 1024).toFixed(1)}MB`
}

const formatImageSize = (report: GeneratedReportRecord): string => {
  if (!report.imageSize) return '暂不可用'
  return `${report.imageSize.width}×${report.imageSize.height}`
}

const formatToken = (value?: number): string =>
  typeof value === 'number' && Number.isFinite(value) ? String(value) : '暂不可用'

const modelLabel = (model?: string): string => {
  if (!model) return '暂不可用'
  if (model === 'deepseek-chat') return 'DeepSeek Chat'
  if (model === 'gpt-4o-mini') return 'GPT-4o Mini'
  if (model === 'gpt-4o') return 'GPT-4o'
  if (model === 'gpt-4-turbo') return 'GPT-4 Turbo'
  if (model === 'claude-3-5-sonnet-20240620') return 'Claude 3.5 Sonnet'
  if (model === 'moonshot-v1-8k') return 'Moonshot V1'
  return model
}

export function ReportInfoPanel({ report, onReveal }: ReportInfoPanelProps): React.ReactElement {
  const [copyStatus, setCopyStatus] = useState('')
  const [revealStatus, setRevealStatus] = useState('')
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

  const revealReport = async (): Promise<void> => {
    if (!report) return
    const result = await onReveal(report)
    setRevealStatus(result.success ? '已打开报告所在文件夹' : result.error || '打开文件夹失败')
  }

  return (
    <aside className="report-settings-panel report-info-panel">
      <header>
        <h2>报告信息</h2>
        <p>当前选中报告的本地资产状态</p>
      </header>

      {!report ? (
        <section className="report-settings-section">
          <h3>基础信息</h3>
          <p>尚未选择报告。</p>
        </section>
      ) : (
        <>
          <section className="report-settings-section">
            <h3>基础信息</h3>
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
              <div>
                <span>群聊名称</span>
                <b>{report.contactName}</b>
              </div>
            </div>
          </section>

          <section className="report-settings-section">
            <h3>AI 生成信息</h3>
            <div className="report-export-list">
              <div>
                <span>生成耗时</span>
                <b>{formatDuration(report.duration)}</b>
              </div>
              <div>
                <span>文字模型</span>
                <b>{modelLabel(report.textModelName || report.modelName)}</b>
              </div>
              <div>
                <span>图片模型</span>
                <b>{modelLabel(report.imageModelName)}</b>
              </div>
              <div>
                <span>Token 来源</span>
                <b>
                  {report.tokenUsage?.estimated
                    ? '估算'
                    : report.tokenUsage
                      ? 'API 返回'
                      : '暂不可用'}
                </b>
              </div>
              <div>
                <span>Token 输入</span>
                <b>{formatToken(report.tokenUsage?.input)}</b>
              </div>
              <div>
                <span>Token 输出</span>
                <b>{formatToken(report.tokenUsage?.output)}</b>
              </div>
              <div>
                <span>Token 总计</span>
                <b>{formatToken(report.tokenUsage?.total)}</b>
              </div>
            </div>
          </section>

          <section className="report-settings-section">
            <h3>文件信息</h3>
            <div className="report-export-list">
              <div>
                <span>PNG 尺寸</span>
                <b>{formatImageSize(report)}</b>
              </div>
              <div>
                <span>PNG 文件大小</span>
                <b>{formatFileSize(report.fileSize?.png)}</b>
              </div>
              <div>
                <span>HTML 文件大小</span>
                <b>{formatFileSize(report.fileSize?.html)}</b>
              </div>
              <div>
                <span>HTML 状态</span>
                <b>{report.htmlStatus === 'ready' ? '已保存' : '缺失'}</b>
              </div>
              <div>
                <span>PNG 状态</span>
                <b>{report.pngStatus === 'ready' ? '已保存' : '缺失'}</b>
              </div>
            </div>
            {(report.pngPath || report.htmlPath) && (
              <button type="button" onClick={() => void revealReport()}>
                打开文件夹
              </button>
            )}
            {revealStatus && <p>{revealStatus}</p>}
          </section>

          <section className="report-settings-section">
            <h3>生成日志</h3>
            {report.generationLogs?.length ? (
              <ol className="report-generation-log">
                {report.generationLogs.map((item) => (
                  <li key={`${item.startedAt}-${item.label}`}>
                    <span>✓</span>
                    <div>
                      <b>{item.label}</b>
                      <time>
                        {formatGeneratedAt(item.startedAt)} - {formatGeneratedAt(item.endedAt)}
                      </time>
                      <small>{formatDuration(item.duration)}</small>
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <p>暂不可用</p>
            )}
          </section>

          <section className="report-settings-section">
            <h3>文件路径</h3>
            {path ? (
              <>
                <code>{path}</code>
                <button type="button" onClick={() => void copyPath()}>
                  复制文件路径
                </button>
                {copyStatus && <p>{copyStatus}</p>}
              </>
            ) : (
              <p>当前报告缺少文件路径。</p>
            )}
          </section>
        </>
      )}

      <section className="report-settings-section muted">
        <h3>说明</h3>
        <p>删除历史日报只会删除本地生成报告，不会影响微信聊天记录。</p>
      </section>
    </aside>
  )
}
