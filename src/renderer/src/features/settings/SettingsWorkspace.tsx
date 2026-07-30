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
  onAppearanceChange
}: {
  selectedCategory: SettingsCategoryId
  onCategoryChange: (id: SettingsCategoryId) => void
  selfInfo: SettingsSelfInfo | null
  dbReady: boolean
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
  onAppearanceChange: (settings: { theme: 'system' | 'light' | 'dark'; compactMode: boolean }) => void
}): React.ReactElement {
  return (
    <div className="settings-workspace">
      <SettingsSidebar
        selectedId={selectedCategory}
        onSelect={onCategoryChange}
        selfInfo={selfInfo}
        dbReady={dbReady}
        onOpenSettings={onOpenSettings}
      />
      <div
        className={`settings-page-panel ${selectedCategory === 'account-database' ? 'active' : ''}`}
      >
        <AccountDatabasePage
          dbKey={dbKey}
          dbReady={dbReady}
          selfInfo={selfInfo}
          onNotice={onNotice}
        />
      </div>
      <div className={`settings-page-panel ${selectedCategory === 'database-key' ? 'active' : ''}`}>
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
      </div>
      <div className={`settings-page-panel ${selectedCategory === 'image-key' ? 'active' : ''}`}>
        <ImageDecryptionPage selfInfo={selfInfo} onNotice={onNotice} />
      </div>
      <div className={`settings-page-panel ${selectedCategory === 'ai-model' ? 'active' : ''}`}>
        <AIModelPage onRuntimeChange={onAIRuntimeChange} onNotice={onNotice} />
      </div>
      <div
        className={`settings-page-panel ${selectedCategory === 'recall-protection' ? 'active' : ''}`}
      >
        <RecallProtectionPage onNotice={onNotice} />
      </div>
      <div className={`settings-page-panel ${selectedCategory === 'advanced' ? 'active' : ''}`}>
        <AdvancedPage onNotice={onNotice} />
      </div>
      <div className={`settings-page-panel ${selectedCategory === 'cache-cleanup' ? 'active' : ''}`}>
        <CacheCleanupPage onNotice={onNotice} />
      </div>
      <div className={`settings-page-panel ${selectedCategory === 'appearance' ? 'active' : ''}`}>
        <AppearancePage onNotice={onNotice} onAppearanceChange={onAppearanceChange} />
      </div>
      <div className={`settings-page-panel ${selectedCategory === 'about' ? 'active' : ''}`}>
        <AboutPage onNotice={onNotice} />
      </div>
      {![
        'account-database',
        'database-key',
        'image-key',
        'ai-model',
        'recall-protection',
        'advanced',
        'cache-cleanup',
        'appearance',
        'about'
      ].includes(selectedCategory) && (
        <div className="settings-page-panel active">
          <SettingsEmptyState label={SETTINGS_CATEGORY_LABELS[selectedCategory]} />
        </div>
      )}
    </div>
  )
}
