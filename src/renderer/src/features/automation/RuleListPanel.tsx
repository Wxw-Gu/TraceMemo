import * as React from 'react'
import {
  AUTOMATION_RULE_TEMPLATES,
  BUILTIN_LEAVE_NOTIFICATION_RULE_ID,
  describeLeaveNotificationTarget,
  describeMonitoredScope,
  describeRuleActions,
  describeRuleTrigger,
  type AutomationRule
} from '../../../../shared/automation'
import { Button, Spinner, Switch } from '../../components/ui'

/**
 * RuleListPanel —— 规则列表（「规则」tab）。
 *
 * 两个区块：
 * 1. **已配置的自动化** —— 全部是**真规则**，带启停开关；
 * 2. **模板入口** —— 尚未接通的能力必须**如实标注**为「即将支持」。
 *
 * 「退群通知」现在是真规则：状态按真实 rule 展示（运行中 / 已关闭 / 配置异常），
 * 不再有「待配置」「UI 预览」这类占位标识。
 */

export interface LeaveNotificationCardModel {
  rule: AutomationRule
  /** 真实已监控群聊数量（来自退群监控）。 */
  monitoredCount: number
  /** 「指定好友」目标的显示名；未选 / 不是该目标时为空串。 */
  contactName: string
}

/**
 * 定时日报在首页的**汇总卡**数据。
 *
 * 它是多条规则，不能像 singleton 那样当成一条展示（也不能给它一个启停开关）。
 */
export interface ScheduledReportCardModel {
  total: number
  running: number
  nextRunLabel: string
}

export interface RuleListPanelProps {
  rules: AutomationRule[]
  groups: Array<{ id: string; name: string }>
  loading: boolean
  busyRuleId: string | null
  leaveNotification: LeaveNotificationCardModel | null
  scheduledReport: ScheduledReportCardModel | null
  onToggle: (rule: AutomationRule, enabled: boolean) => void
  onEdit: (rule: AutomationRule) => void
  onDelete: (rule: AutomationRule) => void
  onCreate: () => void
  /** 打开「退群通知」规则类型。 */
  onEditLeaveNotification: () => void
  /** 打开「定时日报」规则类型（多条，所以是"管理"而不是"编辑"）。 */
  onManageScheduledReport: () => void
}

/** 把规则里的 conversationIds 翻成群名；找不到时显示占位而不是裸 id。 */
function scopeLabel(rule: AutomationRule, groups: Array<{ id: string; name: string }>): string {
  const selected = rule.conditions.conversationIds
  if (!selected.length) return '所有群聊'
  const names = selected
    .map((id) => groups.find((group) => group.id === id)?.name)
    .filter((name): name is string => Boolean(name))
  if (!names.length) return `已选 ${selected.length} 个群`
  if (names.length <= 2) return names.join('、')
  return `${names.slice(0, 2).join('、')} 等 ${names.length} 个群`
}

/**
 * 退群通知的真实状态。
 *
 * 「配置异常」只对应一种真实情况：迁移时旧「通知群聊」无法无损映射，
 * 规则被标成待重选目标 —— 这时它不会发送，需要用户处理。
 */
function leaveStatus(rule: AutomationRule): { label: string; tone: 'on' | 'off' | 'pending' } {
  if (rule.leaveNotification?.targetNeedsReview) return { label: '配置异常', tone: 'pending' }
  return rule.enabled ? { label: '运行中', tone: 'on' } : { label: '已关闭', tone: 'off' }
}

export function RuleListPanel({
  rules,
  groups,
  loading,
  busyRuleId,
  leaveNotification,
  scheduledReport,
  onToggle,
  onEdit,
  onDelete,
  onCreate,
  onEditLeaveNotification,
  onManageScheduledReport
}: RuleListPanelProps): React.ReactElement {
  // 退群通知有自己的卡片，别在「已配置的自动化」里重复渲染一遍。
  const configuredRules = rules.filter((rule) => rule.id !== BUILTIN_LEAVE_NOTIFICATION_RULE_ID)
  const leaveRule = leaveNotification?.rule ?? null
  const leaveState = leaveRule ? leaveStatus(leaveRule) : null
  const configuredCount = configuredRules.length + (leaveRule ? 1 : 0)

  return (
    <div className="automation-rule-list">
      <section className="automation-rule-group">
        <div className="automation-section-heading">
          <h2>已配置的自动化</h2>
          <span className="automation-section-note">{configuredCount} 条</span>
        </div>

        {loading ? (
          <div className="automation-loading">
            <Spinner />
            <span>正在读取规则…</span>
          </div>
        ) : (
          <>
            {!configuredRules.length && !leaveRule ? (
              <div className="automation-empty-card">
                <p>还没有任何自动化。</p>
                <Button onClick={onCreate}>新建自动化</Button>
              </div>
            ) : null}

            {configuredRules.map((rule) => (
              <article
                key={rule.id}
                className={`automation-rule-card ${rule.enabled ? '' : 'disabled'}`}
              >
                <div className="automation-rule-card-main">
                  <div className="automation-rule-card-title">
                    <h3>{rule.name}</h3>
                    <span className={`automation-rule-state ${rule.enabled ? 'on' : 'off'}`}>
                      {rule.enabled ? '运行中' : '已停用'}
                    </span>
                  </div>
                  <dl className="automation-rule-meta">
                    <div>
                      <dt>触发</dt>
                      <dd>{describeRuleTrigger(rule)}</dd>
                    </div>
                    <div>
                      <dt>范围</dt>
                      <dd>{scopeLabel(rule, groups)}</dd>
                    </div>
                    <div>
                      <dt>动作</dt>
                      <dd>{describeRuleActions(rule)}</dd>
                    </div>
                    <div>
                      <dt>间隔</dt>
                      <dd>{rule.cooldownSeconds > 0 ? `${rule.cooldownSeconds} 秒` : '不限制'}</dd>
                    </div>
                  </dl>
                </div>
                <div className="automation-rule-card-side">
                  <Switch
                    checked={rule.enabled}
                    disabled={busyRuleId === rule.id}
                    onCheckedChange={(checked) => onToggle(rule, checked)}
                    aria-label={`${rule.name} 启停`}
                  />
                  <Button variant="outline" size="sm" onClick={() => onEdit(rule)}>
                    编辑
                  </Button>
                  <Button
                    variant="link"
                    size="sm"
                    onClick={() => onDelete(rule)}
                    disabled={busyRuleId === rule.id}
                  >
                    删除
                  </Button>
                </div>
              </article>
            ))}

            {leaveRule && leaveState ? (
              <article
                className={`automation-rule-card ${leaveRule.enabled && leaveState.tone === 'on' ? '' : 'disabled'}`}
              >
                <div className="automation-rule-card-main">
                  <div className="automation-rule-card-title">
                    <h3>{leaveRule.name}</h3>
                    <span className={`automation-rule-state ${leaveState.tone}`}>
                      {leaveState.label}
                    </span>
                  </div>
                  <dl className="automation-rule-meta">
                    <div>
                      <dt>触发</dt>
                      <dd>{describeRuleTrigger(leaveRule)}</dd>
                    </div>
                    <div>
                      <dt>范围</dt>
                      <dd>{describeMonitoredScope(leaveNotification?.monitoredCount ?? 0)}</dd>
                    </div>
                    <div>
                      <dt>动作</dt>
                      <dd>{describeRuleActions(leaveRule)}</dd>
                    </div>
                    <div>
                      <dt>目标</dt>
                      <dd>
                        {describeLeaveNotificationTarget(
                          leaveRule.leaveNotification,
                          leaveNotification?.contactName
                        )}
                      </dd>
                    </div>
                  </dl>
                </div>
                <div className="automation-rule-card-side">
                  <Switch
                    checked={leaveRule.enabled}
                    disabled={busyRuleId === leaveRule.id}
                    onCheckedChange={(checked) => onToggle(leaveRule, checked)}
                    aria-label={`${leaveRule.name} 启停`}
                  />
                  <Button variant="outline" size="sm" onClick={onEditLeaveNotification}>
                    编辑
                  </Button>
                </div>
              </article>
            ) : null}
            {scheduledReport ? (
              <article className="automation-rule-card">
                <div className="automation-rule-card-main">
                  <div className="automation-rule-card-title">
                    <h3>定时日报</h3>
                    {/* 汇总卡：它代表多条规则，所以只报数量，不给单个启停开关。 */}
                    <span
                      className={`automation-rule-state ${scheduledReport.running > 0 ? 'on' : 'off'}`}
                    >
                      {scheduledReport.total} 条规则 · {scheduledReport.running} 条运行中
                    </span>
                  </div>
                  <dl className="automation-rule-meta">
                    <div>
                      <dt>触发</dt>
                      <dd>按设定时间</dd>
                    </div>
                    <div>
                      <dt>下次执行</dt>
                      <dd>{scheduledReport.nextRunLabel}</dd>
                    </div>
                  </dl>
                </div>
                <div className="automation-rule-card-side">
                  <Button variant="outline" size="sm" onClick={onManageScheduledReport}>
                    管理定时日报 →
                  </Button>
                </div>
              </article>
            ) : null}
          </>
        )}
      </section>

      <section className="automation-rule-group">
        <div className="automation-section-heading">
          <h2>更多模板</h2>
        </div>
        <div className="automation-template-grid">
          {AUTOMATION_RULE_TEMPLATES.map((template) => (
            <article key={template.id} className="automation-template-card">
              <div className="automation-template-title">
                <h3>{template.name}</h3>
                <span className="automation-template-flag">即将支持</span>
              </div>
              <p>{template.description}</p>
              {template.unavailableReason ? <small>{template.unavailableReason}</small> : null}
            </article>
          ))}
        </div>
      </section>
    </div>
  )
}
