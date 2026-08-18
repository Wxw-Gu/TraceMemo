import { useState } from 'react'
import { Button, IconButton, Input } from '../../../components/ui'

function EyeIcon({ visible }: { visible: boolean }): React.ReactElement {
  return visible ? (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6Z" />
      <circle cx="12" cy="12" r="2.6" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="m4 4 16 16M10.6 6.2A9.6 9.6 0 0 1 12 6c5.5 0 9 6 9 6a15 15 0 0 1-2.1 2.8M14.8 14.8A4 4 0 0 1 9.2 9.2M6.1 7.1C4.2 8.7 3 12 3 12s3.5 6 9 6c1 0 2-.2 2.9-.6" />
    </svg>
  )
}

export function DatabaseKeyEditor({
  value,
  disabled,
  canSave,
  onChange,
  onPaste,
  onValidate,
  onSave
}: {
  value: string
  disabled: boolean
  canSave: boolean
  onChange: (value: string) => void
  onPaste: () => void
  onValidate: () => void
  onSave: () => void
}): React.ReactElement {
  const [visible, setVisible] = useState(false)
  return (
    <section id="database-key-editor" className="settings-card database-key-editor">
      <label htmlFor="wechat-db-key">WeChat DB Key</label>
      <div className="database-key-input-row">
        <Input
          id="wechat-db-key"
          type={visible ? 'text' : 'password'}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          placeholder="输入 64 位十六进制数据库密钥"
          autoComplete="off"
          spellCheck={false}
        />
        <IconButton
          variant="ghost"
          label={visible ? '隐藏密钥' : '显示密钥'}
          tooltip={visible ? '隐藏密钥' : '显示密钥'}
          type="button"
          onClick={() => setVisible((current) => !current)}
          disabled={disabled}
        >
          <EyeIcon visible={visible} />
        </IconButton>
        <IconButton
          type="button"
          variant="ghost"
          label="从剪贴板粘贴"
          onClick={onPaste}
          disabled={disabled}
        >
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M9 5h6M9 3h6v4H9zM7 5H5v16h14V5h-2" />
          </svg>
        </IconButton>
        <IconButton
          variant="ghost"
          label="清空当前输入"
          type="button"
          onClick={() => onChange('')}
          disabled={disabled || !value}
        >
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </IconButton>
      </div>
      <p>保存前会验证密钥格式、数据库可读性和当前账号身份。</p>
      <div className="database-key-actions">
        <Button
          variant="secondary"
          type="button"
          className="database-key-secondary"
          onClick={onValidate}
          disabled={disabled || !value}
        >
          验证密钥
        </Button>
        <Button
          variant="default"
          type="button"
          className="database-key-primary"
          onClick={onSave}
          disabled={disabled || !canSave}
        >
          保存密钥
        </Button>
      </div>
    </section>
  )
}
