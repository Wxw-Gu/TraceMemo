import React from 'react'

interface SelfInfo {
  wxid: string
  nickname: string
  avatar?: string
  accountRoot: string
}

interface AccountSummaryProps {
  selfInfo: SelfInfo | null
  dbReady: boolean
  dbConnecting?: boolean
  compact?: boolean
  onClick?: () => void
}

export function AccountSummary({
  selfInfo,
  dbReady,
  dbConnecting = false,
  compact = false,
  onClick
}: AccountSummaryProps): React.ReactElement {
  const showAccount = Boolean(selfInfo && (dbReady || dbConnecting))
  const displayName =
    showAccount && selfInfo ? selfInfo.nickname || selfInfo.wxid || '当前账号' : '未连接'
  const subtitle = showAccount && selfInfo ? selfInfo.wxid : '打开设置'
  const statusText = dbReady ? '数据库已连接' : dbConnecting ? '正在连接数据库' : '数据库未连接'
  const statusClass = dbReady ? 'ready' : dbConnecting ? 'connecting' : ''
  const initial = (displayName || '?').charAt(0)
  const title = `${displayName}\n${subtitle}`
  const avatar = (
    <span className="account-summary-avatar">
      {selfInfo?.avatar ? (
        <img src={selfInfo.avatar} alt={displayName} referrerPolicy="no-referrer" />
      ) : (
        initial
      )}
      <span className={`account-summary-status ${statusClass}`} aria-hidden />
    </span>
  )

  if (compact) {
    return (
      <button type="button" className="account-summary compact" onClick={onClick} title={title}>
        {avatar}
      </button>
    )
  }

  return (
    <div className="account-summary" title={title}>
      {avatar}
      <span className="account-summary-text">
        <span className="account-summary-name">{displayName}</span>
        <span className="account-summary-meta">{subtitle}</span>
        <span className="account-summary-state">
          <span className={`account-summary-state-dot ${statusClass}`} aria-hidden />
          {statusText}
        </span>
      </span>
      <button type="button" className="account-summary-settings" onClick={onClick} title="设置">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M12.22 2h-.44a2 2 0 0 0-2 1.72l-.15 1.58a8 8 0 0 0-1.77 1.03l-1.48-.6a2 2 0 0 0-2.5.88l-.22.39a2 2 0 0 0 .51 2.68l1.25.98a8 8 0 0 0 0 2.08l-1.25.98a2 2 0 0 0-.51 2.68l.22.39a2 2 0 0 0 2.5.88l1.48-.6c.54.43 1.14.78 1.77 1.03l.15 1.58a2 2 0 0 0 2 1.72h.44a2 2 0 0 0 2-1.72l.15-1.58c.63-.25 1.23-.6 1.77-1.03l1.48.6a2 2 0 0 0 2.5-.88l.22-.39a2 2 0 0 0-.51-2.68l-1.25-.98a8 8 0 0 0 0-2.08l1.25-.98a2 2 0 0 0 .51-2.68l-.22-.39a2 2 0 0 0-2.5-.88l-1.48.6a8 8 0 0 0-1.77-1.03l-.15-1.58a2 2 0 0 0-2-1.72Z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </button>
    </div>
  )
}
