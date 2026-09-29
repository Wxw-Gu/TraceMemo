import * as React from 'react'

import { Button, Spinner, Switch } from '../../components/ui'
import {
  calculateNextRunAt,
  normalizeScheduledReportConfig,
  type AutomationRule
} from '../../../../shared/automation'
import {
  formatNextRunAt,
  scheduledReportRangeLabel,
  scheduledReportTargetDisplayName,
  scheduledReportTemplateLabel
} from './model/scheduled-report-model'

/**
 * ScheduledReportRuleList —— 「自动化 → 规则 → 定时日报」的**规则列表**。
 *
 * 为什么这里是列表而不是直接进编辑器：定时日报是**多条**规则
 * （与 singleton 的「退群通知」不同），所以必须先选一条，或新建一条。
 *
 * 数据是 `AutomationRuleStore` 里的真实 `scheduled_report` 规则；
 * 立即执行 / 启停 / 删除全部**真写入**（由父层调 `automation:*` IPC）。
 *
 * `onBack` 是这一层**必须**有的逃生口：进了「定时日报」这一类型后，只有
 * 列表与编辑器两种形态，而列表本身没有「取消」——如果这里不给退出入口，
 * 用户唯一的出路就是切到别的规则类型 tab，再从那边的「取消」绕回来。
 */

export interface ScheduledReportRuleListProps {
  rules: AutomationRule[]
  loading: boolean
  /** 正在"操作中"的规则 id（视觉反馈，防止重复点击）。 */
  busyRuleId: string | null
  /** 群标识 → 显示名（**绝不**把内部标识露给用户）。 */
  resolveGroupDisplay: (raw: string) => string
  /** 退出本类型、回到规则面板（三个类型卡片那一层）。 */
  onBack?: () => void
  onCreate: () => void
  onEdit: (rule: AutomationRule) => void
  onRunNow: (rule: AutomationRule) => void
  onToggle: (rule: AutomationRule, enabled: boolean) => void
  onDelete: (rule: AutomationRule) => void
}

export function ScheduledReportRuleList({
  rules,
  loading,
  busyRuleId,
  resolveGroupDisplay,
  onBack,
  onCreate,
  onEdit,
  onRunNow,
  onToggle,
  onDelete
}: ScheduledReportRuleListProps): React.ReactElement {
  const runningCount = rules.filter((rule) => rule.enabled).length
  const now = new Date()

  return (
    <div className="automation-rule-list">
      {/* 没有 onBack 就不渲染死按钮：按钮点不动比没有按钮更糟。 */}
      {onBack ? (
        <button type="button" className="automation-editor-back" onClick={onBack}>
          ← 返回规则列表
        </button>
      ) : null}

      <section className="automation-rule-group">
        <div className="automation-section-heading">
          <h2>定时日报</h2>
          <span className="automation-section-note">
            {rules.length > 0 ? `${rules.length} 条规则` : '尚未配置'}
          </span>
        </div>

        <p className="automation-section-lead">
          按设定时间自动生成日报，并发送到指定微信会话。
        </p>

        <div className="automation-scheduled-toolbar">
          <Button onClick={onCreate}>+ 新建定时日报</Button>
          {rules.length > 0 ? (
            <span className="automation-section-note">
              运行中 {runningCount} / {rules.length}
            </span>
          ) : null}
        </div>

        {loading ? (
          <div className="automation-loading">
            <Spinner />
            <span>正在读取定时日报…</span>
          </div>
        ) : rules.length === 0 ? (
          <div className="automation-empty-card">
            <p>还没有定时日报</p>
            <p>创建一条自动化，让 TraceMemo 在指定时间生成并发送日报。</p>
            <Button onClick={onCreate}>+ 新建定时日报</Button>
          </div>
        ) : (
          rules.map((rule) => {
            const config = normalizeScheduledReportConfig(rule.scheduledReport)
            const needsReview = config.targetNeedsReview === true
            const busy = busyRuleId === rule.id
            return (
              <article
                key={rule.id}
                className={`automation-rule-card ${rule.enabled ? '' : 'disabled'}`}
              >
                <div className="automation-rule-card-main">
                  <div className="automation-rule-card-title">
                    <h3>{rule.name}</h3>
                    {/* 状态只出现两处：这个 badge + 右侧 toggle，不做第三重表达。 */}
                    <span className={`automation-rule-state ${rule.enabled ? 'on' : 'off'}`}>
                      {rule.enabled ? '运行中' : '已暂停'}
                    </span>
                  </div>
                  {needsReview ? (
                    // 迁移过来但目标无法无损映射：如实提示，绝不冒充"配置正常"。
                    <p className="automation-rule-warning" role="status">
                      这条规则的发送目标需要重新选择（迁移自旧版本，原目标无法自动对应）。
                      {config.legacyTarget ? (
                        <small>原来的目标：{config.legacyTarget}</small>
                      ) : null}
                    </p>
                  ) : null}
                  <dl className="automation-rule-meta">
                    <div>
                      <dt>触发</dt>
                      <dd>每天 {config.schedule.time}</dd>
                    </div>
                    <div>
                      <dt>日报</dt>
                      <dd>{scheduledReportRangeLabel(config.report.range)}</dd>
                    </div>
                    <div>
                      <dt>来源</dt>
                      <dd>{resolveGroupDisplay(config.report.sourceConversationId) || '未设置'}</dd>
                    </div>
                    <div>
                      <dt>模板</dt>
                      <dd>{scheduledReportTemplateLabel(config.report.templateId)}</dd>
                    </div>
                    <div>
                      <dt>发送到</dt>
                      <dd>{scheduledReportTargetDisplayName(config, resolveGroupDisplay)}</dd>
                    </div>
                    <div>
                      <dt>下次执行</dt>
                      <dd>
                        {rule.enabled && !needsReview
                          ? formatNextRunAt(calculateNextRunAt(config.schedule.time, now))
                          : '—'}
                      </dd>
                    </div>
                  </dl>
                </div>
                <div className="automation-rule-card-side">
                  <Switch
                    checked={rule.enabled}
                    disabled={busy}
                    onCheckedChange={(checked) => onToggle(rule, checked)}
                    aria-label={`${rule.name} 启停`}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || needsReview}
                    onClick={() => onRunNow(rule)}
                  >
                    立即执行
                  </Button>
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => onEdit(rule)}>
                    编辑
                  </Button>
                  <Button
                    variant="link"
                    size="sm"
                    disabled={busy}
                    onClick={() => onDelete(rule)}
                  >
                    删除
                  </Button>
                </div>
              </article>
            )
          })
        )}

        {/* 消息驱动的规则不在这里维护；显式说明，避免用户以为它消失了。 */}
        <p className="automation-section-footnote">
          消息驱动的「@我生成日报」规则在上一个类型里维护；这里只列出时间驱动的定时日报。
        </p>
      </section>
    </div>
  )
}
