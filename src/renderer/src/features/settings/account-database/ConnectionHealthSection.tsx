import type { ConnectionDiagnostic, DiagnosticStatus } from './types'

function DiagnosticIcon({ status }: { status: DiagnosticStatus }): React.ReactElement {
  if (status === 'checking') {
    return <span className="settings-diagnostic-icon checking" aria-label="检测中" />
  }

  const icon =
    status === 'success' ? (
      <path d="m5 12.5 4.5 4.5L19 7" />
    ) : status === 'warning' ? (
      <>
        <path d="M12 6v7" />
        <circle cx="12" cy="17" r="1.5" fill="currentColor" stroke="none" />
      </>
    ) : status === 'error' ? (
      <path d="m7 7 10 10M17 7 7 17" />
    ) : (
      <path d="M6 12h12" />
    )

  return (
    <span className={`settings-diagnostic-icon ${status}`} aria-hidden="true">
      <svg
        viewBox="0 0 24 24"
        width="12"
        height="12"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        focusable="false"
      >
        {icon}
      </svg>
    </span>
  )
}

export function ConnectionHealthSection({
  diagnostics,
  summary
}: {
  diagnostics: ConnectionDiagnostic[]
  summary?: string
}): React.ReactElement {
  return (
    <section className="settings-card settings-health-card">
      {summary && <p className="settings-diagnostic-summary">{summary}</p>}
      <div className="settings-diagnostics">
        {diagnostics.map((item) => (
          <div className="settings-diagnostic" key={item.id}>
            <DiagnosticIcon status={item.status} />
            <span>{item.label}</span>
            <small title={item.detail}>{item.result}</small>
          </div>
        ))}
      </div>
    </section>
  )
}
