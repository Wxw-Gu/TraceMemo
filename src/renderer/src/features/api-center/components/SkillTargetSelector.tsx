import { type ReactElement } from 'react'
import { SegmentedControl, SegmentedControlItem } from '../../../components/ui'
import { AGENT_INSTALL_TARGETS, type AgentInstallTarget } from '../model/skillDistribution'

export function SkillTargetSelector({
  value,
  onChange
}: {
  value: AgentInstallTarget
  onChange: (value: AgentInstallTarget) => void
}): ReactElement {
  return (
    <SegmentedControl
      className="mt-2"
      value={value}
      onValueChange={(nextValue) => onChange(nextValue as AgentInstallTarget)}
      aria-label="选择目标 Agent"
    >
      {AGENT_INSTALL_TARGETS.map((target) => (
        <SegmentedControlItem key={target.value} value={target.value}>
          {target.label}
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  )
}
