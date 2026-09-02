import React from 'react'
import { SegmentedControl, SegmentedControlItem } from '../ui'

export function ReportDensitySelector(): React.ReactElement {
  return (
    <section className="report-config-section">
      <div className="report-section-heading">
        <h3>内容密度</h3>
        <span>当前提示词使用标准密度</span>
      </div>
      <SegmentedControl
        className="report-density-options w-full"
        aria-label="内容密度"
        value="standard"
        disabled
      >
        <SegmentedControlItem
          className="h-auto min-h-10 flex-col gap-0 whitespace-normal px-2 py-1.5 text-center"
          value="concise"
        >
          简洁 <small>即将支持</small>
        </SegmentedControlItem>
        <SegmentedControlItem
          className="h-auto min-h-10 flex-col gap-0 whitespace-normal px-2 py-1.5 text-center"
          value="standard"
        >
          标准 <small>当前固定模式</small>
        </SegmentedControlItem>
        <SegmentedControlItem
          className="h-auto min-h-10 flex-col gap-0 whitespace-normal px-2 py-1.5 text-center"
          value="detailed"
        >
          深度 <small>即将支持</small>
        </SegmentedControlItem>
      </SegmentedControl>
    </section>
  )
}
