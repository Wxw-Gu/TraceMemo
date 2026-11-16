import * as React from 'react'
import {
  BUILTIN_LEAVE_NOTIFICATION_RULE_ID,
  describeLeaveNotificationNotifyScope,
  describeLeaveNotificationTarget,
  describeRuleActions,
  describeRuleTrigger,
  type AutomationRule
} from '../../../../shared/automation'
import type { ExtensionDeepLink } from '../../../../shared/extensions/types'
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

/**
 * 规则模板卡片的本机状态。
 *
 * 由工作区根据「官方模板目录 + 已安装扩展 + 运行状态」算出，
 * 面板只负责渲染，不自己判断可用性。
 */
export interface RuleTemplateCardModel {
  id: string
  name: string
  description: string
  templateId: string
  extensionId: string
  /** 没有动作的模板只能打开配置，不能「用规则触发」。 */
  actionId?: string
  state: 'not-installed' | 'installed-disabled' | 'ready' | 'unavailable'
  /** 不可用/需要处理时的真实原因。 */
  reason?: string
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
  /** 规则模板卡片（真实状态）。 */
  ruleTemplates?: RuleTemplateCardModel[]
  /** 跳到扩展中心并定位模板/扩展/开发引导。 */
  onOpenExtension?: (target: ExtensionDeepLink) => void
  /** 用该模板预填一条引用扩展动作的规则。 */
  onUseRuleTemplate?: (template: RuleTemplateCardModel) => void
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
  onManageScheduledReport,
  ruleTemplates,
  onOpenExtension,
  onUseRuleTemplate
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
                      <dt>通知范围</dt>
                      <dd>
                        {describeLeaveNotificationNotifyScope(
                          leaveRule.leaveNotification,
                          leaveNotification?.monitoredCount ?? 0
                        )}
                      </dd>
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
          {(ruleTemplates ?? []).map((template) => {
            const badge =
              template.state === 'ready'
                ? '已就绪'
                : template.state === 'installed-disabled'
                  ? '已安装 · 未启用'
                  : template.state === 'not-installed'
                    ? '未安装'
                    : '不可用'
            return (
              <article key={template.id} className="automation-template-card">
                <div className="automation-template-title">
                  <h3>{template.name}</h3>
                  <span
                    className={
                      template.state === 'ready'
                        ? 'automation-template-flag is-ready'
                        : 'automation-template-flag'
                    }
                  >
                    {badge}
                  </span>
                </div>
                <p>{template.description}</p>
                {template.reason ? <small>{template.reason}</small> : null}

                <div className="automation-template-actions">
                  {template.state === 'not-installed' && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onOpenExtension?.({ templateId: template.templateId })}
                    >
                      去扩展中心安装 →
                    </Button>
                  )}
                  {template.state === 'installed-disabled' && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onOpenExtension?.({ extensionId: template.extensionId })}
                    >
                      去启用 →
                    </Button>
                  )}
                  {template.state === 'ready' && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onOpenExtension?.({ extensionId: template.extensionId })}
                      >
                        打开扩展配置 →
                      </Button>
                      {template.actionId ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onUseRuleTemplate?.(template)}
                        >
                          用规则触发
                        </Button>
                      ) : (
                        <small className="automation-template-note">
                          该扩展没有注册自动化动作，靠消息事件触发
                        </small>
                      )}
                    </>
                  )}
                </div>
              </article>
            )
          })}

          {/* 模板之外还要有出口：没有现成模板可用时，用户应该能自己做一个。 */}
          <article className="automation-template-card is-guide">
            <div className="automation-template-title">
              <h3>做自己的扩展</h3>
            </div>
            <p>
              从官方模板克隆一份代码，改完直接在本地调试；官方升级不会覆盖你的改动。 也可以链接已经
              clone 到别处的项目。
            </p>
            <div className="automation-template-actions">
              <Button
                variant="outline"
                size="sm"
                onClick={() => onOpenExtension?.({ development: true })}
              >
                开始二次开发 →
              </Button>
            </div>
          </article>
        </div>
      </section>
    </div>
  )
}
