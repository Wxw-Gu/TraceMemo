import * as React from 'react'
import { AUTOMATION_EXECUTION_STATUS_LABELS } from '../../../../shared/automation'
import type { AutomationExecution } from '../../../../shared/automation'
import { Button } from '../../components/ui'
import {
  STEP_STATUS_LABELS,
  describeSkippedStep,
  formatClockTime,
  formatDuration,
  formatTriggerTime,
  stepStatusTone
} from './model/format'

/**
 * ExecutionDetailDrawer —— 执行详情抽屉（对应 Stitch 设计稿 3 的右半部分）。
 *
 * 用户来这里只想知道一件事：**到底坏在哪一步**。
 * 所以步骤列表是主体，每个失败步骤都要把原因写在脸上；
 * 「已跳过」的步骤还要说明是「上一步挂了」还是「规则本来就没配」。
 *
 * 抽屉而不是居中弹窗：详情是「从列表里钻进去看」，右侧抽屉保留了列表的位置感。
 */

export interface ExecutionDetailDrawerProps {
  execution: AutomationExecution | null
  onClose: () => void
}

export function ExecutionDetailDrawer({
  execution,
  onClose
}: ExecutionDetailDrawerProps): React.ReactElement | null {
  const open = execution !== null

  React.useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  if (!execution) return null

  return (
    <div className="automation-drawer-layer" role="presentation" onClick={onClose}>
      <aside
        className="automation-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="执行详情"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="automation-drawer-header">
          <div>
            <span className="automation-drawer-eyebrow">执行详情</span>
            <h2>{execution.ruleName}</h2>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            关闭
          </Button>
        </header>

        <div className="automation-drawer-body">
          <dl className="automation-detail-facts">
            <div>
              <dt>触发时间</dt>
              <dd>{formatTriggerTime(execution.triggerTime)}</dd>
            </div>
            <div>
              <dt>来源</dt>
              <dd>{execution.sourceDisplayName}</dd>
            </div>
            <div>
              <dt>结果</dt>
              <dd>
                <span className={`automation-status-chip ${execution.status}`}>
                  {AUTOMATION_EXECUTION_STATUS_LABELS[execution.status]}
                </span>
              </dd>
            </div>
            <div>
              <dt>总耗时</dt>
              <dd>{formatDuration(execution.durationMs)}</dd>
            </div>
          </dl>

          {execution.errorSummary ? (
            <p className="automation-detail-error">
              <strong>失败原因：</strong>
              {execution.errorSummary}
            </p>
          ) : null}

          <section className="automation-detail-steps">
            <h3>执行步骤</h3>
            {execution.steps.length === 0 ? (
              <p className="automation-detail-empty">
                本次执行没有产生步骤记录（可能在发送能力检查阶段就被拦下了）。
              </p>
            ) : (
              <ol className="automation-step-list">
                {execution.steps.map((step) => (
                  <li key={step.key} className={`automation-step ${stepStatusTone(step.status)}`}>
                    <span className="automation-step-marker" aria-hidden="true" />
                    <div className="automation-step-body">
                      <div className="automation-step-title">
                        <span className="automation-step-label">{step.label}</span>
                        <span className="automation-step-status">
                          {STEP_STATUS_LABELS[step.status]}
                        </span>
                      </div>
                      <div className="automation-step-meta">
                        {step.status === 'skipped' ? (
                          <span>{describeSkippedStep(step, execution.steps)}</span>
                        ) : (
                          <>
                            <span>{formatClockTime(step.startedAt)}</span>
                            <span className="automation-step-sep" aria-hidden="true">
                              →
                            </span>
                            <span>{formatClockTime(step.finishedAt)}</span>
                            <span className="automation-step-duration">
                              {formatDuration(step.durationMs)}
                            </span>
                          </>
                        )}
                      </div>
                      {step.error ? <p className="automation-step-error">{step.error}</p> : null}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      </aside>
    </div>
  )
}
