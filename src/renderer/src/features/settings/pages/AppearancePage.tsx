import { useEffect, useState } from 'react'
import { RadioGroup, RadioGroupItem, Switch } from '../../../components/ui'

export type AppearanceTheme = 'system' | 'light' | 'dark'

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

  useEffect(() => {
    let active = true
    void window.api.getSettings().then((result) => {
      if (!active) return
      setTheme(result.settings.appearanceTheme)
      setCompactMode(result.settings.compactMode)
      setShowStartupProgress(result.settings.showStartupProgress)
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
  }): Promise<void> => {
    const result = await window.api.setSettings(patch)
    setTheme(result.settings.appearanceTheme)
    setCompactMode(result.settings.compactMode)
    setShowStartupProgress(result.settings.showStartupProgress)
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
        </div>
      </div>
    </div>
  )
}
