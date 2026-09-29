import React from 'react'
import { SUMMARY_TYPE_OPTIONS, SummaryMessageType } from '../../utils/group-report'
import { Checkbox } from '../ui'

interface MessageTypeSelectorProps {
  value: SummaryMessageType[]
  /**
   * 每类消息的条数。
   *
   * 可选：`自动化 → 定时日报` 的编辑器没有真实消息统计，
   * 不传就不显示数字，而不是显示一排假的 0。
   */
  counts?: Record<SummaryMessageType, number>
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
            {counts ? <em>{counts[option.value]}</em> : null}
          </label>
        ))}
      </div>
    </section>
  )
}
