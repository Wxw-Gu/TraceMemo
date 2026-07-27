import type { ImageDecryptionState } from './types'

type StepState = 'pending' | 'ok' | 'fail' | 'skipped'

function stepClass(step: StepState): string {
  switch (step) {
    case 'ok':
      return 'image-step image-step-ok'
    case 'fail':
      return 'image-step image-step-fail'
    case 'skipped':
      return 'image-step image-step-skipped'
    default:
      return 'image-step image-step-pending'
  }
}

function stepIcon(step: StepState): string {
  switch (step) {
    case 'ok':
      return '✓'
    case 'fail':
      return '×'
    case 'skipped':
      return '·'
    default:
      return '○'
  }
}

function pickSteps(result: {
  fileFound: boolean
  decrypted: boolean
  readable: boolean
  success: boolean
}): { find: StepState; decrypt: StepState; read: StepState } {
  // 三步严格联动：找到失败 → 解密/读取 skipped；解密失败 → 读取 skipped；
  // 解密成功但不可读 → 读取 fail。
  if (!result.fileFound) {
    return { find: 'fail', decrypt: 'skipped', read: 'skipped' }
  }
  if (!result.success && !result.decrypted && !result.readable) {
    // 后端把 fileFound=false 的情况也用 success:false 表达；
    // 此时第一步直接 fail，后两步 skip。
    return { find: 'fail', decrypt: 'skipped', read: 'skipped' }
  }
  if (!result.decrypted) {
    return { find: 'ok', decrypt: 'fail', read: 'skipped' }
  }
  if (!result.readable) {
    return { find: 'ok', decrypt: 'ok', read: 'fail' }
  }
  return { find: 'ok', decrypt: 'ok', read: 'ok' }
}

export function ImageTestSection({
  state,
  disabled,
  canSave,
  onSelect,
  onTest,
  onSave
}: {
  state: ImageDecryptionState
  disabled: boolean
  canSave: boolean
  onSelect: (value: string) => void
  onTest: () => void
  onSave: () => void
}): React.ReactElement {
  const result = state.testResult
  const steps = result
    ? pickSteps({
        fileFound: result.fileFound,
        decrypted: result.decrypted,
        readable: result.readable,
        success: result.success
      })
    : null
  return (
    <section className="settings-card image-test-section">
      <div>
        <strong>图片解析测试</strong>
        <p>选择一条聊天记录测试图片解密能力。</p>
      </div>
      <label htmlFor="image-test-chat">聊天记录</label>
      <select
        id="image-test-chat"
        value={state.selectedUserMd5}
        disabled={disabled}
        onChange={(event) => onSelect(event.target.value)}
      >
        <option value="">请选择会话</option>
        {state.contacts.map((contact) => (
          <option key={contact.md5} value={contact.md5}>
            {contact.m_nsNickName || contact.m_nsUsrName}
          </option>
        ))}
      </select>
      <div className="image-test-actions">
        <button
          className="database-key-primary"
          disabled={disabled || !state.selectedUserMd5}
          onClick={onTest}
        >
          {state.phase === 'testing' ? '正在测试…' : '测试图片解析'}
        </button>
        <button className="database-key-secondary" disabled={!canSave} onClick={onSave}>
          确认保存
        </button>
      </div>
      {steps ? (
        <ol className="image-step-list">
          <li className={stepClass(steps.find)}>
            <span className="image-step-icon">{stepIcon(steps.find)}</span>
            <span>找到图片文件</span>
          </li>
          <li className={stepClass(steps.decrypt)}>
            <span className="image-step-icon">{stepIcon(steps.decrypt)}</span>
            <span>解密成功</span>
          </li>
          <li className={stepClass(steps.read)}>
            <span className="image-step-icon">{stepIcon(steps.read)}</span>
            <span>图片可以读取</span>
          </li>
        </ol>
      ) : state.error ? (
        <p className="image-inline-error">{state.error}</p>
      ) : null}
      {result && !result.success && result.error ? (
        <p className="image-inline-error">{result.error}</p>
      ) : null}
    </section>
  )
}
