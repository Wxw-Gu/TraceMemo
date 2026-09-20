import * as React from 'react'
import {
  AUTOMATION_RULE_TEMPLATES,
  describeRuleActions,
  describeRuleTrigger,
  type AutomationRule
} from '../../../../shared/automation'
import { Button, Spinner, Switch } from '../../components/ui'

/**
 * RuleListPanel —— 规则列表（对应 Stitch 设计稿 2 的「规则」tab）。
 *
 * 两个区块：
 * 1. **已配置的规则** —— 真实可运行，带启停开关；
 * 2. **模板入口** —— 尚未接通的能力必须**如实标注**为「即将支持」。
 *    这里最容易犯的错是把设计稿里的卡片全渲染成"已启用"的样子，
 *    用户点进去发现是空的 —— 那比拼不出这个功能更糟。
 */

export interface RuleListPanelProps {
  rules: AutomationRule[]
  groups: Array<{ id: string; name: string }>
  loading: boolean
  busyRuleId: string | null
  onToggle: (rule: AutomationRule, enabled: boolean) => void
  onEdit: (rule: AutomationRule) => void
  onDelete: (rule: AutomationRule) => void
  onCreate: () => void
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

export function RuleListPanel({
  rules,
  groups,
  loading,
  busyRuleId,
  onToggle,
  onEdit,
  onDelete,
  onCreate
}: RuleListPanelProps): React.ReactElement {
  return (
    <div className="automation-rule-list">
      <section className="automation-rule-group">
        <div className="automation-section-heading">
          <h2>已配置的自动化</h2>
          <span className="automation-section-note">{rules.length} 条</span>
        </div>

        {loading ? (
          <div className="automation-loading">
            <Spinner />
            <span>正在读取规则…</span>
          </div>
        ) : rules.length === 0 ? (
          <div className="automation-empty-card">
            <p>还没有任何自动化。</p>
            <Button onClick={onCreate}>新建自动化</Button>
          </div>
        ) : (
          rules.map((rule) => (
            <article key={rule.id} className={`automation-rule-card ${rule.enabled ? '' : 'disabled'}`}>
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
          ))
        )}
      </section>

      <section className="automation-rule-group">
        <div className="automation-section-heading">
          <h2>更多模板</h2>
          <span className="automation-section-note">后续版本开放</span>
        </div>
        <div className="automation-template-grid">
          {AUTOMATION_RULE_TEMPLATES.map((template) => (
            <article key={template.id} className="automation-template-card">
              <div className="automation-template-title">
                <h3>{template.name}</h3>
                <span className="automation-template-flag">即将支持</span>
              </div>
              <p>{template.description}</p>
              {template.unavailableReason ? (
                <small>{template.unavailableReason}</small>
              ) : null}
            </article>
          ))}
        </div>
      </section>
    </div>
  )
}
