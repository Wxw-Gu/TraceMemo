import { SettingsEmptyState } from './components/SettingsEmptyState'
import { SettingsSidebar } from './components/SettingsSidebar'
import { SETTINGS_CATEGORY_LABELS } from './model/settingsNavigation'
import type { SettingsCategoryId, SettingsSelfInfo } from './model/types'
import { AccountDatabasePage } from './pages/AccountDatabasePage'
import { DatabaseKeyPage } from './pages/DatabaseKeyPage'
import { ImageDecryptionPage } from './pages/ImageDecryptionPage'
import { AIModelPage } from './pages/AIModelPage'
import { RecallProtectionPage } from './pages/RecallProtectionPage'
import { AdvancedPage } from './pages/AdvancedPage'
import { CacheCleanupPage } from './pages/CacheCleanupPage'
import { AppearancePage } from './pages/AppearancePage'
import { AboutPage } from './pages/AboutPage'
import type { Contact } from '../../../../shared/types'
import type { AIRuntimeModelConfig } from '../../../../shared/ai-provider'

export function SettingsWorkspace({
  selectedCategory,
  onCategoryChange,
  selfInfo,
  dbReady,
  dbConnecting = false,
  dbKey,
  onDbKeyChange,
  onDatabaseConnectionChange,
  onSelfInfoChange,
  onContactsChange,
  onFilteredContactsChange,
  onReturnToLogin,
  onAIRuntimeChange,
  onNotice,
  onOpenSettings,
  onAppearanceChange,
  onSwitchAccount
}: {
  selectedCategory: SettingsCategoryId
  onCategoryChange: (id: SettingsCategoryId) => void
  selfInfo: SettingsSelfInfo | null
  dbReady: boolean
  dbConnecting?: boolean
  dbKey: string
  onDbKeyChange: (key: string) => void
  onDatabaseConnectionChange: (connected: boolean) => void
  onSelfInfoChange: (info: SettingsSelfInfo | null) => void
  onContactsChange: (contacts: Contact[]) => void
  onFilteredContactsChange: (contacts: Contact[]) => void
  onReturnToLogin: () => void
  onAIRuntimeChange: (config: AIRuntimeModelConfig) => void
  onNotice: (message: string) => void
  onOpenSettings: () => void
  onAppearanceChange: (settings: {
    theme: 'system' | 'light' | 'dark'
    compactMode: boolean
  }) => void
  onSwitchAccount: (
    account: import('../../../../shared/database-key').WechatAccountCandidate
  ) => Promise<void>
}): React.ReactElement {
  const renderSelectedPage = (): React.ReactElement => {
    switch (selectedCategory) {
      case 'account-database':
        return (
          <AccountDatabasePage
            dbKey={dbKey}
            dbReady={dbReady}
            dbConnecting={dbConnecting}
            selfInfo={selfInfo}
            onNotice={onNotice}
            onSwitchAccount={onSwitchAccount}
          />
        )
      case 'database-key':
        return (
          <DatabaseKeyPage
            dbKey={dbKey}
            dbReady={dbReady}
            selfInfo={selfInfo}
            onDbKeyChange={onDbKeyChange}
            onDatabaseConnectionChange={onDatabaseConnectionChange}
            onSelfInfoChange={onSelfInfoChange}
            onContactsChange={onContactsChange}
            onFilteredContactsChange={onFilteredContactsChange}
            onReturnToLogin={onReturnToLogin}
            onNotice={onNotice}
          />
        )
      case 'image-key':
        return <ImageDecryptionPage selfInfo={selfInfo} onNotice={onNotice} />
      case 'ai-model':
        return <AIModelPage onRuntimeChange={onAIRuntimeChange} onNotice={onNotice} />
      case 'recall-protection':
        return <RecallProtectionPage onNotice={onNotice} />
      case 'advanced':
        return <AdvancedPage onNotice={onNotice} />
      case 'cache-cleanup':
        return <CacheCleanupPage onNotice={onNotice} />
      case 'appearance':
        return <AppearancePage onNotice={onNotice} onAppearanceChange={onAppearanceChange} />
      case 'about':
        return <AboutPage onNotice={onNotice} />
      default:
        return <SettingsEmptyState label={SETTINGS_CATEGORY_LABELS[selectedCategory]} />
    }
  }

  return (
    <div className="settings-workspace">
      <SettingsSidebar
        selectedId={selectedCategory}
        onSelect={onCategoryChange}
        selfInfo={selfInfo}
        dbReady={dbReady}
        dbConnecting={dbConnecting}
        onOpenSettings={onOpenSettings}
      />
      <div className="settings-page-panel active">{renderSelectedPage()}</div>
    </div>
  )
}
