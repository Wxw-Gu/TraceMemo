import { useState } from 'react'

export function DatabaseKeyDangerZone({
  disabled,
  onClear,
  onReplace,
  onReturnToLogin
}: {
  disabled: boolean
  onClear: () => void
  onReplace: () => void
  onReturnToLogin: () => void
}): React.ReactElement {
  const [confirming, setConfirming] = useState(false)
  const [confirmingReturn, setConfirmingReturn] = useState(false)
  return (
    <>
      <section className="database-key-connection-actions">
        <h2>连接管理</h2>
        <div>
          <span>
            <strong>返回登录界面</strong>
            <small>断开当前数据库连接，回到密钥输入界面。不会删除已保存密钥或微信数据。</small>
          </span>
          <button type="button" onClick={() => setConfirmingReturn(true)}>
            返回登录
          </button>
        </div>
      </section>
      <section className="database-key-danger">
        <h2>密钥管理</h2>
        <div>
          <span>
            <strong>清除已保存密钥</strong>
            <small>从系统安全存储中删除密钥，不会删除微信数据库文件。</small>
          </span>
          <button type="button" onClick={() => setConfirming(true)} disabled={disabled}>
            清除密钥
          </button>
        </div>
        <div>
          <span>
            <strong>替换当前密钥</strong>
            <small>回到编辑区输入并验证新的数据库密钥。</small>
          </span>
          <button type="button" onClick={onReplace} disabled={disabled}>
            更换密钥
          </button>
        </div>
      </section>
      {confirming && (
        <div
          className="database-key-confirm-backdrop"
          role="presentation"
          onMouseDown={() => setConfirming(false)}
        >
          <div
            className="database-key-confirm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="database-key-confirm-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 id="database-key-confirm-title">确认清除数据库密钥？</h2>
            <p>
              清除后 TraceMemo
              将暂时无法读取聊天记录，需要重新输入或获取密钥。该操作不会删除微信原始数据。
            </p>
            <div>
              <button type="button" onClick={() => setConfirming(false)}>
                取消
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => {
                  setConfirming(false)
                  onClear()
                }}
              >
                清除密钥
              </button>
            </div>
          </div>
        </div>
      )}
      {confirmingReturn && (
        <div
          className="database-key-confirm-backdrop"
          role="presentation"
          onMouseDown={() => setConfirmingReturn(false)}
        >
          <div
            className="database-key-confirm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="database-key-return-confirm-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 id="database-key-return-confirm-title">返回登录界面？</h2>
            <p>
              TraceMemo
              将断开当前数据库连接并回到密钥输入界面。已保存的数据库密钥和微信原始数据不会被删除。
            </p>
            <div>
              <button type="button" onClick={() => setConfirmingReturn(false)}>
                取消
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmingReturn(false)
                  onReturnToLogin()
                }}
              >
                返回登录
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
