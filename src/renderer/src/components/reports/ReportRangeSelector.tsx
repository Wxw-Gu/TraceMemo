import React from 'react'
import { SUMMARY_DATE_OPTIONS, SummaryDateRange } from '../../utils/group-report'
import { RangeMessageState } from '../../hooks/useGroupReportGeneration'
import { SegmentedControl, SegmentedControlItem } from '../ui'

interface ReportRangeSelectorProps {
  value: SummaryDateRange
  messageCount: number
  rangeState: RangeMessageState
  disabled: boolean
  onChange: (value: SummaryDateRange) => void
}

export function ReportRangeSelector({
  value,
  messageCount,
  rangeState,
  disabled,
  onChange
}: ReportRangeSelectorProps): React.ReactElement {
  const countText =
    rangeState.status === 'loading'
      ? '正在计算'
      : rangeState.status === 'error'
        ? rangeState.error
        : `${messageCount} 条消息`

  return (
    <section className="report-config-section">
      <div className="report-section-heading">
        <h3>总结范围</h3>
        <span className={rangeState.status === 'error' ? 'danger' : ''}>{countText}</span>
      </div>
      <SegmentedControl
        className="report-range-options w-full"
        aria-label="总结范围"
        value={value}
        disabled={disabled}
        onValueChange={(nextValue) => onChange(nextValue as SummaryDateRange)}
      >
        {SUMMARY_DATE_OPTIONS.map((option) => (
          <SegmentedControlItem
            key={option.value}
            className="h-auto min-h-10 whitespace-normal px-2 py-1.5 text-center"
            value={option.value}
          >
            {option.label}
          </SegmentedControlItem>
        ))}
        <SegmentedControlItem
          className="h-auto min-h-10 flex-col gap-0 whitespace-normal px-2 py-1.5 text-center"
          value="custom"
          disabled
          title="当前业务尚未支持自定义开始和结束时间"
        >
          自定义 <small>即将支持</small>
        </SegmentedControlItem>
      </SegmentedControl>
    </section>
  )
}
