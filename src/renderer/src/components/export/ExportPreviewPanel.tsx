import React from 'react'
import type { Message } from './exportTypes'
import type { ExportJobProgress, ExportStatus, SelfInfo } from './exportTypes'
import { formatPreviewTime } from './exportUtils'

interface ExportPreviewPanelProps {
  status: ExportStatus
  previewItems: Message[]
  previewMediaCount: number
  previewBytes: number
  selfInfo: SelfInfo | null
  progress: ExportJobProgress | null
  includeVoiceTranscripts: boolean
  zip: boolean
  selectedCount: number
  allExport: boolean
  jobId: string
  onCancel: (jobId: string) => void
  onReveal: (path: string) => void
}

export function ExportPreviewPanel({
  status,
  previewItems,
  previewMediaCount,
  previewBytes,
  selfInfo,
  progress,
  includeVoiceTranscripts,
  zip,
  selectedCount,
  allExport,
  jobId,
  onCancel,
  onReveal
}: ExportPreviewPanelProps): React.ReactElement {
  const percent = Math.max(0, Math.min(100, progress?.percent ?? 0))
  const phase = progress?.phase || 'reading'
  const showTranscriptStep = includeVoiceTranscripts || phase === 'transcribing'
  const showZipStep = zip || phase === 'compressing'
  const steps = [
    { phase: 'reading', label: '分批读取聊天记录' },
    { phase: 'parsing', label: '解析消息内容' },
    ...(showTranscriptStep ? [{ phase: 'transcribing', label: '语音转文字' }] : []),
    { phase: 'media', label: '处理媒体资源' },
    { phase: 'writing', label: '生成档案' },
    ...(showZipStep ? [{ phase: 'compressing', label: '压缩 ZIP' }] : [])
  ]
  const currentStepIndex = Math.max(
    0,
    steps.findIndex((step) => step.phase === phase)
  )
  const indeterminate = phase === 'reading' && percent === 0
  const progressText =
    phase === 'compressing'
      ? `正在压缩资源包... ${percent}%`
      : phase === 'writing'
        ? `正在生成档案... ${percent}%`
        : phase === 'transcribing'
          ? `正在转写语音 ${progress?.processed ?? 0}/${progress?.total ?? 0}... ${percent}%`
          : phase === 'media'
            ? `正在处理媒体资源 ${progress?.processed ?? 0}/${progress?.total ?? 0}... ${percent}%`
            : phase === 'parsing'
              ? `正在解析消息内容... ${percent}%`
              : `正在读取消息... ${percent}%`
  const currentTargetText = progress?.currentTargetName
    ? `第 ${progress.currentTargetIndex || 1}/${progress.currentTargetCount || selectedCount} 个：${progress.currentTargetName}`
    : ''

  return (
    <aside className={`export-preview-panel ${status !== 'idle' ? `status-${status}` : ''}`}>
      {status === 'idle' && (
        <>
          <div className="export-preview-heading">
            <strong>导出预览</strong>
            <span>
              {allExport
                ? `${selectedCount} 个聊天 · 分目录导出`
                : selectedCount > 1
                  ? `${selectedCount} 个聊天 · 合并预览`
                  : '仅预览最近 20 条'}
            </span>
          </div>
          <div className="export-message-preview">
            <div className="export-preview-date">{allExport ? '全量归档' : '最近消息'}</div>
            {(allExport
              ? [
                  {
                    id: 'all-export',
                    from: 'system',
                    content: '每个聊天将保存为独立 HTML 档案',
                    type: '系统消息',
                    datetime: '',
                    isSender: false,
                    contentData: { type: 'system' as const, content: '全量归档' }
                  }
                ]
              : previewItems.length
                ? previewItems
                : [
                    {
                      id: 'empty',
                      from: 'user',
                      content: '导出预览将在这里显示',
                      type: '文字',
                      datetime: '',
                      isSender: false
                    }
                  ]
            ).map((message) => (
              <div
                key={`${message.exportConversationId || 'single'}:${message.id}`}
                className={`export-preview-message ${message.isSender ? 'mine' : ''} ${
                  message.contentData?.type === 'system' && message.contentData.pat ? 'system' : ''
                }`}
              >
                <span className="export-preview-avatar">
                  {message.img || (message.isSender && selfInfo?.avatar) ? (
                    <img src={message.img || selfInfo?.avatar} alt="" />
                  ) : (
                    (message.isSender ? '我' : message.name || '友').slice(0, 1)
                  )}
                </span>
                <span className="export-preview-bubble">
                  <small>
                    {selectedCount > 1 && message.exportConversationName
                      ? `${message.exportConversationName} · `
                      : ''}
                    {message.name || (message.isSender ? '我' : '联系人')} ·{' '}
                    {formatPreviewTime(message)}
                  </small>
                  {message.content || `[${message.type}]`}
                </span>
              </div>
            ))}
          </div>
          <div className="export-preview-stats export-preview-real-stats">
            <span>
              预览消息<strong>{previewItems.length}</strong>
            </span>
            <span>
              媒体预览<strong>{previewMediaCount}</strong>
            </span>
            <span>
              预估文本大小
              <strong>
                {previewBytes < 1024
                  ? `${previewBytes} B`
                  : `${(previewBytes / 1024).toFixed(1)} KB`}
              </strong>
            </span>
          </div>
          <div className="export-preview-stats">
            <span>
              消息总数<strong>待统计</strong>
            </span>
            <span>
              媒体文件<strong>待统计</strong>
            </span>
            <span>
              预计大小<strong>待统计</strong>
            </span>
          </div>
        </>
      )}
      {status === 'running' && (
        <div className="export-job-state">
          <h2>正在导出</h2>
          <p>导出任务在后台运行，不影响档案浏览。</p>
          {currentTargetText && (
            <div className="export-current-target">
              <span>{progress?.currentTargetType === 'group' ? '群聊' : '联系人'}</span>
              <strong>{currentTargetText}</strong>
            </div>
          )}
          <ol>
            <li className="done">准备导出</li>
            {steps.map((step, index) => (
              <li
                key={step.phase}
                className={
                  index < currentStepIndex ? 'done' : index === currentStepIndex ? 'current' : ''
                }
              >
                {step.label}
              </li>
            ))}
          </ol>
          <div
            className={`export-progress-bar ${indeterminate ? 'indeterminate' : ''}`}
            role="progressbar"
            aria-label="导出进度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={indeterminate ? undefined : percent}
            aria-valuetext={indeterminate ? '正在读取消息' : `${percent}%`}
          >
            <span style={indeterminate ? undefined : { width: `${percent}%` }} />
          </div>
          <strong>{progressText}</strong>
          <button type="button" className="export-cancel-button" onClick={() => onCancel(jobId)}>
            取消导出
          </button>
        </div>
      )}
      {status === 'completed' && (
        <div className="export-job-state completed">
          <div className="export-success-icon">✓</div>
          <h2>导出完成</h2>
          <p>聊天档案已成功保存。</p>
          <div className="export-complete-summary">
            <span>
              导出消息<strong>{progress?.processed.toLocaleString() || '已完成'}</strong>
            </span>
            <span>
              媒体资源<strong>按设置处理</strong>
            </span>
            <span>
              输出位置<strong>已保存</strong>
            </span>
          </div>
          <button
            type="button"
            className="export-primary-button"
            onClick={() => progress?.outputPath && onReveal(progress.outputPath)}
          >
            {allExport ? '打开导出目录' : '打开档案'}
          </button>
          <button
            type="button"
            className="export-open-folder-button"
            onClick={() => progress?.outputPath && onReveal(progress.outputPath)}
          >
            在文件夹中显示
          </button>
        </div>
      )}
    </aside>
  )
}
