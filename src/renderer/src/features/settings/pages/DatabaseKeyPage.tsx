import { DatabaseKeyAutoDetect } from '../database-key/DatabaseKeyAutoDetect'
import { DatabaseKeyDangerZone } from '../database-key/DatabaseKeyDangerZone'
import { DatabaseKeyDiagnostics } from '../database-key/DatabaseKeyDiagnostics'
import { DatabaseKeyEditor } from '../database-key/DatabaseKeyEditor'
import { DatabaseKeyStatus } from '../database-key/DatabaseKeyStatus'
import { DatabaseKeyValidation } from '../database-key/DatabaseKeyValidation'
import { useDatabaseKeyController } from '../database-key/useDatabaseKeyController'
import type { Contact } from '../../../../../shared/types'
import type { SettingsSelfInfo } from '../model/types'

const STATUS_LABELS = {
  saved: '已安全保存',
  unconfigured: '尚未配置',
  validating: '正在验证',
  invalid: '验证失败'
}

export function DatabaseKeyPage({
  dbKey,
  dbReady,
  selfInfo,
  onDbKeyChange,
  onDatabaseConnectionChange,
  onSelfInfoChange,
  onContactsChange,
  onFilteredContactsChange,
  onReturnToLogin,
  onNotice
}: {
  dbKey: string
  dbReady: boolean
  selfInfo: SettingsSelfInfo | null
  onDbKeyChange: (key: string) => void
  onDatabaseConnectionChange: (connected: boolean) => void
  onSelfInfoChange: (info: SettingsSelfInfo | null) => void
  onContactsChange: (contacts: Contact[]) => void
  onFilteredContactsChange: (contacts: Contact[]) => void
  onReturnToLogin: () => void
  onNotice: (message: string) => void
}): React.ReactElement {
  const controller = useDatabaseKeyController({
    dbKey,
    dbReady,
    selfInfo,
    onDbKeyChange,
    onDatabaseConnectionChange,
    onSelfInfoChange,
    onContactsChange,
    onFilteredContactsChange,
    onReturnToLogin,
    onNotice
  })

  const scrollToEditor = (): void => {
    document.getElementById('database-key-editor')?.scrollIntoView({ behavior: 'smooth' })
    window.setTimeout(() => document.getElementById('wechat-db-key')?.focus(), 250)
  }

  return (
    <div className="settings-page database-key-page">
      <header className="settings-page-header">
        <div>
          <h1>数据库密钥</h1>
          <p>管理用于读取本机微信数据库的解密密钥</p>
        </div>
        <span className={`settings-status-badge database-key-badge ${controller.pageStatus}`}>
          {STATUS_LABELS[controller.pageStatus]}
        </span>
      </header>
      <div className="settings-page-scroll">
        <div className="settings-page-content database-key-content">
          <section className="settings-privacy-notice">
            <svg viewBox="0 0 24 24" aria-hidden>
              <path d="M12 3 5.5 5.7v5.2c0 4.3 2.7 8.2 6.5 10.1 3.8-1.9 6.5-5.8 6.5-10.1V5.7L12 3Z" />
            </svg>
            <div>
              <strong>密钥仅保存在本机</strong>
              <p>
                TraceMemo
                使用数据库密钥读取本机微信数据库。密钥通过系统安全存储加密保存，不会写入普通日志，也不会上传到服务器。
              </p>
            </div>
          </section>

          <h2 className="settings-section-heading">当前状态</h2>
          <DatabaseKeyStatus
            state={controller.state}
            dbReady={dbReady}
            selfInfo={selfInfo}
            disabled={controller.isBusy || !dbKey}
            onValidate={() => void controller.validateKey()}
          />

          <h2 className="settings-section-heading">编辑密钥</h2>
          <DatabaseKeyEditor
            value={dbKey}
            disabled={controller.isBusy}
            canSave={controller.canSave}
            onChange={controller.editKey}
            onPaste={() => void controller.pasteKey()}
            onValidate={() => void controller.validateKey()}
            onSave={() => void controller.saveKey()}
          />
          <DatabaseKeyValidation state={controller.state} />

          <h2 className="settings-section-heading">自动获取密钥</h2>
          <DatabaseKeyAutoDetect
            state={controller.state}
            disabled={controller.isBusy}
            onDetect={() => void controller.autoDetectKey()}
            onRefresh={() => void controller.refreshEnvironment()}
          />

          <h2 className="settings-section-heading">安全说明</h2>
          <div className="database-key-security-info">
            <span>
              <strong>系统加密</strong>密钥通过操作系统安全存储加密保存。
            </span>
            <span>
              <strong>账号对应</strong>验证会确认密钥可读取当前微信账号数据库。
            </span>
            <span>
              <strong>无损清除</strong>清除密钥不会删除任何微信数据库文件。
            </span>
          </div>

          <DatabaseKeyDiagnostics
            state={controller.state}
            input={dbKey}
            wxid={selfInfo?.wxid}
            accountRoot={selfInfo?.accountRoot}
            onCopy={() => void controller.copyDiagnostics()}
          />
          <DatabaseKeyDangerZone
            disabled={controller.isBusy || !controller.state.saved}
            onClear={() => void controller.clearSavedKey()}
            onReplace={scrollToEditor}
            onReturnToLogin={() => void controller.returnToLogin()}
          />
        </div>
      </div>
    </div>
  )
}
