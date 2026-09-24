import * as React from 'react'
import { SegmentedControl, SegmentedControlItem } from '../../components/ui'
import { AUTOMATION_RULE_TYPE_LABELS, type AutomationRuleType } from '../../../../shared/automation'

/**
 * AutomationRuleTypeTabs —— 编辑器上方的**规则类型切换**。
 *
 * 它切的是"现在在编辑哪一类规则"，**不是**"把当前这条规则改成另一类"。
 * 文案必须说清这一点：叫「规则类型」时，用户会以为它是当前规则的类型选择器，
 * 于是"切一下再保存"就意外改到了另一条规则上。
 *
 * 两项都是**真规则**：切换只改前端选中态，不碰任何已保存的配置。
 */

const RULE_TYPES: AutomationRuleType[] = ['daily_report', 'leave_notification']

export function AutomationRuleTypeTabs({
  value,
  onValueChange
}: {
  value: AutomationRuleType
  onValueChange: (next: AutomationRuleType) => void
}): React.ReactElement {
  return (
    <div className="automation-rule-type-tabs">
      <span className="automation-rule-type-label">切换规则类型</span>
      <SegmentedControl
        value={value}
        onValueChange={(next) => onValueChange(next as AutomationRuleType)}
        aria-label="切换规则类型"
      >
        {RULE_TYPES.map((type) => (
          <SegmentedControlItem key={type} value={type}>
            {AUTOMATION_RULE_TYPE_LABELS[type]}
          </SegmentedControlItem>
        ))}
      </SegmentedControl>
    </div>
  )
}
