import type { SettingsSelfInfo } from '../model/types'
import { Button } from '../../../components/ui'
import type { ImageDecryptionState } from './types'
import { formatImageConfigTime } from './utils'

export function ImageDecryptStatus({
  state,
  selfInfo,
  disabled,
  onValidate
}: {
  state: ImageDecryptionState
  selfInfo: SettingsSelfInfo | null
  disabled: boolean
  onValidate: () => void
}): React.ReactElement {
  return (
    <section className="settings-card image-decrypt-status">
      <dl>
        <div>
          <dt>图片密钥</dt>
          <dd className={state.config?.configured ? 'image-state-success' : 'image-state-muted'}>
            {state.config?.configured ? '已配置' : '未配置'}
          </dd>
        </div>
        <div>
          <dt>当前账号</dt>
          <dd>{selfInfo?.nickname || '尚未识别'}</dd>
        </div>
        <div>
          <dt>wxid</dt>
          <dd className="image-decrypt-mono" title={selfInfo?.wxid}>
            {selfInfo?.wxid || '—'}
          </dd>
        </div>
        <div>
          <dt>最近验证</dt>
          <dd>{formatImageConfigTime(state.config?.updatedAt)}</dd>
        </div>
        <div className="image-decrypt-wide">
          <dt>图片资源目录</dt>
          <dd className="image-decrypt-mono" title={state.status?.resourceRoot}>
            {state.status?.resourceRoot || '尚未定位'}
          </dd>
        </div>
        <div>
          <dt>缓存状态</dt>
          <dd
            className={
              state.status?.cacheState === 'normal' ? 'image-state-success' : 'image-state-error'
            }
          >
            {state.status?.cacheState === 'normal' ? '正常' : '不可用'}
          </dd>
        </div>
      </dl>
      {state.config?.configured ? (
        <Button variant="outline" disabled={disabled} onClick={onValidate}>
          重新验证
        </Button>
      ) : null}
    </section>
  )
}
