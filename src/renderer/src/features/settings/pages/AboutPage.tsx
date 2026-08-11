import { useEffect, useMemo, useState } from 'react'
import type { AppUpdateState } from '../../../../../shared/app-update'

const REPOSITORY_URL = 'https://github.com/Wxw-Gu/WechatExplorer'
const RELEASES_URL = `${REPOSITORY_URL}/releases`

function formatBytes(value?: number): string {
  if (!value) return ''
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB/s`
  return `${(value / 1024 / 1024).toFixed(1)} MB/s`
}

export function AboutPage({ onNotice }: { onNotice: (message: string) => void }): React.ReactElement {
  const [update, setUpdate] = useState<AppUpdateState>({ status: 'idle', currentVersion: '读取中...' })
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    void window.api.getAppUpdateState().then((state) => active && setUpdate(state))
    const unsubscribe = window.api.onAppUpdateState((state) => {
      if (active) setUpdate(state)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  const action = useMemo(() => {
    if (update.status === 'downloaded') return '重启并安装'
    if (update.status === 'available') return '下载更新'
    if (update.status === 'checking' || update.status === 'downloading') return '处理中...'
    return '检查更新'
  }, [update.status])

  const runUpdate = async (): Promise<void> => {
    setBusy(true)
    try {
      if (update.status === 'downloaded') {
        const result = await window.api.installAppUpdate()
        if (!result.success) onNotice(result.error || '更新安装失败')
      } else if (update.status === 'available') {
        await window.api.downloadAppUpdate()
      } else {
        await window.api.checkAppUpdate()
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-page">
      <header className="settings-page-header">
        <div>
          <h1>关于</h1>
          <p>TraceMemo（迹忆）本地优先、可追溯的 AI 微信知识与分析工作台。</p>
        </div>
      </header>
      <div className="settings-page-scroll">
        <div className="settings-page-content">
          <section className="settings-card about-identity-card">
            <div><span className="settings-card-kicker">当前版本</span><strong>TraceMemo（迹忆）</strong><small>v{update.currentVersion}</small></div>
            <a href={REPOSITORY_URL} target="_blank" rel="noreferrer">GitHub 仓库</a>
          </section>

          <h2 className="settings-section-heading">软件更新</h2>
          <section className={`settings-card update-card status-${update.status}`}>
            <div className="update-card-copy">
              <strong>{update.status === 'available' || update.status === 'downloaded' ? `发现 v${update.version}` : update.message || '检查 GitHub Releases 获取最新版本'}</strong>
              <span>
                {update.status === 'downloading'
                  ? `正在下载 ${Math.round(update.percent || 0)}% · ${formatBytes(update.bytesPerSecond)}`
                  : '会根据当前系统和 CPU 自动选择对应安装包，安装前会等待你的确认。'}
              </span>
              {update.status === 'downloading' && <div className="update-progress"><i style={{ width: `${update.percent || 0}%` }} /></div>}
            </div>
            <button type="button" className="settings-primary-button" disabled={busy || update.status === 'checking' || update.status === 'downloading'} onClick={() => void runUpdate()}>{action}</button>
          </section>

          <h2 className="settings-section-heading">支持</h2>
          <section className="settings-card about-links-card">
            <a href={RELEASES_URL} target="_blank" rel="noreferrer">查看历史版本与更新说明</a>
            <button type="button" onClick={() => void window.api.revealAppLog()}>打开诊断日志目录</button>
          </section>
          <p className="settings-footnote">聊天数据、密钥和 AI 配置均保留在本机，更新不会上传这些内容。</p>
        </div>
      </div>
    </div>
  )
}
