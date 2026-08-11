import React from 'react'
import type {
  AgentHubLogEntry,
  AgentHubLogSource,
  AgentHubStatus,
  WechatConnectorStatus
} from '../../../../shared/agent-hub'

const STATUS_LABELS: Record<WechatConnectorStatus, string> = {
  checking: '正在检查',
  disconnected: '未连接',
  starting: '正在连接',
  waiting_scan: '等待扫码',
  scanned: '已扫码，等待手机确认',
  online: '在线',
  error: '连接异常'
}

const LOG_SOURCE_LABELS: Record<AgentHubLogSource, string> = {
  system: '系统',
  'agent-hub': 'Agent Hub',
  'wechat-connector': '微信连接器'
}

export function AgentHubWorkspace(): React.ReactElement {
  const [status, setStatus] = React.useState<AgentHubStatus>({
    hub: 'offline',
    connector: 'checking',
    updatedAt: Date.now()
  })
  const [busy, setBusy] = React.useState(false)
  const [logs, setLogs] = React.useState<AgentHubLogEntry[]>([])
  const [logSource, setLogSource] = React.useState<'all' | AgentHubLogSource>('all')
  const logBodyRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    let mounted = true
    void window.api.getAgentHubStatus().then((next) => {
      if (mounted) setStatus(next)
    })
    void window.api.getAgentHubLogs().then((entries) => {
      if (mounted) setLogs(entries)
    })
    const unsubscribe = window.api.onAgentHubStatus((next) => {
      if (mounted) setStatus(next)
    })
    const unsubscribeLog = window.api.onAgentHubLog((entry) => {
      if (mounted) setLogs((current) => [...current.slice(-799), entry])
    })
    return () => {
      mounted = false
      unsubscribe()
      unsubscribeLog()
    }
  }, [])

  const visibleLogs = logs.filter((entry) => logSource === 'all' || entry.source === logSource)

  React.useEffect(() => {
    const body = logBodyRef.current
    if (body) body.scrollTop = body.scrollHeight
  }, [visibleLogs.length])

  const copyLogs = async (): Promise<void> => {
    const text = visibleLogs
      .map(
        (entry) =>
          `${new Date(entry.timestamp).toLocaleTimeString()} [${LOG_SOURCE_LABELS[entry.source]}] [${entry.level}] ${entry.message}`
      )
      .join('\n')
    await window.api.copyText(text)
  }

  const clearLogs = async (): Promise<void> => {
    await window.api.clearAgentHubLogs()
    setLogs([])
  }

  const runAction = async (
    action: () => Promise<{ status: AgentHubStatus; error?: string }>
  ): Promise<void> => {
    setBusy(true)
    try {
      const result = await action()
      setStatus(result.status)
    } finally {
      setBusy(false)
    }
  }

  const isLoginFlow = ['starting', 'waiting_scan', 'scanned'].includes(status.connector)
  const showQRCode = Boolean(status.qrCodeDataUrl) && status.connector !== 'online'

  return (
    <div className="agent-hub-workspace">
      <header className="agent-hub-header">
        <div>
          <div className="agent-hub-eyebrow">TraceMemo</div>
          <h1>Agent Hub</h1>
          <p>让微信机器人安全调用聊天数据与 AI 能力。</p>
        </div>
        <span className={`agent-hub-runtime ${status.hub}`}>
          Agent Hub {status.hub === 'online' ? '运行中' : '未运行'}
        </span>
      </header>

      <div className="agent-hub-grid">
        <section className="agent-hub-card agent-hub-login-card">
          <div className="agent-hub-card-heading">
            <div>
              <span className="agent-hub-card-kicker">微信机器人</span>
              <h2>连接微信</h2>
            </div>
            <span className={`agent-hub-status ${status.connector}`}>
              <i aria-hidden />
              {STATUS_LABELS[status.connector]}
            </span>
          </div>

          {showQRCode ? (
            <div className="agent-hub-qr-panel">
              <div className="agent-hub-qr-frame">
                <img src={status.qrCodeDataUrl} alt="微信机器人登录二维码" />
              </div>
              <div className="agent-hub-qr-copy">
                <h3>
                  {status.connector === 'scanned' ? '请在手机上确认登录' : '使用微信扫描二维码'}
                </h3>
                <p>二维码仅用于机器人账号登录，不会读取你的微信密码。</p>
                <button
                  type="button"
                  className="agent-hub-button secondary"
                  disabled={busy}
                  onClick={() => void runAction(() => window.api.cancelAgentHubLogin())}
                >
                  取消
                </button>
              </div>
            </div>
          ) : status.connector === 'online' ? (
            <div className="agent-hub-connected">
              <div className="agent-hub-connected-icon" aria-hidden>
                ✓
              </div>
              <div>
                <h3>微信机器人已连接</h3>
                <p>{status.accountId || status.wechatUserId || '登录凭据已就绪'}</p>
              </div>
            </div>
          ) : (
            <div className="agent-hub-empty-login">
              <div className="agent-hub-phone" aria-hidden>
                <span />
              </div>
              <h3>{status.connector === 'error' ? '连接遇到问题' : '尚未连接微信机器人'}</h3>
              <p>{status.error || '扫码登录后，即可从微信向 Agent Hub 提问。'}</p>
            </div>
          )}

          <div className="agent-hub-actions">
            {status.connector === 'online' ? (
              <>
                <button
                  type="button"
                  className="agent-hub-button secondary"
                  disabled={busy}
                  onClick={() => void runAction(() => window.api.startAgentHubLogin())}
                >
                  重新扫码登录
                </button>
                <button
                  type="button"
                  className="agent-hub-button danger"
                  disabled={busy}
                  onClick={() => void runAction(() => window.api.disconnectAgentHub())}
                >
                  断开连接
                </button>
              </>
            ) : !isLoginFlow ? (
              <button
                type="button"
                className="agent-hub-button primary"
                disabled={busy || status.hub !== 'online'}
                onClick={() => void runAction(() => window.api.startAgentHubLogin())}
              >
                {busy ? '正在获取二维码…' : '扫码登录微信机器人'}
              </button>
            ) : null}
          </div>
        </section>

        <aside className="agent-hub-card agent-hub-capability-card">
          <span className="agent-hub-card-kicker">已启用能力</span>
          <h2>微信数据助手</h2>
          <p>机器人通过本机 Agent Hub 调用 TraceMemo，不向公网暴露数据库。</p>
          <div className="agent-hub-example">
            <span>支持自然语言，可以这样问</span>
            <strong>“最近 5 条消息是谁？”</strong>
            <strong>“帮我看看最近跟xx聊了些什么”</strong>
            <strong>“生成产品交流群今天的群聊总结图片”</strong>
          </div>
          <ul>
            <li>
              <i />
              本机 HTTP 通信
            </li>
            <li>
              <i />
              入站请求鉴权
            </li>
            <li>
              <i />
              消息重复保护
            </li>
            <li>
              <i />
              使用已配置 AI 理解自然语言
            </li>
            <li>
              <i className={status.dataApi === 'online' ? '' : 'offline'} />
              本地数据 API：{status.dataApi === 'online' ? '已连接' : '未连接'}
            </li>
            <li>
              <i className={status.databaseReady ? '' : 'offline'} />
              微信数据库：{status.databaseReady ? '可查询' : '未就绪'}
            </li>
          </ul>
        </aside>
      </div>

      <section className="agent-hub-card agent-hub-log-card">
        <div className="agent-hub-log-heading">
          <div>
            <span className="agent-hub-card-kicker">故障诊断</span>
            <h2>运行日志</h2>
          </div>
          <div className="agent-hub-log-actions">
            <select
              aria-label="筛选日志来源"
              value={logSource}
              onChange={(event) => setLogSource(event.target.value as 'all' | AgentHubLogSource)}
            >
              <option value="all">全部来源</option>
              <option value="system">系统</option>
              <option value="agent-hub">Agent Hub</option>
              <option value="wechat-connector">微信连接器</option>
            </select>
            <button
              type="button"
              onClick={() => void copyLogs()}
              disabled={visibleLogs.length === 0}
            >
              复制日志
            </button>
            <button type="button" onClick={() => void clearLogs()}>
              清空
            </button>
          </div>
        </div>
        <div className="agent-hub-log-body" ref={logBodyRef}>
          {visibleLogs.length === 0 ? (
            <div className="agent-hub-log-empty">
              暂无运行日志。收到消息后，这里会显示处理到哪一步。
            </div>
          ) : (
            visibleLogs.map((entry) => (
              <div className={`agent-hub-log-line ${entry.level}`} key={entry.id}>
                <time>{new Date(entry.timestamp).toLocaleTimeString()}</time>
                <span className={`source ${entry.source}`}>{LOG_SOURCE_LABELS[entry.source]}</span>
                <code>{entry.message}</code>
              </div>
            ))
          )}
        </div>
        <p className="agent-hub-log-note">日志会隐藏 Token 和二维码数据，不记录你的微信密码。</p>
      </section>
    </div>
  )
}
