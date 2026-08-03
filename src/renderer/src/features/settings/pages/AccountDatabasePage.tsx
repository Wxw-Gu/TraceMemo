import { useEffect, useState } from 'react'
import { AccountOverview } from '../account-database/AccountOverview'
import { ConnectionHealthSection } from '../account-database/ConnectionHealthSection'
import { LocalPrivacyNotice } from '../account-database/LocalPrivacyNotice'
import { useAccountDatabaseController } from '../account-database/useAccountDatabaseController'
import type { ConnectionOverviewStatus } from '../account-database/types'
import type { SettingsSelfInfo } from '../model/types'
import type { WechatAccountCandidate } from '../../../../../shared/database-key'

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
  dbConnecting = false,
  selfInfo,
  onNotice,
  onSwitchAccount
}: {
  dbKey: string
  dbReady: boolean
  dbConnecting?: boolean
  selfInfo: SettingsSelfInfo | null
  onNotice: (message: string) => void
  onSwitchAccount: (account: WechatAccountCandidate) => Promise<void>
}): React.ReactElement {
  const controller = useAccountDatabaseController({
    dbKey,
    dbReady,
    dbConnecting,
    selfInfo,
    onNotice
  })
  const [autoLogin, setAutoLogin] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [accounts, setAccounts] = useState<WechatAccountCandidate[]>([])

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

  const openAccountSwitcher = async (): Promise<void> => {
    if (!selfInfo?.accountRoot) return
    const parentRoot = selfInfo.accountRoot.replace(/[\\/][^\\/]+[\\/]?$/, '')
    const result = await window.api.discoverAccounts(parentRoot)
    if (!result.success) {
      onNotice(result.error || '无法读取账号列表')
      return
    }
    setAccounts(result.accounts)
    setSwitching(true)
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
            onSwitchAccount={() => void openAccountSwitcher()}
          />
          {switching && (
            <section className="settings-card database-account-list" aria-label="切换微信账号">
              <h2>选择要切换的账号</h2>
              {accounts.map((account) => (
                <button
                  type="button"
                  key={account.id}
                  className="database-account-card"
                  disabled={account.accountRoot === selfInfo?.accountRoot}
                  onClick={() => void onSwitchAccount(account).then(() => setSwitching(false))}
                >
                  <span className="database-account-avatar">
                    {account.avatar ? (
                      <img src={account.avatar} alt="" />
                    ) : (
                      (account.nickname || '?').charAt(0)
                    )}
                  </span>
                  <span className="database-account-identity">
                    <strong>{account.nickname || '昵称未识别'}</strong>
                    <small>{account.wxid || 'wxid 未识别'}</small>
                    <code>{account.accountRoot}</code>
                  </span>
                  <span className="database-account-status">
                    {account.hasSavedDbKey ? '已有可用密钥' : '需要获取密钥'}
                  </span>
                </button>
              ))}
              <button
                type="button"
                className="api-secondary-button"
                onClick={() => setSwitching(false)}
              >
                取消
              </button>
            </section>
          )}
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
