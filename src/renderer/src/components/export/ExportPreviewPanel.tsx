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
  jobId,
  onCancel,
  onReveal
}: ExportPreviewPanelProps): React.ReactElement {
  return (
    <aside className={`export-preview-panel ${status !== 'idle' ? `status-${status}` : ''}`}>
      {status === 'idle' && (
        <>
          <div className="export-preview-heading">
            <strong>导出预览</strong>
            <span>仅预览最近 20 条</span>
          </div>
          <div className="export-message-preview">
            <div className="export-preview-date">最近消息</div>
            {(previewItems.length
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
                key={message.id}
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
          <ol>
            <li className="done">准备导出</li>
            <li className="current">
              {progress?.phase === 'writing' ? '生成档案' : '分批读取聊天记录'}
            </li>
            <li>解析消息内容</li>
            <li>处理媒体资源</li>
            <li>生成档案</li>
          </ol>
          <div className="export-progress-bar" aria-label="导出进度">
            <span style={{ width: `${progress?.percent ?? 0}%` }} />
          </div>
          <strong>
            {progress?.phase === 'writing'
              ? `正在写入 ${progress.processed.toLocaleString()} 条消息... ${progress.percent ?? 0}%`
              : `正在读取消息... ${progress?.percent ?? 0}%`}
          </strong>
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
            打开档案
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
