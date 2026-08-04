import React from 'react'
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
  writing: '导出资源',
  compressing: '压缩归档',
  completed: '已完成',
  cancelled: '已取消',
  failed: '导出失败'
}

const taskDetail = (task: ExportTaskRecord): string | null => {
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
  return (
    <>
      <button type="button" className="export-task-center-button" onClick={onToggle}>
        任务中心{taskCount > 0 ? ` (${taskCount})` : ''}
      </button>
      {open && (
        <section className="export-task-center">
          <div className="export-section-heading">
            <h3>导出任务</h3>
            <span>{tasks.length} 条记录</span>
          </div>
          {tasks.length === 0 ? (
            <p>暂无导出记录</p>
          ) : (
            tasks.map((task) => {
              const detail = taskDetail(task)
              return (
                <div className="export-task-row" key={task.jobId}>
                  <span>
                    <strong>{task.targetLabel}</strong>
                    <small>
                      {task.format.toUpperCase()} · {phaseLabels[task.progress.phase]}
                    </small>
                    {detail && (
                      <small
                        className={`export-task-detail ${task.status}`}
                        title={task.status === 'failed' ? detail : undefined}
                      >
                        {detail}
                      </small>
                    )}
                  </span>
                  <span className="export-task-progress">
                    <i style={{ width: `${task.progress.percent ?? 0}%` }} />
                    <b>{task.progress.percent ?? 0}%</b>
                  </span>
                  {task.status === 'running' && (
                    <button type="button" onClick={() => onCancel(task.jobId)}>
                      取消
                    </button>
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
