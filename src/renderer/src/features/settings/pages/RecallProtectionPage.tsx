import { useEffect, useState } from 'react'

export function RecallProtectionPage({ onNotice }: { onNotice: (message: string) => void }): React.ReactElement {
  const [enabled, setEnabled] = useState(false)

  useEffect(() => {
    let active = true
    void window.api.getSettings().then((result) => {
      if (active) setEnabled(result.settings.recallProtectionEnabled)
    })
    return () => {
      active = false
    }
  }, [])

  const changeEnabled = async (checked: boolean): Promise<void> => {
    const result = await window.api.setSettings({ recallProtectionEnabled: checked })
    setEnabled(result.settings.recallProtectionEnabled)
    onNotice(checked ? '已开启防撤回' : '已关闭防撤回')
  }

  return (
    <div className="settings-page">
      <header className="settings-page-header">
        <div>
          <h1>防撤回</h1>
          <p>尽量保留已撤回的聊天内容，并在聊天记录中明确标记。</p>
        </div>
      </header>
      <div className="settings-page-scroll">
        <div className="settings-page-content">
          <h2 className="settings-section-heading">消息处理</h2>
          <section className="settings-card settings-recall-card">
            <div className="settings-recall-grid">
              <label className="settings-recall-option">
                <span>
                  <b>开启防撤回</b>
                  <small>尽量保留已撤回的聊天内容，方便后续查看。</small>
                </span>
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(event) => void changeEnabled(event.target.checked)}
                />
              </label>
              <aside className="settings-recall-notice">
                <strong>性能提示</strong>
                <span>开启后会为消息表增加监听，数据量较大或磁盘较慢时可能让加载变慢。</span>
              </aside>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
