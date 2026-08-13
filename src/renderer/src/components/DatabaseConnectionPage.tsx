import React from 'react'
import type { DatabaseKeyEnvironment, WechatAccountCandidate } from '../../../shared/database-key'
import { WINDOWS_VC_RUNTIME_DOWNLOAD_URL } from '../../../shared/windows-runtime'

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
  isConnecting: boolean
  guideStep: 1 | 2 | 3 | 4 | 5 | 6
  environment?: DatabaseKeyEnvironment
  accounts: WechatAccountCandidate[]
  selectedAccountId: string
  status: string
  statusKind: DatabaseConnectionStatusKind
  showMacKeyFaq: boolean
  macKeyFaqUrl: string
  onModeChange: (mode: DatabaseConnectionMode) => void
  onDbKeyChange: (value: string) => void
  onDbRootChange: (value: string) => void
  onSelectAccount: (account: WechatAccountCandidate) => void
  onSelectDbRoot: () => void
  onToggleDbKey: () => void
  onAutoGetKey: () => void
  onRefreshEnvironment: () => void
  onGuideNext: () => void
  onGuideBack: () => void
  onGuideCancel: () => void
  onValidateConnection: () => void
  onCopyDiagnostics: () => void
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
  isConnecting,
  guideStep,
  environment,
  accounts = [],
  selectedAccountId = '',
  status,
  statusKind,
  showMacKeyFaq,
  macKeyFaqUrl,
  onModeChange,
  onDbKeyChange,
  onDbRootChange,
  onSelectAccount,
  onSelectDbRoot,
  onToggleDbKey,
  onAutoGetKey,
  onRefreshEnvironment,
  onGuideNext,
  onGuideBack,
  onGuideCancel,
  onValidateConnection,
  onCopyDiagnostics,
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
      <section className="database-login-brand" aria-label="TraceMemo（迹忆）产品说明">
        <div className="database-login-brand-content">
          <div className="database-login-logo" aria-hidden="true">
            <LineIcon name="database" />
          </div>
          <h1>TraceMemo（迹忆）</h1>
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
            <p>按顺序检查环境、准备连接组件并验证数据库，通常几分钟即可完成。</p>
            <ol>
              <li>
                <span>1</span>
                <div>
                  <strong>检查本机环境</strong>
                  <small>确认微信版本、数据目录和运行状态</small>
                </div>
              </li>
              <li>
                <span>2</span>
                <div>
                  <strong>准备连接组件</strong>
                  <small>页面会按当前系统给出对应步骤</small>
                </div>
              </li>
              <li>
                <span>3</span>
                <div>
                  <strong>登录并验证连接</strong>
                  <small>验证通过后进入主界面</small>
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
              <div className="database-login-guide-progress" aria-label={`连接进度 ${guideStep}/6`}>
                {Array.from({ length: 6 }, (_, index) => (
                  <span key={index} className={index + 1 <= guideStep ? 'active' : ''} />
                ))}
              </div>
              <div className={`database-login-state-card ${statusKind}`}>
                <div className="database-login-state-heading">
                  <span className="database-login-state-icon">
                    <LineIcon name="info" />
                  </span>
                  <div>
                    <strong>
                      {statusKind === 'error'
                        ? '当前步骤未完成'
                        : [
                            '检查本机环境',
                            '让微信停在登录页面',
                            '确认开始准备',
                            `正在完成 ${isMac ? 'macOS' : 'Windows'} 授权`,
                            '获取成功, 现在可以重新登录微信了',
                            '验证数据库连接'
                          ][guideStep - 1]}
                    </strong>
                    <p>
                      {statusKind === 'error'
                        ? status
                        : status ||
                          [
                            '确认下方检测结果；没有找到目录时可以手动选择。',
                            '请退出当前微信账号，让微信停留在登录页面，然后点击“我已准备好”。',
                            '开始后请按页面提示完成系统授权。',
                            '正在准备连接组件，请不要关闭微信或 TraceMemo。',
                            '请回到微信完成登录，登录成功后再回来验证。',
                            '正在验证密钥和本地数据库，请稍候。'
                          ][guideStep - 1]}
                    </p>
                  </div>
                </div>
                {guideStep === 1 && (
                  <>
                    <dl className="database-login-diagnostics">
                      <div>
                        <dt>操作系统</dt>
                        <dd>{environment?.osVersion || (isMac ? 'macOS' : 'Windows')}</dd>
                      </div>
                      <div>
                        <dt>微信版本</dt>
                        <dd>{environment?.wechatVersion || '未检测到'}</dd>
                      </div>
                      <div>
                        <dt>数据结构</dt>
                        <dd>{environment?.dataStructureVersion || '未检测到'}</dd>
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
                          <button
                            type="button"
                            className="database-login-path-select"
                            onClick={onSelectDbRoot}
                            disabled={isFetching || isConnecting}
                          >
                            选择目录
                          </button>
                        </dd>
                      </div>
                      <div>
                        <dt>微信状态</dt>
                        <dd>{environment?.wechatRunning ? '运行中' : '未检测到'}</dd>
                      </div>
                    </dl>
                    {accounts.length > 0 && (
                      <section className="database-account-list" aria-label="选择微信账号">
                        <h3>选择微信账号</h3>
                        {accounts.map((account) => (
                          <button
                            type="button"
                            key={account.id}
                            className={`database-account-card ${selectedAccountId === account.id ? 'selected' : ''}`}
                            aria-pressed={selectedAccountId === account.id}
                            onClick={() => onSelectAccount(account)}
                          >
                            <span className="database-account-avatar">
                              {account.avatar ? (
                                <img src={account.avatar} alt="" />
                              ) : (
                                (account.nickname || account.directoryName || '?').charAt(0)
                              )}
                            </span>
                            <span className="database-account-identity">
                              <strong>
                                {account.nickname ||
                                  (account.wxid
                                    ? `微信账号 ${account.wxid}`
                                    : `账号目录 ${account.directoryName || '待识别'}`)}
                              </strong>
                              <small>
                                {account.nickname
                                  ? account.wxid || '微信号未读取'
                                  : account.wxid
                                    ? '昵称和头像需连接此账号后读取'
                                    : '连接后读取微信号、昵称和头像'}
                              </small>
                              <code title={account.accountRoot}>{account.accountRoot}</code>
                            </span>
                            <span className="database-account-status">
                              {account.hasSavedDbKey ? '已有可用密钥' : '尚无可用密钥'}
                              <small>
                                {account.loginStatus === 'current'
                                  ? '当前已连接账号'
                                  : account.loginStatus === 'other'
                                    ? '非当前账号'
                                    : '登录状态未确认'}
                              </small>
                            </span>
                          </button>
                        ))}
                        <button
                          type="button"
                          className="database-login-secondary"
                          onClick={onSelectDbRoot}
                          disabled={isFetching || isConnecting}
                        >
                          选择其他账号
                        </button>
                      </section>
                    )}
                  </>
                )}
              </div>
              {guideStep === 1 && (
                <>
                  <button
                    type="button"
                    className="database-login-primary"
                    onClick={onGuideNext}
                    disabled={!selectedAccountId}
                  >
                    检查完成，继续
                  </button>
                  <button
                    type="button"
                    className="database-login-secondary"
                    onClick={onRefreshEnvironment}
                  >
                    重新检查环境
                  </button>
                  <button
                    type="button"
                    className="database-login-text-action"
                    onClick={onCopyDiagnostics}
                  >
                    复制脱敏诊断摘要
                  </button>
                </>
              )}
              {guideStep === 2 && (
                <button type="button" className="database-login-primary" onClick={onGuideNext}>
                  我已准备好
                </button>
              )}
              {guideStep === 3 && (
                <button type="button" className="database-login-primary" onClick={onAutoGetKey}>
                  开始准备连接组件
                </button>
              )}
              {guideStep === 4 && (
                <button type="button" className="database-login-primary" disabled>
                  正在准备连接组件…
                </button>
              )}
              {guideStep === 5 && (
                <button
                  type="button"
                  className="database-login-primary"
                  onClick={onValidateConnection}
                  disabled={!dbKey || isConnecting}
                >
                  {isConnecting ? '正在验证…' : '验证连接'}
                </button>
              )}
              {guideStep === 6 && (
                <button type="button" className="database-login-primary" disabled>
                  正在验证数据库…
                </button>
              )}
              {guideStep > 1 && !isFetching && !isConnecting && (
                <div className="database-login-guide-actions">
                  <button type="button" onClick={onGuideBack}>
                    返回上一步
                  </button>
                  <button type="button" onClick={onGuideCancel}>
                    取消并重新检查
                  </button>
                </div>
              )}
              {(isFetching || isConnecting) && (
                <button
                  type="button"
                  className="database-login-text-action"
                  onClick={onGuideCancel}
                >
                  取消
                </button>
              )}
              <p className="database-login-platform-note">
                {isMac ? (
                  <>
                    macOS 首次获取密钥需要关闭 SIP。{' '}
                    <a href={macKeyFaqUrl} target="_blank" rel="noreferrer">
                      查看说明
                    </a>
                  </>
                ) : (
                  <>
                    Windows 需要 Microsoft Visual C++ 2015-2022 x64 运行库。{' '}
                    <a href={WINDOWS_VC_RUNTIME_DOWNLOAD_URL} target="_blank" rel="noreferrer">
                      下载运行库
                    </a>
                  </>
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
                  <div className="database-login-root-control">
                    <input
                      id="database-login-root"
                      aria-label="微信数据目录"
                      value={dbRoot}
                      onChange={(event) => onDbRootChange(event.target.value)}
                      placeholder={defaultPath}
                      title={dbRoot || defaultPath}
                      spellCheck={false}
                      onFocus={(event) => event.currentTarget.select()}
                    />
                    <button type="button" onClick={onSelectDbRoot} disabled={isConnecting}>
                      选择目录
                    </button>
                  </div>
                </div>
              )}
              {status && <div className={`database-login-message ${statusKind}`}>{status}</div>}
              {platform === 'win32' && (
                <p className="database-login-platform-note">
                  无法加载数据库组件时，请安装 Microsoft Visual C++ 2015-2022 x64 运行库。{' '}
                  <a href={WINDOWS_VC_RUNTIME_DOWNLOAD_URL} target="_blank" rel="noreferrer">
                    下载运行库
                  </a>
                </p>
              )}
              <button
                type="button"
                className="database-login-primary"
                onClick={onManualConnect}
                disabled={!keyIsValid || isConnecting}
              >
                {isConnecting ? '正在连接…' : '连接数据库'}
              </button>
              {isConnecting && (
                <button
                  type="button"
                  className="database-login-text-action"
                  onClick={onGuideCancel}
                >
                  取消连接
                </button>
              )}
              <button
                type="button"
                className="database-login-secondary"
                onClick={onPasteKey}
                disabled={isConnecting}
              >
                从剪贴板粘贴并安全保存
              </button>
            </div>
          )}

          <div className="database-login-footer-actions">
            <button type="button" onClick={onClearKey}>
              清除已保存密钥
            </button>
            <span>TraceMemo</span>
          </div>
        </div>
      </section>
    </main>
  )
}
