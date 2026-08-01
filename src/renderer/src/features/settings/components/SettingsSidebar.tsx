import { useMemo, useState } from 'react'
import { AccountSummary } from '../../../components/account/AccountSummary'
import { SETTINGS_NAVIGATION } from '../model/settingsNavigation'
import type { SettingsCategoryId, SettingsSelfInfo } from '../model/types'

export function SettingsSidebar({
  selectedId,
  onSelect,
  selfInfo,
  dbReady,
  dbConnecting = false,
  onOpenSettings
}: {
  selectedId: SettingsCategoryId
  onSelect: (id: SettingsCategoryId) => void
  selfInfo: SettingsSelfInfo | null
  dbReady: boolean
  dbConnecting?: boolean
  onOpenSettings: () => void
}): React.ReactElement {
  const [keyword, setKeyword] = useState('')
  const groups = useMemo(
    () =>
      SETTINGS_NAVIGATION.map((group) => ({
        ...group,
        items: group.items.filter((item) => item.label.includes(keyword.trim()))
      })).filter((group) => group.items.length),
    [keyword]
  )
  return (
    <aside className="settings-sidebar">
      <header>
        <h1>设置</h1>
        <p>管理账号、数据连接和本地能力</p>
        <label className="settings-search">
          <span>⌕</span>
          <input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索设置"
          />
        </label>
      </header>
      <div className="settings-sidebar-list">
        {groups.map((group) => (
          <section key={group.label}>
            <h2>{group.label}</h2>
            {group.items.map((item) => (
              <button
                type="button"
                key={item.id}
                className={selectedId === item.id ? 'active' : ''}
                onClick={() => onSelect(item.id)}
              >
                {item.label}
              </button>
            ))}
          </section>
        ))}
      </div>
      <div className="settings-sidebar-account">
        <AccountSummary
          selfInfo={selfInfo}
          dbReady={dbReady}
          dbConnecting={dbConnecting}
          onClick={onOpenSettings}
        />
      </div>
    </aside>
  )
}
