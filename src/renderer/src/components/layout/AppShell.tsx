import React from 'react'
import { AccountSummary } from '../account/AccountSummary'
import { PrimaryNavigation } from './PrimaryNavigation'
import { AppPage, PRIMARY_NAV_ITEMS } from './navigation'
import brandIcon from '../../assets/brand-icon.svg'

interface SelfInfo {
  wxid: string
  nickname: string
  avatar?: string
  accountRoot: string
}

interface AppShellProps {
  activePage: AppPage
  selfInfo: SelfInfo | null
  dbReady: boolean
  onPageChange: (page: AppPage) => void
  onOpenSettings: () => void
  appearanceTheme?: 'system' | 'light' | 'dark'
  compactMode?: boolean
  children: React.ReactNode
}

function BrandLogo(): React.ReactElement {
  return (
    <div className="app-brand" title="WechatExplorer" aria-label="WechatExplorer">
      <img src={brandIcon} alt="" aria-hidden="true" />
    </div>
  )
}

export function AppShell({
  activePage,
  selfInfo,
  dbReady,
  onPageChange,
  onOpenSettings,
  appearanceTheme = 'system',
  compactMode = false,
  children
}: AppShellProps): React.ReactElement {
  const activeItem = PRIMARY_NAV_ITEMS.find((item) => item.id === activePage)

  return (
    <div className={`app-shell theme-${appearanceTheme} ${compactMode ? 'is-compact' : ''}`}>
      <aside className="app-primary-rail">
        <BrandLogo />
        <PrimaryNavigation activePage={activePage} onPageChange={onPageChange} />
        <div className="app-rail-account">
          <AccountSummary selfInfo={selfInfo} dbReady={dbReady} compact onClick={onOpenSettings} />
        </div>
      </aside>
      <main className="app-shell-main" aria-label={activeItem?.label || '工作区'}>
        {children}
      </main>
    </div>
  )
}
