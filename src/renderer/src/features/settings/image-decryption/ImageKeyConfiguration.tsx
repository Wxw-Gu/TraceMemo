import { useState } from 'react'
import type { ImageDecryptionState } from './types'
import { Button, Input } from '../../../components/ui'

/**
 * 密钥显示切换图标。
 *
 * 项目里没有现成的眼睛图标（`LineIcon` 只有 database / shield 之类），
 * 这里就地画一个 16px 线框图标，避免为一处 UI 引入图标依赖。
 */
function EyeIcon({ crossed }: { crossed: boolean }): React.ReactElement {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      <path d="M2.5 12S6 5.75 12 5.75 21.5 12 21.5 12 18 18.25 12 18.25 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.6" />
      {crossed ? <path d="M4.5 4.5l15 15" /> : null}
    </svg>
  )
}

export function ImageKeyConfiguration({
  state,
  disabled,
  onEdit
}: {
  state: ImageDecryptionState
  disabled: boolean
  onEdit: (field: 'xorKey' | 'aesKey', value: string) => void
}): React.ReactElement {
  /**
   * 只控制**本机的显示方式**，不影响任何存储、校验或解密行为：
   * 密钥仍然以 password 语义渲染（浏览器/密码管理器照旧），
   * 切换只是把 input 的 type 换成 text，让用户能核对自己填的 16 位密钥。
   */
  const [revealed, setRevealed] = useState(false)

  return (
    <section className="settings-card image-key-editor">
      <div className="image-key-grid">
        <label>
          <span>XOR Key</span>
          <Input
            value={state.xorKey}
            disabled={disabled}
            onChange={(event) => onEdit('xorKey', event.target.value)}
          />
        </label>
        <label>
          <span>AES Key</span>
          <div className="image-key-secret">
            <Input
              type={revealed ? 'text' : 'password'}
              value={state.aesKey}
              disabled={disabled}
              autoComplete="off"
              placeholder="输入 16 位图片密钥"
              onChange={(event) => onEdit('aesKey', event.target.value)}
            />
            <Button
              size="icon"
              variant="ghost"
              className="image-key-secret-toggle"
              data-testid="image-key-reveal"
              aria-label={revealed ? '隐藏图片密钥' : '显示图片密钥'}
              aria-pressed={revealed}
              title={revealed ? '隐藏图片密钥' : '显示图片密钥'}
              disabled={disabled}
              onClick={() => setRevealed((current) => !current)}
            >
              <EyeIcon crossed={revealed} />
            </Button>
          </div>
        </label>
      </div>
      <p>修改后请先选择会话完成图片解析测试，再确认保存。</p>
    </section>
  )
}
