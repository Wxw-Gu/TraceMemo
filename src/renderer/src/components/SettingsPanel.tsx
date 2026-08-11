// Legacy fallback: SETTINGS-01 moved the default entry to features/settings.
// Keep this panel intact until its database-key, image-key, AI and API sections are migrated.
import React, { useEffect, useState } from 'react'

interface SelfInfo {
  wxid: string
  nickname: string
  avatar?: string
  accountRoot: string
}

interface AppSettings {
  dbRoot: string
  apiEnabled: boolean
  apiHost: string
  apiPort: number
  imageKeyRoot: string
  imageXorKey: string
  imageAesKey: string
}

interface ApiState {
  running: boolean
  host: string
  port: number
  error?: string
}

interface AiModelConfig {
  apiKey: string
  baseURL: string
  model: string
}

interface SettingsPanelProps {
  open: boolean
  selfInfo: SelfInfo | null
  dbReady: boolean
  dbKey: string
  aiModelConfig: AiModelConfig
  onClose: () => void
  onDbKeyChange: (key: string) => void
  onAiModelConfigChange: (config: AiModelConfig) => void
  onSaveAiModelConfig: () => void
  onDbRootChanged: () => void
}

const AI_MODEL_OPTIONS = [
  { value: 'deepseek-chat', label: 'DeepSeek Chat' },
  { value: 'gpt-4o', label: 'GPT-4o' },
  { value: 'gpt-4o-mini', label: 'GPT-4o Mini' },
  { value: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
  { value: 'claude-3-5-sonnet-20240620', label: 'Claude 3.5 Sonnet' },
  { value: 'moonshot-v1-8k', label: 'Moonshot V1' }
]

export const SettingsPanel: React.FC<SettingsPanelProps> = ({
  open,
  selfInfo,
  dbReady,
  dbKey,
  aiModelConfig,
  onClose,
  onDbKeyChange,
  onAiModelConfigChange,
  onSaveAiModelConfig,
  onDbRootChanged
}) => {
  const isWindows = window.electron.process.platform === 'win32'
  const dbRootPlaceholder = isWindows
    ? 'C:\\Users\\你\\Documents\\WeChat Files'
    : '~/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files'
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [settingsPath, setSettingsPath] = useState('')
  const [apiState, setApiState] = useState<ApiState | null>(null)
  const [testStatus, setTestStatus] = useState<{
    kind: 'idle' | 'ok' | 'fail'
    message: string
    wxid?: string
    accountRoot?: string
  }>({ kind: 'idle', message: '' })
  const [reopenStatus, setReopenStatus] = useState<string>('')
  const [imageKeyStatus, setImageKeyStatus] = useState<{
    kind: 'idle' | 'ok' | 'fail'
    message: string
  }>({ kind: 'idle', message: '' })
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    void refresh()
  }, [open])

  useEffect(() => {
    if (!open) return
    return window.api.onImageKeyStatus(({ message }) => {
      setImageKeyStatus({ kind: 'idle', message })
    })
  }, [open])

  async function refresh(): Promise<void> {
    const [{ settings, settingsPath }, api] = await Promise.all([
      window.api.getSettings(),
      window.api.apiStatus()
    ])
    setSettings(settings)
    setSettingsPath(settingsPath)
    setApiState(api)
  }

  if (!open) return null

  async function handleSave(patch: Partial<AppSettings>): Promise<void> {
    if (!settings) return
    setBusy(true)
    const next = await window.api.setSettings(patch)
    setSettings(next.settings)
    setBusy(false)
  }

  async function handleTest(): Promise<void> {
    setTestStatus({ kind: 'idle', message: '测试中...' })
    setBusy(true)
    try {
      const result = await window.api.testConnection(dbKey, settings?.dbRoot)
      if (result.success) {
        setTestStatus({
          kind: 'ok',
          message: '连接成功',
          wxid: result.wxid,
          accountRoot: result.accountRoot
        })
        if (result.accountRoot && settings && result.accountRoot !== settings.dbRoot) {
          const next = await window.api.setSettings({ dbRoot: result.accountRoot })
          setSettings(next.settings)
        }
      } else {
        setTestStatus({ kind: 'fail', message: result.error || '连接失败' })
      }
    } catch (error) {
      setTestStatus({
        kind: 'fail',
        message: error instanceof Error ? error.message : String(error)
      })
    } finally {
      setBusy(false)
    }
  }

  async function handleReopen(): Promise<void> {
    if (!settings) return
    setBusy(true)
    setReopenStatus('重新初始化中...')
    try {
      const result = await window.api.reopenWithRoot(settings.dbRoot)
      if (result.success) {
        setReopenStatus(`已重新打开:${result.info?.wxid || '未知'}`)
        onDbRootChanged()
      } else {
        setReopenStatus(result.error || '重新打开失败')
      }
    } catch (error) {
      setReopenStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function handleApiToggle(enabled: boolean): Promise<void> {
    setBusy(true)
    await handleSave({ apiEnabled: enabled })
    const state = await window.api.apiToggle(enabled)
    setApiState(state)
    setBusy(false)
  }

  async function handleApiRestart(): Promise<void> {
    if (!settings) return
    setBusy(true)
    await window.api.apiStop()
    const state = await window.api.apiStart(settings.apiHost, settings.apiPort)
    setApiState(state)
    setBusy(false)
  }

  async function handleAutoGetImageKey(): Promise<void> {
    if (!settings) return
    setBusy(true)
    setImageKeyStatus({ kind: 'idle', message: '正在扫描微信内存获取图片密钥...' })
    try {
      const result = await window.api.autoGetImageKey()
      if (!result.success || !result.aesKey) {
        setImageKeyStatus({ kind: 'fail', message: result.error || '图片密钥获取失败' })
        return
      }
      const imageXorKey =
        result.imageXorKey ||
        (typeof result.xorKey === 'number'
          ? `0x${result.xorKey.toString(16).toUpperCase().padStart(2, '0')}`
          : settings.imageXorKey)
      const imageAesKey = result.imageAesKey || result.aesKey
      setSettings(result.settings || { ...settings, imageXorKey, imageAesKey })
      setImageKeyStatus({
        kind: 'ok',
        message: result.verified ? '图片密钥已获取并校验通过' : '图片密钥已获取，未完成模板校验'
      })
    } catch (error) {
      setImageKeyStatus({
        kind: 'fail',
        message: error instanceof Error ? error.message : String(error)
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>设置</h2>
          <button className="settings-close" onClick={onClose} title="关闭">
            ×
          </button>
        </div>

        <div className="settings-body">
          {/* 自我信息卡片 */}
          <section className="settings-section">
            <div className="settings-section-title">账号信息</div>
            {dbReady && selfInfo ? (
              <div className="settings-self">
                <div className="settings-self-avatar">
                  {selfInfo.avatar ? (
                    <img
                      src={selfInfo.avatar}
                      alt={selfInfo.nickname}
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    (selfInfo.nickname || selfInfo.wxid || '?').charAt(0)
                  )}
                </div>
                <div className="settings-self-info">
                  <div className="settings-self-nickname">{selfInfo.nickname}</div>
                  <div className="settings-self-wxid">{selfInfo.wxid}</div>
                  <div className="settings-self-account">{selfInfo.accountRoot}</div>
                </div>
              </div>
            ) : (
              <div className="settings-self-empty">尚未连接数据库</div>
            )}
          </section>

          {/* 测试连接 */}
          <section className="settings-section">
            <div className="settings-section-title">连接测试</div>
            <div className="settings-row">
              <button
                className="settings-btn settings-btn-primary"
                onClick={handleTest}
                disabled={busy || !dbKey}
              >
                测试连接
              </button>
              {testStatus.kind !== 'idle' && (
                <span className={`settings-status ${testStatus.kind}`}>
                  {testStatus.kind === 'ok' ? '✓' : '✗'} {testStatus.message}
                  {testStatus.wxid ? ` · ${testStatus.wxid}` : ''}
                  {testStatus.accountRoot ? ` · ${testStatus.accountRoot}` : ''}
                </span>
              )}
            </div>
            <div className="settings-hint">
              使用当前密钥 + 下方配置的根目录尝试打开数据库,只校验不持久化。
            </div>
          </section>

          {/* 解密密钥 */}
          <section className="settings-section">
            <div className="settings-section-title">解密密钥</div>
            <div className="settings-row">
              <input
                type="text"
                className="settings-input"
                value={dbKey}
                onChange={(e) => onDbKeyChange(e.target.value)}
                placeholder="64 位 hex 密钥,如 0x..."
                spellCheck={false}
              />
            </div>
            <div className="settings-hint">
              密钥通过系统 safeStorage 加密保存在本机，不会上传任何服务器。
            </div>
          </section>

          {/* 图片解密密钥 */}
          <section className="settings-section">
            <div className="settings-section-title">图片解密密钥</div>
            <div className="settings-row">
              <input
                type="text"
                className="settings-input"
                value={settings?.imageKeyRoot || settings?.dbRoot || ''}
                onChange={(e) =>
                  setSettings(settings ? { ...settings, imageKeyRoot: e.target.value } : null)
                }
                onBlur={(e) => handleSave({ imageKeyRoot: e.target.value })}
                placeholder={dbRootPlaceholder}
                spellCheck={false}
              />
            </div>
            <div className="settings-row">
              <input
                type="text"
                className="settings-input settings-input-quarter"
                value={settings?.imageXorKey ?? ''}
                onChange={(e) =>
                  setSettings(settings ? { ...settings, imageXorKey: e.target.value } : null)
                }
                onBlur={(e) => handleSave({ imageXorKey: e.target.value })}
                placeholder="XOR Key，如 0x40"
                spellCheck={false}
              />
              <input
                type="text"
                className="settings-input"
                value={settings?.imageAesKey ?? ''}
                onChange={(e) =>
                  setSettings(settings ? { ...settings, imageAesKey: e.target.value } : null)
                }
                onBlur={(e) => handleSave({ imageAesKey: e.target.value })}
                placeholder="AES Key，16 位字符"
                spellCheck={false}
              />
              <button className="settings-btn" onClick={handleAutoGetImageKey} disabled={busy}>
                内存扫描图片密钥
              </button>
            </div>
            {imageKeyStatus.message && (
              <div className={`settings-status ${imageKeyStatus.kind}`}>
                {imageKeyStatus.kind === 'ok' ? '✓ ' : imageKeyStatus.kind === 'fail' ? '✗ ' : ''}
                {imageKeyStatus.message}
              </div>
            )}
            <div className="settings-hint">
              目录默认使用数据库根目录，用于查找图片模板文件。Windows
              会直接扫描微信内存，请先在微信中打开 2-3 张图片大图。
            </div>
          </section>

          {/* 数据库根目录 */}
          <section className="settings-section">
            <div className="settings-section-title">数据库根目录</div>
            <div className="settings-row">
              <input
                type="text"
                className="settings-input"
                value={settings?.dbRoot ?? ''}
                onChange={(e) =>
                  setSettings(settings ? { ...settings, dbRoot: e.target.value } : null)
                }
                onBlur={(e) => handleSave({ dbRoot: e.target.value })}
                placeholder={dbRootPlaceholder}
                spellCheck={false}
              />
            </div>
            <div className="settings-row">
              <button className="settings-btn" onClick={handleReopen} disabled={busy || !dbReady}>
                应用并重新初始化
              </button>
              {reopenStatus && <span className="settings-status">{reopenStatus}</span>}
            </div>
            <div className="settings-hint">
              可填写微信数据总目录或具体账号目录。Windows 通常是 Documents\WeChat Files，macOS
              通常是 xwechat_files；程序会自动选择包含 db_storage/session.db 的账号目录。
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-section-title">AI 模型配置</div>
            <div className="settings-row">
              <select
                className="settings-input settings-input-half"
                value={aiModelConfig.model}
                onChange={(event) =>
                  onAiModelConfigChange({ ...aiModelConfig, model: event.target.value })
                }
              >
                {AI_MODEL_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <button className="settings-btn" onClick={onSaveAiModelConfig}>
                保存 AI 配置
              </button>
            </div>
            <div className="settings-row">
              <input
                type="text"
                className="settings-input"
                value={aiModelConfig.baseURL}
                onChange={(event) =>
                  onAiModelConfigChange({ ...aiModelConfig, baseURL: event.target.value })
                }
                placeholder="https://api.deepseek.com"
                spellCheck={false}
              />
            </div>
            <div className="settings-row">
              <input
                type="password"
                className="settings-input"
                value={aiModelConfig.apiKey}
                onChange={(event) =>
                  onAiModelConfigChange({ ...aiModelConfig, apiKey: event.target.value })
                }
                placeholder="API Key"
                spellCheck={false}
              />
            </div>
            <div className="settings-hint">
              所选内容会发送至你配置的模型服务进行处理。配置沿用原有本地 localStorage 保存方式。
            </div>
          </section>

          {/* API 服务 */}
          <section className="settings-section">
            <div className="settings-section-title">本地 HTTP API</div>
            <div className="settings-row">
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={settings?.apiEnabled ?? false}
                  onChange={(e) => handleApiToggle(e.target.checked)}
                  disabled={busy}
                />
                <span>启用 API 服务(127.0.0.1:6131)</span>
              </label>
              {apiState && (
                <span className={`settings-status ${apiState.running ? 'ok' : 'fail'}`}>
                  {apiState.running ? '运行中' : '已停止'}
                  {apiState.error ? ` · ${apiState.error}` : ''}
                </span>
              )}
            </div>
            <div className="settings-row">
              <input
                type="text"
                className="settings-input settings-input-half"
                value={settings?.apiHost ?? ''}
                onChange={(e) =>
                  setSettings(settings ? { ...settings, apiHost: e.target.value } : null)
                }
                onBlur={(e) => handleSave({ apiHost: e.target.value })}
                placeholder="host"
                spellCheck={false}
              />
              <input
                type="number"
                className="settings-input settings-input-quarter"
                value={settings?.apiPort ?? 6131}
                onChange={(e) =>
                  setSettings(
                    settings ? { ...settings, apiPort: Number(e.target.value) || 6131 } : null
                  )
                }
                onBlur={(e) => handleSave({ apiPort: Number(e.target.value) || 6131 })}
                placeholder="port"
              />
              <button className="settings-btn" onClick={handleApiRestart} disabled={busy}>
                重启 API
              </button>
            </div>
            <div className="settings-hint">
              API 默认仅监听本机，并通过 Bearer Token 保护数据接口。Token 请在 API Center
              中显示或复制。关闭后 Claude / Codex 等客户端无法读取聊天数据。
              <br />
              配置文档：<code>docs/skill/tracememo-reader/SKILL.md</code>
            </div>
          </section>

          {/* 配置文件位置 */}
          <section className="settings-section">
            <div className="settings-section-title">配置文件</div>
            <div className="settings-row">
              <code className="settings-path">{settingsPath}</code>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
