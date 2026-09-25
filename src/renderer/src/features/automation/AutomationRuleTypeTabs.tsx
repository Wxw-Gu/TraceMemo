import * as React from 'react'
import { SegmentedControl, SegmentedControlItem } from '../../components/ui'
import { AUTOMATION_RULE_TYPE_LABELS, type AutomationRuleType } from '../../../../shared/automation'

/**
 * Tab 上能出现的规则类型。
 *
 * `scheduled_report` **只存在于这一层**：真实 `AutomationRule.ruleType`
 * 仍然只有 `daily_report` / `leave_notification`
 * —— 不往真实 schema 里塞一个还不存在的类型。
 */
export type AutomationRuleTabType = AutomationRuleType | 'scheduled_report'

/**
 * Tab 顺序 = 触发方式的演进：消息触发 → 时间触发 → 系统事件触发。
 */
const RULE_TABS: AutomationRuleTabType[] = [
  'daily_report',
  'scheduled_report',
  'leave_notification'
]

const TAB_LABELS: Record<AutomationRuleTabType, string> = {
  daily_report: AUTOMATION_RULE_TYPE_LABELS.daily_report,
  scheduled_report: '定时日报',
  leave_notification: AUTOMATION_RULE_TYPE_LABELS.leave_notification
}

/**
 * AutomationRuleTypeTabs —— 编辑器上方的**规则类型切换**。
 *
 * 它切的是"现在在编辑哪一类规则"，**不是**"把当前这条规则改成另一类"。
 * 文案必须说清这一点：叫「规则类型」时，用户会以为它是当前规则的类型选择器，
 * 于是"切一下再保存"就意外改到了另一条规则上。
 *
 * 两项都是**真规则**：切换只改前端选中态，不碰任何已保存的配置。
 */

export function AutomationRuleTypeTabs({
  value,
  onValueChange
}: {
  value: AutomationRuleTabType
  onValueChange: (next: AutomationRuleTabType) => void
}): React.ReactElement {
  return (
    <div className="automation-rule-type-tabs">
      <span className="automation-rule-type-label">切换规则类型</span>
      <SegmentedControl
        value={value}
        onValueChange={(next) => onValueChange(next as AutomationRuleTabType)}
        aria-label="切换规则类型"
      >
        {RULE_TABS.map((type) => (
          <SegmentedControlItem key={type} value={type}>
            {TAB_LABELS[type]}
          </SegmentedControlItem>
        ))}
      </SegmentedControl>
    </div>
  )
}
