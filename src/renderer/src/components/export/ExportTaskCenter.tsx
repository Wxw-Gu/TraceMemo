import React from 'react'
import { Button, Progress } from '../ui'
import type { ExportTaskRecord } from './exportTypes'

interface ExportTaskCenterProps {
  open: boolean
  taskCount: number
  tasks: ExportTaskRecord[]
  onToggle: () => void
  onCancel: (jobId: string) => void
}

const phaseLabels: Record<ExportTaskRecord['progress']['phase'], string> = {
  reading: '读取消息',
  parsing: '解析消息',
  media: '处理媒体',
  transcribing: '语音转文字',
  writing: '生成档案',
  compressing: '压缩归档',
  completed: '已完成',
  cancelled: '已取消',
  failed: '导出失败'
}

const taskDetail = (task: ExportTaskRecord): string | null => {
  if (task.status === 'running' && task.progress.currentTargetName) {
    return `第 ${task.progress.currentTargetIndex || 1}/${task.progress.currentTargetCount || '?'} 个：${task.progress.currentTargetName}`
  }
  if (task.status === 'completed') {
    return `成功导出 ${task.progress.total ?? task.progress.processed} 条消息`
  }
  if (task.status === 'failed') {
    return `失败原因：${task.progress.error || '未知错误'}`
  }
  return null
}

export function ExportTaskCenter({
  open,
  taskCount,
  tasks,
  onToggle,
  onCancel
}: ExportTaskCenterProps): React.ReactElement {
  const [copiedJobId, setCopiedJobId] = React.useState('')

  const copyTaskLog = async (task: ExportTaskRecord): Promise<void> => {
    const log = [
      'TraceMemo 导出任务日志',
      `时间：${new Date(task.createdAt).toLocaleString('zh-CN')}`,
      `会话：${task.targetLabel}`,
      `格式：${task.format.toUpperCase()}`,
      `状态：${task.progress.phase}`,
      `进度：${task.progress.percent ?? 0}%`,
      `当前聊天：${task.progress.currentTargetName || '未开始'}`,
      `错误：${task.progress.error || '未记录具体错误'}`
    ].join('\n')
    await navigator.clipboard.writeText(log)
    setCopiedJobId(task.jobId)
  }

  return (
    <>
      <Button className="mb-3 self-start" size="sm" variant="outline" onClick={onToggle}>
        任务中心{taskCount > 0 ? ` (${taskCount})` : ''}
      </Button>
      {open && (
        <section className="mb-[18px] rounded-lg border border-border bg-surface p-3">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-xs font-bold tracking-normal text-foreground">导出任务</h3>
            <span className="text-xs text-primary">{tasks.length} 条记录</span>
          </div>
          {tasks.length === 0 ? (
            <p className="mt-3 text-xs text-muted-foreground">暂无导出记录</p>
          ) : (
            tasks.map((task) => {
              const detail = taskDetail(task)
              return (
                <div
                  className="grid grid-cols-[minmax(0,1fr)_110px_auto] items-center gap-3 border-t border-border py-2 text-xs text-muted-foreground first:mt-2"
                  key={task.jobId}
                >
                  <span className="grid min-w-0 gap-0.5">
                    <strong className="overflow-hidden text-ellipsis whitespace-nowrap text-foreground">
                      {task.targetLabel}
                    </strong>
                    <small className="overflow-hidden text-ellipsis whitespace-nowrap">
                      {task.format.toUpperCase()} · {phaseLabels[task.progress.phase]}
                    </small>
                    {detail && (
                      <small
                        className={`export-task-detail ${task.status} whitespace-normal [overflow-wrap:anywhere] ${
                          task.status === 'completed'
                            ? 'text-primary'
                            : task.status === 'failed'
                              ? 'text-destructive'
                              : ''
                        }`}
                        title={task.status === 'failed' ? detail : undefined}
                      >
                        {detail}
                      </small>
                    )}
                  </span>
                  <span className="grid gap-1 text-right text-[10px] text-muted-foreground">
                    <Progress className="h-1.5" value={task.progress.percent ?? 0} />
                    <b className="font-medium">{task.progress.percent ?? 0}%</b>
                  </span>
                  {task.status === 'running' && (
                    <Button size="sm" variant="outline" onClick={() => onCancel(task.jobId)}>
                      取消
                    </Button>
                  )}
                  {task.status === 'failed' && (
                    <Button size="sm" variant="outline" onClick={() => void copyTaskLog(task)}>
                      {copiedJobId === task.jobId ? '已复制' : '复制日志'}
                    </Button>
                  )}
                </div>
              )
            })
          )}
        </section>
      )}
    </>
  )
}
