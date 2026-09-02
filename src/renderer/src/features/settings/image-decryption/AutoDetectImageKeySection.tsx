import { Button } from '../../../components/ui'
import type { ImageDecryptionState } from './types'

const PHASE_LABELS = {
  scanning: '扫描中',
  'candidate-found': '发现候选密钥',
  validating: '自动验证图片',
  success: '验证成功',
  saving: '正在保存',
  saved: '已保存'
} as const

export function AutoDetectImageKeySection({
  state,
  disabled,
  canSave,
  onDetect,
  onSave
}: {
  state: ImageDecryptionState
  disabled: boolean
  canSave: boolean
  onDetect: () => void
  onSave: () => void
}): React.ReactElement {
  if (!state.status?.autoDetectSupported) {
    return (
      <section className="settings-card image-auto-unavailable">
        <strong>手动配置图片解密</strong>
        <p>当前平台不支持自动扫描图片密钥，请手动配置。</p>
      </section>
    )
  }

  const directoryReady = state.status.resources.imageDirectory.state === 'available'
  const processReady = state.status.platform !== 'win32' || state.status.wechatRunning
  const autoBusy = ['scanning', 'candidate-found', 'validating', 'saving'].includes(state.autoPhase)
  const showSuccess = state.autoPhase === 'success' || state.autoPhase === 'saved'

  return (
    <section className="settings-card image-auto-detect">
      <div className="image-auto-heading">
        <div>
          <strong>自动获取图片密钥</strong>
          <p>
            {state.status.platform === 'darwin'
              ? '扫描本机微信缓存并通过图片模板验证候选密钥。'
              : '扫描微信进程内存并通过本地图片模板验证候选密钥。'}
            <br />
            <small className="image-auto-scope-hint">仅支持 WeChat 4.0，V3 及以下无法解析</small>
          </p>
        </div>
        <Button
          variant="outline"
          disabled={
            disabled ||
            autoBusy ||
            !processReady ||
            !state.status.accountIdentified ||
            !directoryReady
          }
          onClick={onDetect}
        >
          {state.autoPhase === 'scanning' ? '扫描中…' : '开始自动获取'}
        </Button>
      </div>
      <ul>
        <li className={state.status.wechatRunning ? 'ok' : ''}>
          微信运行状态：{state.status.wechatRunning ? '正在运行' : '未运行'}
        </li>
        <li className={state.status.accountIdentified ? 'ok' : ''}>
          当前账号状态：{state.status.accountIdentified ? '已登录' : '未识别'}
        </li>
        <li className={directoryReady ? 'ok' : ''}>
          图片目录状态：{directoryReady ? '已找到' : '未找到'}
        </li>
      </ul>
      {state.autoPhase !== 'idle' && state.autoPhase !== 'failed' ? (
        <ol className="image-auto-phases">
          {(['scanning', 'candidate-found', 'validating', 'success'] as const).map((phase) => (
            <li
              key={phase}
              className={getPhaseIndex(state.autoPhase) >= getPhaseIndex(phase) ? 'active' : ''}
            >
              {PHASE_LABELS[phase]}
            </li>
          ))}
        </ol>
      ) : null}
      {state.autoProgress ? <p className="image-auto-progress">{state.autoProgress}</p> : null}
      {state.autoError ? <p className="image-auto-error">{state.autoError}</p> : null}
      {showSuccess ? (
        <div className="image-auto-success">
          <strong>图片密钥验证成功</strong>
          <span>发现账号：{state.autoAccount || '当前微信账号'}</span>
          <span>图片解析：正常</span>
          <Button disabled={!canSave} onClick={onSave}>
            {state.autoPhase === 'saved' ? '已保存' : '保存图片密钥'}
          </Button>
        </div>
      ) : null}
    </section>
  )
}

function getPhaseIndex(phase: ImageDecryptionState['autoPhase']): number {
  const order: ImageDecryptionState['autoPhase'][] = [
    'idle',
    'scanning',
    'candidate-found',
    'validating',
    'success',
    'saving',
    'saved'
  ]
  return order.indexOf(phase)
}
