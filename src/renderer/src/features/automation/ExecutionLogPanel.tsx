import * as React from 'react'
import type { AutomationExecution } from '../../../../shared/automation'
import { Button, Spinner } from '../../components/ui'
import { STEP_STATUS_LABELS, formatDuration, formatTriggerTime, stepStatusTone } from './model/format'

/**
 * ExecutionLogPanel —— 执行日志列表（对应 Stitch 设计稿 3 的左半部分）。
 *
 * 每行是一条**用户层**记录：时间 / 规则名 / 来源 / 结果 / 耗时 / 步骤轨迹。
 *
 * 刻意不展示 wxid、localId、serverId、source XML、原始 payload 与图片路径 ——
 * `AutomationExecution` 里本来就不带这些字段，这里也不允许从别处补。
 */

export interface ExecutionLogPanelProps {
  executions: AutomationExecution[]
  loading: boolean
  clearing: boolean
  onSelect: (execution: AutomationExecution) => void
  onClear: () => void
}

/** 把 5 个步骤压成一串小圆点，一眼能看出「卡在哪一步」。 */
function StepTrail({ execution }: { execution: AutomationExecution }): React.ReactElement {
  if (!execution.steps.length) {
    return <span className="automation-trail-empty">—</span>
  }
  return (
    <span className="automation-trail" aria-label="执行步骤">
      {execution.steps.map((step, index) => (
        <React.Fragment key={step.key}>
          {index > 0 ? <span className="automation-trail-link" aria-hidden="true" /> : null}
          <span
            className={`automation-trail-dot ${stepStatusTone(step.status)}`}
            title={`${step.label}：${STEP_STATUS_LABELS[step.status]}`}
            aria-label={`${step.label}：${STEP_STATUS_LABELS[step.status]}`}
            role="img"
          />
        </React.Fragment>
      ))}
    </span>
  )
}

export function ExecutionLogPanel({
  executions,
  loading,
  clearing,
  onSelect,
  onClear
}: ExecutionLogPanelProps): React.ReactElement {
  return (
    <div className="automation-log-panel">
      <div className="automation-section-heading">
        <h2>执行日志</h2>
        <div className="automation-log-heading-actions">
          <span className="automation-section-note">最近 {executions.length} 条</span>
          <Button
            variant="outline"
            size="sm"
            onClick={onClear}
            disabled={clearing || executions.length === 0}
          >
            {clearing ? '清空中…' : '清空记录'}
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="automation-loading">
          <Spinner />
          <span>正在读取执行记录…</span>
        </div>
      ) : executions.length === 0 ? (
        <div className="automation-empty-card">
          <p>暂无执行记录。</p>
          <small>规则命中并开始执行后，这里会留下完整的步骤轨迹。</small>
        </div>
      ) : (
        <div className="automation-log-table" role="table" aria-label="执行日志">
          <div className="automation-log-row head" role="row">
            <span role="columnheader">时间</span>
            <span role="columnheader">规则</span>
            <span role="columnheader">来源</span>
            <span role="columnheader">结果</span>
            <span role="columnheader">耗时</span>
            <span role="columnheader">步骤轨迹</span>
            <span role="columnheader" />
          </div>
          {executions.map((execution) => (
            <div key={execution.executionId} className="automation-log-row" role="row">
              <span role="cell" className="automation-log-time">
                {formatTriggerTime(execution.triggerTime)}
              </span>
              <span role="cell" className="automation-log-rule">
                {execution.ruleName}
              </span>
              <span role="cell" className="automation-log-source">
                {execution.sourceDisplayName}
              </span>
              <span role="cell">
                <span className={`automation-status-chip ${execution.status}`}>
                  {execution.status === 'success' ? '成功' : '失败'}
                </span>
              </span>
              <span role="cell" className="automation-log-duration">
                {formatDuration(execution.durationMs)}
              </span>
              <span role="cell">
                <StepTrail execution={execution} />
              </span>
              <span role="cell" className="automation-log-action">
                <Button variant="link" size="sm" onClick={() => onSelect(execution)}>
                  查看详情
                </Button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
