import { useMemo, useState } from 'react'
import { Button, Progress } from '../../../components/ui'
import { useAppUpdateState } from '../../app-update/useAppUpdateState'

const REPOSITORY_URL = 'https://github.com/Wxw-Gu/TraceMemo'
const RELEASES_URL = `${REPOSITORY_URL}/releases`

function formatDataSize(value?: number): string {
  if (!value) return '0 B'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

export function AboutPage({
  onNotice
}: {
  onNotice: (message: string) => void
}): React.ReactElement {
  const update = useAppUpdateState()
  const [busy, setBusy] = useState(false)

  const action = useMemo(() => {
    if (update.status === 'available') {
      return update.delivery === 'release-page' ? '前往下载' : '下载更新'
    }
    if (update.status === 'checking') return '正在检查...'
    if (update.status === 'downloading') return '正在下载...'
    if (update.status === 'installing') return '正在安装...'
    if (update.status === 'error') return '重试'
    return '检查更新'
  }, [update.delivery, update.status])

  const runUpdate = async (): Promise<void> => {
    setBusy(true)
    try {
      const result =
        update.status === 'available' && update.delivery === 'release-page'
          ? await window.api.openAppUpdateDownloadPage()
          : update.status === 'available'
            ? await window.api.downloadAppUpdate()
            : await window.api.checkAppUpdate()
      if (result && !result.success) {
        const message = 'state' in result ? result.state.message : result.error
        onNotice(message || '更新操作失败')
      }
    } finally {
      setBusy(false)
    }
  }

  const installUpdate = async (): Promise<void> => {
    const result = await window.api.installAppUpdate()
    if (!result.success) {
      onNotice(result.error || '更新安装失败')
      return
    }
    if (result.message) onNotice(result.message)
  }

  const percent = Math.max(0, Math.min(100, Math.round(update.percent || 0)))

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
            <div>
              <span className="settings-card-kicker">当前版本</span>
              <strong>TraceMemo（迹忆）</strong>
              <small>v{update.currentVersion}</small>
            </div>
            <a href={REPOSITORY_URL} target="_blank" rel="noreferrer">
              GitHub 仓库
            </a>
          </section>

          <h2 className="settings-section-heading">软件更新</h2>
          <section className={`settings-card update-card status-${update.status}`}>
            <div className="update-card-copy">
              <strong>
                {update.status === 'downloading'
                  ? `正在下载 v${update.version}`
                  : update.status === 'downloaded'
                    ? `v${update.version} 已准备完成`
                    : update.status === 'available'
                      ? `发现新版本 v${update.version}`
                      : update.message || '检查 GitHub Releases 获取最新版本'}
              </strong>
              {update.status === 'downloading' ? (
                <div className="grid gap-2 pt-1">
                  <span className="text-sm font-semibold text-foreground">{percent}%</span>
                  <Progress value={percent} aria-label={`更新下载进度 ${percent}%`} />
                  <div className="flex justify-between gap-4 text-xs">
                    <span>
                      {formatDataSize(update.transferred)} / {formatDataSize(update.total)}
                    </span>
                    <span>{formatDataSize(update.bytesPerSecond)}/s</span>
                  </div>
                </div>
              ) : (
                <span>
                  {update.status === 'downloaded' ? (
                    `更新将在重启 TraceMemo 后生效。${update.isSimulation ? ' 当前为开发模拟模式。' : ''}`
                  ) : update.status === 'available' && update.delivery === 'release-page' ? (
                    <span className="grid gap-1">
                      <span>当前版本：v{update.currentVersion}</span>
                      <span>最新版本：v{update.version}</span>
                    </span>
                  ) : (
                    '会根据当前系统和 CPU 自动选择对应安装包，安装前会等待你的确认。'
                  )}
                </span>
              )}
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              {update.status === 'downloaded' ? (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onNotice('更新已保留，稍后可在此安装')}
                  >
                    稍后
                  </Button>
                  <Button size="sm" onClick={() => void installUpdate()}>
                    立即重启更新
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  disabled={
                    busy ||
                    update.status === 'checking' ||
                    update.status === 'downloading' ||
                    update.status === 'installing'
                  }
                  aria-busy={
                    busy || update.status === 'checking' || update.status === 'downloading'
                  }
                  onClick={() => void runUpdate()}
                >
                  {action}
                </Button>
              )}
            </div>
          </section>

          <h2 className="settings-section-heading">支持</h2>
          <section className="settings-card about-links-card">
            <a href={RELEASES_URL} target="_blank" rel="noreferrer">
              查看历史版本与更新说明
            </a>
            <Button variant="outline" size="sm" onClick={() => void window.api.revealAppLog()}>
              打开诊断日志目录
            </Button>
          </section>
          <p className="settings-footnote">
            聊天数据、密钥和 AI 配置均保留在本机，更新不会上传这些内容。
          </p>
        </div>
      </div>
    </div>
  )
}
