import { useEffect, useState } from 'react'
import { AccountOverview } from '../account-database/AccountOverview'
import { ConnectionHealthSection } from '../account-database/ConnectionHealthSection'
import { LocalPrivacyNotice } from '../account-database/LocalPrivacyNotice'
import { useAccountDatabaseController } from '../account-database/useAccountDatabaseController'
import type { ConnectionOverviewStatus } from '../account-database/types'
import type { SettingsSelfInfo } from '../model/types'

const STATUS_LABELS: Record<ConnectionOverviewStatus, string> = {
  checking: '正在检测',
  success: '连接正常',
  warning: '部分能力不可用',
  error: '连接异常',
  unavailable: '尚未连接'
}

export function AccountDatabasePage({
  dbKey,
  dbReady,
  selfInfo,
  onNotice
}: {
  dbKey: string
  dbReady: boolean
  selfInfo: SettingsSelfInfo | null
  onNotice: (message: string) => void
}): React.ReactElement {
  const controller = useAccountDatabaseController({ dbKey, dbReady, selfInfo, onNotice })
  const [autoLogin, setAutoLogin] = useState(false)

  useEffect(() => {
    let active = true
    void window.api.getSettings().then((result) => {
      if (!active) return
      setAutoLogin(result.settings.autoLogin)
    })
    return () => {
      active = false
    }
  }, [])

  const changeAutoLogin = async (checked: boolean): Promise<void> => {
    const result = await window.api.setSettings({
      autoLogin: checked,
      autoLoginPreferenceSet: true
    })
    setAutoLogin(result.settings.autoLogin)
    onNotice(checked ? '已开启启动时自动连接' : '已关闭启动时自动连接')
  }

  return (
    <div className="settings-page">
      <header className="settings-page-header">
        <div>
          <h1>账号与数据库</h1>
          <p>查看当前微信账号与本地数据库连接状态</p>
        </div>
        <span className={`settings-status-badge ${controller.connectionStatus}`}>
          {STATUS_LABELS[controller.connectionStatus]}
        </span>
      </header>
      <div className="settings-page-scroll">
        <div className="settings-page-content">
          <LocalPrivacyNotice />
          <h2 className="settings-section-heading">账号概览</h2>
          <AccountOverview
            selfInfo={selfInfo}
            connectionStatus={controller.connectionStatus}
            lastCheckedLabel={controller.lastCheckedLabel}
            isChecking={controller.isChecking}
            onCheck={() => void controller.testConnection()}
            onOpenDirectory={() => void controller.openAccountDirectory()}
            onCopyDirectory={() => void controller.copyAccountDirectory()}
          />
          <h2 className="settings-section-heading">连接健康检查</h2>
          <ConnectionHealthSection
            diagnostics={controller.diagnostics}
            summary={
              controller.checkState.status === 'error' || controller.checkState.status === 'warning'
                ? controller.checkState.message
                : undefined
            }
          />
          <h2 className="settings-section-heading">启动行为</h2>
          <section className="settings-card settings-auto-login-card">
            <label>
              <span>
                <b>启动时自动连接数据库</b>
                <small>使用安全存储中已保存的数据库密钥；可随时关闭。</small>
              </span>
              <input
                type="checkbox"
                checked={autoLogin}
                onChange={(event) => void changeAutoLogin(event.target.checked)}
              />
            </label>
          </section>
        </div>
      </div>
    </div>
  )
}
