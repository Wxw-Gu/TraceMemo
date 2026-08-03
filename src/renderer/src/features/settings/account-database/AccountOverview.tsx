import type { SettingsSelfInfo } from '../model/types'
import type { ConnectionOverviewStatus } from './types'

function CopyIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="8" y="8" width="11" height="11" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </svg>
  )
}

const CONNECTION_LABELS: Record<ConnectionOverviewStatus, string> = {
  checking: '正在检测',
  success: '连接正常',
  warning: '部分能力不可用',
  error: '连接异常',
  unavailable: '尚未连接'
}

export function AccountOverview({
  selfInfo,
  connectionStatus,
  lastCheckedLabel,
  isChecking,
  onCheck,
  onOpenDirectory,
  onCopyDirectory,
  onSwitchAccount
}: {
  selfInfo: SettingsSelfInfo | null
  connectionStatus: ConnectionOverviewStatus
  lastCheckedLabel: string
  isChecking: boolean
  onCheck: () => void
  onOpenDirectory: () => void
  onCopyDirectory: () => void
  onSwitchAccount: () => void
}): React.ReactElement {
  const accountRoot = selfInfo?.accountRoot || ''
  return (
    <section className="settings-card settings-account-overview">
      <div className="settings-account-primary">
        <div className="settings-avatar">
          {selfInfo?.avatar ? (
            <img src={selfInfo.avatar} alt="当前账号" referrerPolicy="no-referrer" />
          ) : (
            (selfInfo?.nickname || '?').charAt(0)
          )}
        </div>
        <div className="settings-account-identity">
          <span>昵称</span>
          <strong>{selfInfo?.nickname || '暂无数据'}</strong>
          <small title={selfInfo?.wxid || undefined}>{selfInfo?.wxid || '暂无 WXID'}</small>
        </div>
      </div>

      <dl className="settings-account-facts">
        <div>
          <dt>数据库连接状态</dt>
          <dd className={`settings-connection-text ${connectionStatus}`}>
            {CONNECTION_LABELS[connectionStatus]}
          </dd>
        </div>
        <div>
          <dt>最近检测时间</dt>
          <dd>{lastCheckedLabel}</dd>
        </div>
      </dl>

      <div className="settings-account-actions">
        <button
          type="button"
          className="api-primary-button"
          onClick={onCheck}
          disabled={isChecking}
        >
          {isChecking ? '正在检测...' : '重新检测'}
        </button>
        <button
          type="button"
          className="api-secondary-button"
          onClick={onOpenDirectory}
          disabled={!accountRoot}
        >
          打开账号目录
        </button>
        <button type="button" className="api-secondary-button" onClick={onSwitchAccount}>
          切换账号
        </button>
      </div>

      <div className="settings-account-root">
        <span>当前账号目录</span>
        <div>
          <code title={accountRoot || undefined}>{accountRoot || '暂无数据'}</code>
          <button
            type="button"
            className="settings-icon-button"
            title="复制账号目录"
            aria-label="复制账号目录"
            onClick={onCopyDirectory}
            disabled={!accountRoot}
          >
            <CopyIcon />
          </button>
        </div>
      </div>
    </section>
  )
}
