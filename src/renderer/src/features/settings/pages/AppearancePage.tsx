import { useEffect, useState } from 'react'
import { RadioGroup, RadioGroupItem, Switch } from '../../../components/ui'

export type AppearanceTheme = 'system' | 'light' | 'dark'
/** 关闭主窗口时的行为。与主进程 settings-store 的 `CloseAction` 保持一致。 */
export type CloseAction = 'ask' | 'tray' | 'quit'

export function AppearancePage({
  onNotice,
  onAppearanceChange
}: {
  onNotice: (message: string) => void
  onAppearanceChange: (settings: { theme: AppearanceTheme; compactMode: boolean }) => void
}): React.ReactElement {
  const [theme, setTheme] = useState<AppearanceTheme>('system')
  const [compactMode, setCompactMode] = useState(false)
  const [showStartupProgress, setShowStartupProgress] = useState(true)
  const [closeAction, setCloseAction] = useState<CloseAction>('ask')

  useEffect(() => {
    let active = true
    void window.api.getSettings().then((result) => {
      if (!active) return
      setTheme(result.settings.appearanceTheme)
      setCompactMode(result.settings.compactMode)
      setShowStartupProgress(result.settings.showStartupProgress)
      setCloseAction(result.settings.closeAction)
      onAppearanceChange({
        theme: result.settings.appearanceTheme,
        compactMode: result.settings.compactMode
      })
    })
    return () => {
      active = false
    }
  }, [onAppearanceChange])

  const save = async (patch: {
    appearanceTheme?: AppearanceTheme
    compactMode?: boolean
    showStartupProgress?: boolean
    closeAction?: CloseAction
  }): Promise<void> => {
    const result = await window.api.setSettings(patch)
    setTheme(result.settings.appearanceTheme)
    setCompactMode(result.settings.compactMode)
    setShowStartupProgress(result.settings.showStartupProgress)
    setCloseAction(result.settings.closeAction)
    onAppearanceChange({
      theme: result.settings.appearanceTheme,
      compactMode: result.settings.compactMode
    })
    onNotice('外观设置已保存')
  }

  return (
    <div className="settings-page">
      <header className="settings-page-header">
        <div>
          <h1>外观与行为</h1>
          <p>调整工作区的显示方式和启动体验。</p>
        </div>
      </header>
      <div className="settings-page-scroll">
        <div className="settings-page-content">
          <h2 className="settings-section-heading">显示主题</h2>
          <section className="settings-card settings-option-card">
            <RadioGroup
              className="settings-choice-grid"
              value={theme}
              onValueChange={(value) => {
                if (value === 'system' || value === 'light' || value === 'dark')
                  void save({ appearanceTheme: value })
              }}
            >
              {(
                [
                  ['system', '跟随系统', '根据 macOS 或 Windows 外观自动切换'],
                  ['light', '浅色', '保持当前清爽的浅色工作区'],
                  ['dark', '深色', '降低夜间浏览时的亮度']
                ] as const
              ).map(([value, label, hint]) => (
                <label
                  className={`settings-choice ${theme === value ? 'active' : ''}`}
                  key={value}
                  htmlFor={`appearance-theme-${value}`}
                >
                  <RadioGroupItem
                    id={`appearance-theme-${value}`}
                    value={value}
                    className="mt-0.5"
                  />
                  <span>
                    <b>{label}</b>
                    <small>{hint}</small>
                  </span>
                </label>
              ))}
            </RadioGroup>
          </section>

          <h2 className="settings-section-heading">工作区行为</h2>
          <section className="settings-card settings-toggle-list">
            <label className="settings-toggle-row">
              <span>
                <b>紧凑布局</b>
                <small>减少导航栏和列表的留白，适合较小窗口。</small>
              </span>
              <Switch
                checked={compactMode}
                onCheckedChange={(checked) => void save({ compactMode: checked })}
                aria-label="紧凑布局"
              />
            </label>
            <label className="settings-toggle-row">
              <span>
                <b>显示启动进度</b>
                <small>启动或自动连接数据库时显示详细进度。</small>
              </span>
              <Switch
                checked={showStartupProgress}
                onCheckedChange={(checked) => void save({ showStartupProgress: checked })}
                aria-label="显示启动进度"
              />
            </label>
          </section>

          <h2 className="settings-section-heading">关闭窗口时</h2>
          <section className="settings-card settings-option-card">
            <RadioGroup
              className="settings-choice-grid"
              value={closeAction}
              onValueChange={(value) => {
                if (value === 'ask' || value === 'tray' || value === 'quit')
                  void save({ closeAction: value })
              }}
            >
              {(
                [
                  ['ask', '每次询问', '每次关闭窗口都弹出选择框'],
                  ['tray', '最小化到托盘', '窗口隐藏，应用继续在后台运行'],
                  ['quit', '退出应用', '直接结束整个 TraceMemo 进程']
                ] as const
              ).map(([value, label, hint]) => (
                <label
                  className={`settings-choice ${closeAction === value ? 'active' : ''}`}
                  key={value}
                  htmlFor={`appearance-close-${value}`}
                >
                  <RadioGroupItem
                    id={`appearance-close-${value}`}
                    value={value}
                    className="mt-0.5"
                  />
                  <span>
                    <b>{label}</b>
                    <small>{hint}</small>
                  </span>
                </label>
              ))}
            </RadioGroup>
            <p className="settings-option-hint">
              选择「每次询问」时，关闭弹窗里勾选「记住我的选择」会自动切换到这里对应的项。
            </p>
          </section>
        </div>
      </div>
    </div>
  )
}
