import React from 'react'

interface ReportZoomBarProps {
  zoom: number
  onZoomChange: (zoom: number) => void
  onFitPage: () => void
  onActualSize: () => void
}

const clampZoom = (value: number): number => Math.min(64, Math.max(0.25, value))

export function ReportZoomBar({
  zoom,
  onZoomChange,
  onFitPage,
  onActualSize
}: ReportZoomBarProps): React.ReactElement {
  return (
    <div className="report-zoom-bar">
      <button type="button" onClick={() => onZoomChange(clampZoom(zoom / 1.25))}>
        缩小
      </button>
      <span title="100% 为完整显示在当前预览框内">{Math.round(zoom * 100)}%</span>
      <button type="button" onClick={() => onZoomChange(clampZoom(zoom * 1.25))}>
        放大
      </button>
      <button type="button" onClick={onFitPage}>
        完整显示
      </button>
      <button type="button" onClick={onActualSize}>
        原始大小
      </button>
    </div>
  )
}
