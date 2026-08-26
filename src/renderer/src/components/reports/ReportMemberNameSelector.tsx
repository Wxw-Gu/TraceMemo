import React from 'react'
import { ReportMemberNamePreference } from '../../hooks/useGroupReportGeneration'
import { RadioGroup, RadioGroupItem } from '../ui'

const OPTIONS: {
  value: ReportMemberNamePreference
  label: string
  description: string
}[] = [
  {
    value: 'groupNickname',
    label: '群昵称',
    description: '优先使用成员在当前群设置的昵称。'
  },
  {
    value: 'wechatNickname',
    label: '微信昵称',
    description: '优先使用对方公开的微信昵称。'
  },
  {
    value: 'remark',
    label: '通讯录备注',
    description: '优先使用你为对方设置的备注。'
  }
]

export function ReportMemberNameSelector({
  value,
  disabled,
  onChange
}: {
  value: ReportMemberNamePreference
  disabled?: boolean
  onChange: (value: ReportMemberNamePreference) => void
}): React.ReactElement {
  return (
    <section className="report-section">
      <h3>成员名称</h3>
      <p className="report-section-desc">选择日报中群成员的显示名称，默认使用群昵称。</p>
      <RadioGroup
        className="report-template-list"
        value={value}
        disabled={disabled}
        onValueChange={(nextValue) => onChange(nextValue as ReportMemberNamePreference)}
      >
        {OPTIONS.map((option) => (
          <label
            className={`report-template-item ${value === option.value ? 'active' : ''} ${disabled ? 'disabled' : ''}`}
            key={option.value}
            htmlFor={`report-member-name-${option.value}`}
          >
            <RadioGroupItem
              id={`report-member-name-${option.value}`}
              value={option.value}
              aria-label={option.label}
            />
            <div className="report-template-body">
              <div className="report-template-title">{option.label}</div>
              <div className="report-template-tagline">{option.description}</div>
            </div>
          </label>
        ))}
      </RadioGroup>
    </section>
  )
}
