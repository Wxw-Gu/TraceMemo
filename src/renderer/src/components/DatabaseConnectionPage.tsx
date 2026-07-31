import React from 'react'

const GUIDE_URL =
  'https://github.com/Wxw-Gu/WechatExplorer/blob/main/docs/user-guide/getting-started.md'

export type DatabaseConnectionMode = 'automatic' | 'manual'
export type DatabaseConnectionStatusKind = 'normal' | 'success' | 'error'

interface DatabaseConnectionPageProps {
  platform: string
  mode: DatabaseConnectionMode
  dbKey: string
  dbRoot: string
  showDbKey: boolean
  isFetching: boolean
  status: string
  statusKind: DatabaseConnectionStatusKind
  showMacKeyFaq: boolean
  macKeyFaqUrl: string
  onModeChange: (mode: DatabaseConnectionMode) => void
  onDbKeyChange: (value: string) => void
  onDbRootChange: (value: string) => void
  onToggleDbKey: () => void
  onAutoGetKey: () => void
  onManualConnect: () => void
  onPasteKey: () => void
  onClearKey: () => void
}

function LineIcon({
  name
}: {
  name: 'shield' | 'lock' | 'cloud' | 'info' | 'database'
}): React.ReactElement {
  const paths = {
    shield: <path d="M12 3 5 6v5c0 4.5 2.8 7.7 7 10 4.2-2.3 7-5.5 7-10V6l-7-3Z" />,
    lock: <path d="M7 10V8a5 5 0 0 1 10 0v2m-11 0h12v10H6V10Z" />,
    cloud: (
      <path d="m4 4 16 16M7.5 16H6a4 4 0 0 1-.5-8A6.5 6.5 0 0 1 17 6.8M18.5 10A4 4 0 0 1 18 18h-7" />
    ),
    info: <path d="M12 8h.01M11 12h1v4h1M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z" />,
    database: (
      <path d="M5 6c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3Zm0 0v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6m-14 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" />
    )
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {paths[name]}
      </g>
    </svg>
  )
}

function EyeIcon({ visible }: { visible: boolean }): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
      <circle cx="12" cy="12" r="3" />
      {!visible && <path d="M4 4l16 16" />}
    </svg>
  )
}

function StoragePathHelp(): React.ReactElement {
  return (
    <span className="database-login-path-help">
      <span
        className="database-login-path-help-icon"
        tabIndex={0}
        aria-describedby="storage-path-help"
      >
        !
      </span>
      <span id="storage-path-help" className="database-login-path-tooltip" role="tooltip">
        打开微信设置，在缓存管理中复制存储路径，然后粘贴到这里。
      </span>
    </span>
  )
}

export function DatabaseConnectionPage({
  platform,
  mode,
  dbKey,
  dbRoot,
  showDbKey,
  isFetching,
  status,
  statusKind,
  showMacKeyFaq,
  macKeyFaqUrl,
  onModeChange,
  onDbKeyChange,
  onDbRootChange,
  onToggleDbKey,
  onAutoGetKey,
  onManualConnect,
  onPasteKey,
  onClearKey
}: DatabaseConnectionPageProps): React.ReactElement {
  const isMac = platform === 'darwin'
  const defaultPath = isMac
    ? '~/Library/Containers/com.tencent.xinWeChat/Data/Library/Application Support/com.tencent.xinWeChat/'
    : 'C:\\Users\\...\\WeChat Files\\Msg'
  const keyIsValid = /^[0-9a-f]{64}$/i.test(dbKey.trim().replace(/^0x/i, ''))

  return (
    <main className="database-login-page">
      <section className="database-login-brand" aria-label="WechatExplorer 产品说明">
        <div className="database-login-brand-content">
          <div className="database-login-logo" aria-hidden="true">
            <LineIcon name="database" />
          </div>
          <h1>WechatExplorer</h1>
          <p className="database-login-tagline">让 AI 读懂你的微信</p>
          <p className="database-login-description">
            连接成功后，你可以搜索聊天记录、生成群聊日报，并按需使用 AI 分析。
          </p>
          <div className="database-login-promises">
            <div>
              <LineIcon name="shield" />
              <span>仅限本机</span>
            </div>
            <div>
              <LineIcon name="lock" />
              <span>加密保存</span>
            </div>
            <div>
              <LineIcon name="cloud" />
              <span>AI 按需启用</span>
            </div>
          </div>
        </div>
        <div className="database-login-brand-footer">LOCAL-FIRST · PRIVATE · SECURE</div>
      </section>

      <section className="database-login-workspace" aria-label="数据库连接">
        <div className="database-login-panel">
          <div className="database-login-start">
            <p className="database-login-eyebrow">第一次使用</p>
            <h2>开始连接微信</h2>
            <p>跟着下面 3 步操作，通常几分钟即可完成连接。</p>
            <ol>
              <li>
                <span>1</span>
                <div>
                  <strong>确认微信数据目录</strong>
                  <small>没有自动找到时，可在设置中手动选择</small>
                </div>
              </li>
              <li>
                <span>2</span>
                <div>
                  <strong>让微信停在登录页面</strong>
                  <small>不要在获取密钥前完成登录</small>
                </div>
              </li>
              <li>
                <span>3</span>
                <div>
                  <strong>点击自动获取密钥</strong>
                  <small>提示可以登录后，再回到微信完成登录</small>
                </div>
              </li>
            </ol>
            <a
              className="database-login-guide-link"
              href={GUIDE_URL}
              target="_blank"
              rel="noreferrer"
            >
              查看 5 分钟上手教程 →
            </a>
          </div>
          <div className="database-login-tabs" role="tablist" aria-label="连接方式">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'automatic'}
              className={mode === 'automatic' ? 'active' : ''}
              onClick={() => onModeChange('automatic')}
            >
              开始连接
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'manual'}
              className={`database-login-manual-tab ${mode === 'manual' ? 'active' : ''}`}
              onClick={() => onModeChange('manual')}
            >
              高级用户：已有数据库密钥？手动连接
            </button>
          </div>

          {mode === 'automatic' ? (
            <div className="database-login-auto" role="tabpanel">
              <div className={`database-login-state-card ${statusKind}`}>
                <div className="database-login-state-heading">
                  <span className="database-login-state-icon">
                    <LineIcon name="info" />
                  </span>
                  <div>
                    <strong>
                      {statusKind === 'error' ? '未能获取数据库密钥' : '已准备检测微信数据库'}
                    </strong>
                    <p>
                      {statusKind === 'error'
                        ? status
                        : status || '请保持微信客户端正在运行，系统将尝试安全获取数据库密钥。'}
                    </p>
                  </div>
                </div>
                <dl className="database-login-diagnostics">
                  <div>
                    <dt>微信客户端</dt>
                    <dd>{isFetching ? '正在检测' : '等待检测'}</dd>
                  </div>
                  <div>
                    <dt>
                      存储路径
                      <StoragePathHelp />
                    </dt>
                    <dd>
                      <span className="database-login-path-input-wrap">
                        <input
                          type="text"
                          value={dbRoot}
                          onChange={(event) => onDbRootChange(event.target.value)}
                          placeholder={defaultPath}
                          title={dbRoot || defaultPath}
                          aria-label="微信数据存储路径"
                          spellCheck={false}
                          onFocus={(event) => event.currentTarget.select()}
                        />
                        <span className="database-login-path-value" role="status">
                          {dbRoot || defaultPath}
                        </span>
                      </span>
                    </dd>
                  </div>
                  <div>
                    <dt>数据库状态</dt>
                    <dd>{statusKind === 'error' ? '无法连接' : '准备连接'}</dd>
                  </div>
                </dl>
              </div>
              <button
                type="button"
                className="database-login-primary"
                onClick={onAutoGetKey}
                disabled={isFetching}
              >
                {isFetching ? '正在获取密钥…' : statusKind === 'error' ? '重新检测' : '开始获取'}
              </button>
              <p className="database-login-platform-note">
                {isMac ? (
                  <>
                    macOS 首次获取密钥需要关闭 SIP。{' '}
                    <a href={macKeyFaqUrl} target="_blank" rel="noreferrer">
                      查看说明
                    </a>
                  </>
                ) : (
                  'Windows 已完整支持，不需要关闭 SIP。'
                )}
              </p>
              {showMacKeyFaq && isMac && (
                <a href={macKeyFaqUrl} target="_blank" rel="noreferrer">
                  获取失败？查看连接排查
                </a>
              )}
            </div>
          ) : (
            <div className="database-login-manual" role="tabpanel">
              <p className="database-login-manual-note">
                仅适用于已经通过其他方式获得当前微信账号数据库密钥的高级用户。第一次使用请返回“开始连接”。
              </p>
              <div className="database-login-field">
                <label htmlFor="database-login-key">数据库密钥</label>
                <div className="database-login-key-input">
                  <input
                    id="database-login-key"
                    type={showDbKey ? 'text' : 'password'}
                    value={dbKey}
                    onChange={(event) => onDbKeyChange(event.target.value)}
                    placeholder="输入或粘贴 64 位数据库密钥"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    onClick={onToggleDbKey}
                    title={showDbKey ? '隐藏密钥' : '显示密钥'}
                  >
                    <EyeIcon visible={showDbKey} />
                  </button>
                </div>
                <small>密钥通过系统安全存储加密保存在当前设备。</small>
              </div>
              {platform === 'win32' && (
                <div className="database-login-field">
                  <label htmlFor="database-login-root">
                    微信数据目录
                    <StoragePathHelp />
                  </label>
                  <input
                    id="database-login-root"
                    value={dbRoot}
                    onChange={(event) => onDbRootChange(event.target.value)}
                    placeholder={defaultPath}
                    title={dbRoot || defaultPath}
                    spellCheck={false}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                </div>
              )}
              {status && <div className={`database-login-message ${statusKind}`}>{status}</div>}
              <button
                type="button"
                className="database-login-primary"
                onClick={onManualConnect}
                disabled={!keyIsValid}
              >
                连接数据库
              </button>
              <button type="button" className="database-login-secondary" onClick={onPasteKey}>
                从剪贴板粘贴并安全保存
              </button>
            </div>
          )}

          <div className="database-login-footer-actions">
            <button type="button" onClick={onClearKey}>
              清除已保存密钥
            </button>
            <span>WechatExplorer</span>
          </div>
        </div>
      </section>
    </main>
  )
}
