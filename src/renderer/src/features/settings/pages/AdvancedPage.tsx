import { useEffect, useState } from 'react'

export function AdvancedPage({
  onNotice
}: {
  onNotice: (message: string) => void
}): React.ReactElement {
  const [debugEnabled, setDebugEnabled] = useState(false)

  useEffect(() => {
    let active = true
    void window.api.getSettings().then((result) => {
      if (active) setDebugEnabled(result.settings.debugEnabled)
    })
    return () => {
      active = false
    }
  }, [])

  const changeDebugEnabled = async (checked: boolean): Promise<void> => {
    const result = await window.api.setSettings({ debugEnabled: checked })
    setDebugEnabled(result.settings.debugEnabled)
    onNotice(checked ? '已开启调试日志' : '已关闭调试日志')
  }

  return (
    <div className="settings-page">
      <header className="settings-page-header">
        <div>
          <h1>高级</h1>
          <p>用于开发人员排查本地数据库和检索问题</p>
        </div>
      </header>
      <div className="settings-page-scroll">
        <div className="settings-page-content">
          <h2 className="settings-section-heading">诊断</h2>
          <section className="settings-card settings-debug-card">
            <label>
              <span>
                <b>显示诊断日志</b>
                <small>开启后，检索页显示诊断日志入口并记录匹配统计，不记录聊天正文。</small>
              </span>
              <input
                type="checkbox"
                checked={debugEnabled}
                onChange={(event) => void changeDebugEnabled(event.target.checked)}
              />
            </label>
            <div className="settings-debug-actions">
              <button type="button" onClick={() => void window.api.revealAppLog()}>
                打开诊断日志
              </button>
              <small>关闭调试日志后，仍会保留错误和崩溃日志。</small>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
