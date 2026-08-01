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
  const statusText = dbReady
    ? '数据库已连接'
    : dbConnecting
      ? '正在连接数据库'
      : '数据库未连接'
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
          <path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z" />
          <path d="M19.4 15a8.2 8.2 0 0 0 .1-1l2-1.5-2-3.5-2.4 1a7.5 7.5 0 0 0-1.7-1l-.3-2.5h-4l-.4 2.5a7.5 7.5 0 0 0-1.7 1l-2.3-1-2 3.5 2 1.5a8.2 8.2 0 0 0 0 2l-2 1.5 2 3.5 2.3-1a7.5 7.5 0 0 0 1.7 1l.4 2.5h4l.3-2.5a7.5 7.5 0 0 0 1.7-1l2.4 1 2-3.5-2.1-1.5Z" />
        </svg>
      </button>
    </div>
  )
}
