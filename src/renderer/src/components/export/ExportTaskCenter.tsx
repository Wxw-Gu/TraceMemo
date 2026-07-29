import React from 'react'
import type { ExportTaskRecord } from './exportTypes'

interface ExportTaskCenterProps {
  open: boolean
  taskCount: number
  tasks: ExportTaskRecord[]
  onToggle: () => void
  onCancel: (jobId: string) => void
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
            tasks.map((task) => (
              <div className="export-task-row" key={task.jobId}>
                <span>
                  <strong>{task.contactName}</strong>
                  <small>
                    {task.format.toUpperCase()} · {task.progress.phase}
                  </small>
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
            ))
          )}
        </section>
      )}
    </>
  )
}
