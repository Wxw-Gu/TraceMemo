import type { SettingsSelfInfo } from '../model/types'
import type { DatabaseKeyState } from './types'
import { formatValidationTime } from './utils'
import { Button } from '../../../components/ui'

export function DatabaseKeyStatus({
  state,
  dbReady,
  selfInfo,
  disabled,
  onValidate
}: {
  state: DatabaseKeyState
  dbReady: boolean
  selfInfo: SettingsSelfInfo | null
  disabled: boolean
  onValidate: () => void
}): React.ReactElement {
  return (
    <section className="settings-card database-key-status-card">
      <dl>
        <div>
          <dt>密钥状态</dt>
          <dd>{state.saved ? '已配置' : '未配置'}</dd>
        </div>
        <div>
          <dt>存储方式</dt>
          <dd>{state.encryptionAvailable ? '系统安全存储' : '系统安全存储不可用'}</dd>
        </div>
        <div>
          <dt>当前账号</dt>
          <dd>{selfInfo?.nickname || '尚未识别'}</dd>
        </div>
        <div>
          <dt>wxid</dt>
          <dd className="database-key-mono">{selfInfo?.wxid || state.validation?.wxid || '—'}</dd>
        </div>
        <div>
          <dt>最近验证</dt>
          <dd>{formatValidationTime(state.lastValidatedAt)}</dd>
        </div>
        <div>
          <dt>数据库状态</dt>
          <dd className={dbReady ? 'database-key-success' : 'database-key-muted'}>
            {dbReady ? '连接正常' : '尚未连接'}
          </dd>
        </div>
      </dl>
      <Button variant="outline" onClick={onValidate} disabled={disabled}>
        重新验证
      </Button>
    </section>
  )
}
