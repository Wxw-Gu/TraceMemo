import React from 'react'
import { Button, Progress } from '../ui'
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
    <aside className="export-preview-panel flex min-h-0 min-w-0 flex-col overflow-hidden border-l border-border max-[1100px]:hidden">
      {status === 'idle' && (
        <>
          <div className="flex h-[52px] shrink-0 items-center justify-between border-b border-border px-[18px] text-xs text-foreground">
            <strong className="font-semibold">导出预览</strong>
            <span className="text-[11px] text-muted-foreground">
              {allExport
                ? `${selectedCount} 个聊天 · 分目录导出`
                : selectedCount > 1
                  ? `${selectedCount} 个聊天 · 合并预览`
                  : '仅预览最近 20 条'}
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-3.5 py-4">
            <div className="mx-auto mb-[18px] w-fit rounded-full bg-muted px-2.5 py-1 text-[10px] text-muted-foreground">
              {allExport ? '全量归档' : '最近消息'}
            </div>
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
            ).map((message) => {
              const systemMessage = Boolean(
                message.contentData?.type === 'system' && message.contentData.pat
              )
              return (
                <div
                  key={`${message.exportConversationId || 'single'}:${message.id}`}
                  className={`mx-auto mb-[15px] flex w-full max-w-[620px] items-start gap-2 ${
                    message.isSender ? 'flex-row-reverse' : ''
                  } ${systemMessage ? 'justify-center' : ''}`}
                >
                  <span
                    className={`h-[30px] w-[30px] shrink-0 place-items-center overflow-hidden rounded-lg bg-primary/10 text-[11px] font-bold text-primary ${
                      systemMessage ? 'hidden' : 'grid'
                    }`}
                  >
                    {message.img || (message.isSender && selfInfo?.avatar) ? (
                      <img
                        className="h-full w-full object-cover"
                        src={message.img || selfInfo?.avatar}
                        alt=""
                      />
                    ) : (
                      (message.isSender ? '我' : message.name || '友').slice(0, 1)
                    )}
                  </span>
                  <span
                    className={`export-preview-bubble max-w-[78%] rounded-lg px-2.5 py-2 text-xs leading-[18px] text-foreground shadow-surface ${
                      systemMessage
                        ? 'max-w-[92%] bg-muted px-2.5 py-1 text-center text-[11px] text-muted-foreground shadow-none'
                        : message.isSender
                          ? 'bg-accent'
                          : 'bg-surface'
                    }`}
                  >
                    <small
                      className={`${systemMessage ? 'hidden' : 'mb-1 block'} text-[10px] text-muted-foreground`}
                    >
                      {selectedCount > 1 && message.exportConversationName
                        ? `${message.exportConversationName} · `
                        : ''}
                      {message.name || (message.isSender ? '我' : '联系人')} ·{' '}
                      {formatPreviewTime(message)}
                    </small>
                    {message.content || `[${message.type}]`}
                  </span>
                </div>
              )
            })}
          </div>
          <div className="grid shrink-0 gap-3 border-t border-border p-[18px]">
            <span className="flex justify-between text-xs text-muted-foreground">
              预览消息<strong>{previewItems.length}</strong>
            </span>
            <span className="flex justify-between text-xs text-muted-foreground">
              媒体预览<strong>{previewMediaCount}</strong>
            </span>
            <span className="flex justify-between text-xs text-muted-foreground">
              预估文本大小
              <strong className="font-semibold text-foreground">
                {previewBytes < 1024
                  ? `${previewBytes} B`
                  : `${(previewBytes / 1024).toFixed(1)} KB`}
              </strong>
            </span>
          </div>
        </>
      )}
      {status === 'running' && (
        <div className="grid h-full content-center gap-3 p-7 text-center">
          <h2 className="text-lg font-bold tracking-normal text-foreground">正在导出</h2>
          <p className="text-xs leading-[18px] text-muted-foreground">
            导出任务在后台运行，不影响档案浏览。
          </p>
          {currentTargetText && (
            <div className="my-1 grid gap-1 rounded-lg border border-border bg-surface p-3">
              <span className="text-[10px] text-muted-foreground">
                {progress?.currentTargetType === 'group' ? '群聊' : '联系人'}
              </span>
              <strong className="overflow-hidden text-ellipsis whitespace-nowrap text-xs text-foreground">
                {currentTargetText}
              </strong>
            </div>
          )}
          <ol className="my-2 grid list-none gap-2.5 p-0 text-left">
            <li className="done text-xs text-success before:mr-2 before:content-['✓']">准备导出</li>
            {steps.map((step, index) => (
              <li
                key={step.phase}
                className={`${
                  index < currentStepIndex
                    ? "done text-success before:content-['✓']"
                    : index === currentStepIndex
                      ? "current font-semibold text-foreground before:content-['●']"
                      : "text-muted-foreground before:content-['○']"
                } text-xs before:mr-2`}
              >
                {step.label}
              </li>
            ))}
          </ol>
          <Progress
            className="h-1.5"
            value={percent}
            indeterminate={indeterminate}
            aria-label="导出进度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={indeterminate ? undefined : percent}
            aria-valuetext={indeterminate ? '正在读取消息' : `${percent}%`}
          />
          <strong className="text-xs font-medium text-muted-foreground">{progressText}</strong>
          <Button variant="outline" onClick={() => onCancel(jobId)}>
            取消导出
          </Button>
        </div>
      )}
      {status === 'completed' && (
        <div className="grid h-full content-center gap-3 p-7 text-center">
          <div className="mx-auto grid h-[58px] w-[58px] place-items-center rounded-full border-[5px] border-primary/10 bg-surface text-3xl text-primary">
            ✓
          </div>
          <h2 className="text-lg font-bold tracking-normal text-foreground">导出完成</h2>
          <p className="text-xs text-muted-foreground">聊天档案已成功保存。</p>
          <div className="my-3 grid gap-3 rounded-lg bg-muted p-3.5 text-left">
            <span className="flex justify-between text-xs text-muted-foreground">
              导出消息
              <strong className="font-semibold text-foreground">
                {progress?.processed.toLocaleString() || '已完成'}
              </strong>
            </span>
            <span className="flex justify-between text-xs text-muted-foreground">
              媒体资源<strong className="font-semibold text-foreground">按设置处理</strong>
            </span>
            <span className="flex justify-between text-xs text-muted-foreground">
              输出位置<strong className="font-semibold text-foreground">已保存</strong>
            </span>
          </div>
          <Button onClick={() => progress?.outputPath && onReveal(progress.outputPath)}>
            {allExport ? '打开导出目录' : '打开档案'}
          </Button>
          <Button
            variant="outline"
            onClick={() => progress?.outputPath && onReveal(progress.outputPath)}
          >
            在文件夹中显示
          </Button>
        </div>
      )}
    </aside>
  )
}
