import type { ImageDecryptionState } from './types'

export function ImageKeyConfiguration({
  state,
  disabled,
  onEdit
}: {
  state: ImageDecryptionState
  disabled: boolean
  onEdit: (field: 'xorKey' | 'aesKey', value: string) => void
}): React.ReactElement {
  return (
    <section className="settings-card image-key-editor">
      <div className="image-key-grid">
        <label>
          <span>XOR Key</span>
          <input
            value={state.xorKey}
            disabled={disabled}
            onChange={(event) => onEdit('xorKey', event.target.value)}
          />
        </label>
        <label>
          <span>AES Key</span>
          <input
            type="password"
            value={state.aesKey}
            disabled={disabled}
            autoComplete="off"
            placeholder="输入 16 位图片密钥"
            onChange={(event) => onEdit('aesKey', event.target.value)}
          />
        </label>
      </div>
      <p>修改后请先选择会话完成图片解析测试，再确认保存。</p>
    </section>
  )
}
