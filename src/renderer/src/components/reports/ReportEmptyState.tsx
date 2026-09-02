import React from 'react'
import { Button } from '../ui'

interface ReportEmptyStateProps {
  icon?: 'spark'
  title: string
  message: string
  actionLabel: string
  onAction: () => void
}

export function ReportEmptyState({
  icon,
  title,
  message,
  actionLabel,
  onAction
}: ReportEmptyStateProps): React.ReactElement {
  return (
    <div className="report-center-empty">
      {icon === 'spark' && (
        <div className="report-center-empty-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" focusable="false">
            <path d="M12 3l1.6 5.2L19 10l-5.4 1.8L12 17l-1.6-5.2L5 10l5.4-1.8L12 3Z" />
            <path d="M19 15l.8 2.3L22 18l-2.2.7L19 21l-.8-2.3L16 18l2.2-.7L19 15Z" />
          </svg>
        </div>
      )}
      <h2>{title}</h2>
      <p>{message}</p>
      <Button onClick={onAction}>{actionLabel}</Button>
    </div>
  )
}
