import * as React from 'react'

import { Button, Spinner, Switch } from '../../components/ui'
import type { ScheduledReportTask } from '../../../../shared/scheduled-report'
import {
  formatNextRunAt,
  scheduledReportRangeLabel,
  scheduledReportTemplateLabel
} from './model/scheduled-report-preview'

/**
 * ScheduledReportRuleList —— 「自动化 → 规则 → 定时日报」的**规则列表**。
 *
 * 为什么这里是列表而不是直接进编辑器：定时日报是**多条**规则
 * （与 singleton 的「退群通知」不同），所以必须先选一条，或新建一条。
 *
 * 所有写操作（立即执行 / 启停 / 删除）都不落盘，只提示。
 * 数据是**只读**拿到的真实任务（见 `model/scheduled-report-preview.ts`）。
 */

export interface ScheduledReportRuleListProps {
  tasks: ScheduledReportTask[]
  loading: boolean
  /** 正在"操作中"的任务 id（仅用于视觉反馈，不产生真实副作用）。 */
  busyTaskId: string | null
  /**
   * 群标识 → 显示名。
   *
   * 任务里存的可能是群名、room id 或 hash；列表**绝不能**把内部标识露给用户。
   */
  resolveGroupDisplay: (raw: string) => string
  onCreate: () => void
  onEdit: (task: ScheduledReportTask) => void
  onRunNow: (task: ScheduledReportTask) => void
  onToggle: (task: ScheduledReportTask, enabled: boolean) => void
  onDelete: (task: ScheduledReportTask) => void
}

export function ScheduledReportRuleList({
  tasks,
  loading,
  busyTaskId,
  resolveGroupDisplay,
  onCreate,
  onEdit,
  onRunNow,
  onToggle,
  onDelete
}: ScheduledReportRuleListProps): React.ReactElement {
  const runningCount = tasks.filter((task) => task.enabled).length

  return (
    <div className="automation-rule-list">
      <section className="automation-rule-group">
        <div className="automation-section-heading">
          <h2>定时日报</h2>
          <span className="automation-section-note">
            {tasks.length > 0 ? `${tasks.length} 条规则` : '尚未配置'}
          </span>
        </div>

        <p className="automation-section-lead">
          按设定时间自动生成日报，并发送到指定微信会话。
        </p>

        <div className="automation-scheduled-toolbar">
          <Button onClick={onCreate}>+ 新建定时日报</Button>
          {tasks.length > 0 ? (
            <span className="automation-section-note">
              运行中 {runningCount} / {tasks.length}
            </span>
          ) : null}
        </div>

        {loading ? (
          <div className="automation-loading">
            <Spinner />
            <span>正在读取定时日报…</span>
          </div>
        ) : tasks.length === 0 ? (
          <div className="automation-empty-card">
            <p>还没有定时日报</p>
            <p>创建一条自动化，让 TraceMemo 在指定时间生成并发送日报。</p>
            <Button onClick={onCreate}>+ 新建定时日报</Button>
          </div>
        ) : (
          tasks.map((task) => (
            <article
              key={task.id}
              className={`automation-rule-card ${task.enabled ? '' : 'disabled'}`}
            >
              <div className="automation-rule-card-main">
                <div className="automation-rule-card-title">
                  <h3>{task.name}</h3>
                  {/* 状态只出现两处：这个 badge + 右侧 toggle，不做第三重表达。 */}
                  <span className={`automation-rule-state ${task.enabled ? 'on' : 'off'}`}>
                    {task.enabled ? '运行中' : '已暂停'}
                  </span>
                </div>
                <dl className="automation-rule-meta">
                  <div>
                    <dt>触发</dt>
                    <dd>每天 {task.scheduleTime}</dd>
                  </div>
                  <div>
                    <dt>日报</dt>
                    <dd>{scheduledReportRangeLabel(task.reportRange)}</dd>
                  </div>
                  <div>
                    <dt>来源</dt>
                    <dd>{resolveGroupDisplay(task.group) || '未设置'}</dd>
                  </div>
                  <div>
                    <dt>模板</dt>
                    <dd>{scheduledReportTemplateLabel(task.templateId)}</dd>
                  </div>
                  <div>
                    <dt>发送到</dt>
                    {/* 旧任务的 target 恒等于来源群；这时用语义文案比重复群名清楚。 */}
                    <dd>
                      {!task.target || task.target === task.group
                        ? '日报来源群'
                        : resolveGroupDisplay(task.target)}
                    </dd>
                  </div>
                  <div>
                    <dt>下次执行</dt>
                    <dd>{task.enabled ? formatNextRunAt(task.nextRunAt) : '—'}</dd>
                  </div>
                </dl>
              </div>
              <div className="automation-rule-card-side">
                <Switch
                  checked={task.enabled}
                  disabled={busyTaskId === task.id}
                  onCheckedChange={(checked) => onToggle(task, checked)}
                  aria-label={`${task.name} 启停`}
                />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busyTaskId === task.id}
                  onClick={() => onRunNow(task)}
                >
                  立即执行
                </Button>
                <Button variant="outline" size="sm" onClick={() => onEdit(task)}>
                  编辑
                </Button>
                <Button variant="link" size="sm" onClick={() => onDelete(task)}>
                  删除
                </Button>
              </div>
            </article>
          ))
        )}
      </section>
    </div>
  )
}
