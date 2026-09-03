import React from 'react'
import { AppPage, PRIMARY_NAV_ITEMS } from './navigation'
import type { GroupExitMonitorState } from '../../../../shared/group-exit-monitor'

interface NavIconProps {
  page: AppPage
}

interface PrimaryNavigationProps {
  activePage: AppPage
  onPageChange: (page: AppPage) => void
}

function NavIcon({ page }: NavIconProps): React.ReactElement {
  switch (page) {
    case 'archive':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M5 5.5h14v14H5z" />
          <path d="M8 8.5h8" />
          <path d="M8 12h8" />
          <path d="M8 15.5h5" />
        </svg>
      )
    case 'search':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <circle cx="10.5" cy="10.5" r="5.5" />
          <path d="m15 15 4 4" />
        </svg>
      )
    case 'report':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M7 4.5h7l3 3v12H7z" />
          <path d="M14 4.5v3h3" />
          <path d="M9.5 13.5h5" />
          <path d="M9.5 16.5h4" />
        </svg>
      )
    case 'exit-monitor':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M5.5 19V6.5h8V19" />
          <path d="M9.5 12h10" />
          <path d="m16.5 9 3 3-3 3" />
        </svg>
      )
    case 'logs':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M6 5.5h12v13H6z" />
          <path d="M9 9h6M9 12h6M9 15h4" />
        </svg>
      )
    case 'export':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M12 4.5v9" />
          <path d="m8.5 10 3.5 3.5 3.5-3.5" />
          <path d="M5.5 15.5v3h13v-3" />
        </svg>
      )
    case 'agent-hub':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <rect x="5" y="7" width="14" height="11" rx="3" />
          <path d="M12 4.5V7" />
          <circle cx="9.5" cy="12" r="1" />
          <circle cx="14.5" cy="12" r="1" />
          <path d="M9.5 15h5" />
        </svg>
      )
    case 'api':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M8 8.5 4.5 12 8 15.5" />
          <path d="m16 8.5 3.5 3.5-3.5 3.5" />
          <path d="m13.5 6.5-3 11" />
        </svg>
      )
    case 'settings':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <circle cx="12" cy="12" r="3" />
          <path d="M12 4.5v2" />
          <path d="M12 17.5v2" />
          <path d="M4.5 12h2" />
          <path d="M17.5 12h2" />
          <path d="m6.8 6.8 1.4 1.4" />
          <path d="m15.8 15.8 1.4 1.4" />
          <path d="m17.2 6.8-1.4 1.4" />
          <path d="m8.2 15.8-1.4 1.4" />
        </svg>
      )
  }
}

export function PrimaryNavigation({
  activePage,
  onPageChange
}: PrimaryNavigationProps): React.ReactElement {
  const [unreadExitCount, setUnreadExitCount] = React.useState(0)

  React.useEffect(() => {
    const api = typeof window !== 'undefined' ? window.api : undefined
    if (!api || typeof api.getGroupExitMonitorState !== 'function') return
    let disposed = false
    const update = (state: GroupExitMonitorState): void => {
      if (disposed) return
      setUnreadExitCount(activePage === 'exit-monitor' ? 0 : state.unreadCount)
    }
    void api
      .getGroupExitMonitorState()
      .then(update)
      .catch(() => undefined)
    const unsubscribe =
      typeof api.onGroupExitMonitorState === 'function' ? api.onGroupExitMonitorState(update) : null
    return () => {
      disposed = true
      unsubscribe?.()
    }
  }, [activePage])

  React.useEffect(() => {
    if (activePage !== 'exit-monitor') return
    const api = typeof window !== 'undefined' ? window.api : undefined
    if (!api || typeof api.markGroupExitMonitorRead !== 'function') return
    setUnreadExitCount(0)
    void api.markGroupExitMonitorRead().catch(() => undefined)
  }, [activePage])

  return (
    <nav className="primary-navigation" aria-label="一级导航">
      {PRIMARY_NAV_ITEMS.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`primary-nav-item ${activePage === item.id ? 'active' : ''}`}
          onClick={() => onPageChange(item.id)}
          title={item.label}
        >
          <span className="primary-nav-mark" aria-hidden>
            <NavIcon page={item.id} />
            {item.id === 'exit-monitor' && unreadExitCount > 0 && (
              <span className="primary-nav-badge">{Math.min(unreadExitCount, 99)}</span>
            )}
          </span>
          <span className="primary-nav-label">{item.label}</span>
        </button>
      ))}
    </nav>
  )
}
