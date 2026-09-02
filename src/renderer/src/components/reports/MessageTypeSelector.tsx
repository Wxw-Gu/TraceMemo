import React from 'react'
import { SUMMARY_TYPE_OPTIONS, SummaryMessageType } from '../../utils/group-report'
import { Checkbox } from '../ui'

interface MessageTypeSelectorProps {
  value: SummaryMessageType[]
  counts: Record<SummaryMessageType, number>
  disabled: boolean
  onChange: (value: SummaryMessageType[]) => void
}

export function MessageTypeSelector({
  value,
  counts,
  disabled,
  onChange
}: MessageTypeSelectorProps): React.ReactElement {
  const toggle = (type: SummaryMessageType): void => {
    if (value.includes(type)) {
      if (value.length === 1) return
      onChange(value.filter((item) => item !== type))
      return
    }
    onChange([...value, type])
  }

  return (
    <section className="report-config-section">
      <div className="report-section-heading">
        <h3>纳入的消息类型</h3>
        <span>至少选择一种</span>
      </div>
      <div className="report-type-grid">
        {SUMMARY_TYPE_OPTIONS.map((option) => (
          <label
            key={option.value}
            className="report-check-row"
            htmlFor={`report-message-type-${option.value}`}
          >
            <Checkbox
              id={`report-message-type-${option.value}`}
              aria-label={option.label}
              className="mt-0.5"
              checked={value.includes(option.value)}
              disabled={disabled || (value.length === 1 && value.includes(option.value))}
              onCheckedChange={() => toggle(option.value)}
            />
            <span>
              <b>{option.label}</b>
              <small>{option.description}</small>
            </span>
            <em>{counts[option.value]}</em>
          </label>
        ))}
      </div>
    </section>
  )
}
