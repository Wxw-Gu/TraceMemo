import type {
  ApiResponse,
  ApiServiceState,
  ApiTokenStatus,
  RequestHistoryItem
} from '../model/types'
import { type ReactElement } from 'react'
import { isLoopbackHost } from '../utils/buildApiUrl'
import { formatJson, formatResponseSize, inferResponseCount } from '../utils/formatResponse'

interface Props {
  service: ApiServiceState | null
  tokenStatus: ApiTokenStatus | null
  revealedToken: string
  dbReady: boolean
  response: ApiResponse | null
  history: RequestHistoryItem[]
  onControl: (action: 'start' | 'stop' | 'restart') => void
  onOpenSettings: () => void
  onCopy: (text: string, message: string) => Promise<void>
  onRevealToken: () => Promise<void>
  onHideToken: () => void
  onCopyToken: () => Promise<void>
  onRotateToken: () => Promise<void>
}

export function ApiRuntimePanel({
  service,
  tokenStatus,
  revealedToken,
  dbReady,
  response,
  history,
  onControl,
  onOpenSettings,
  onCopy,
  onRevealToken,
  onHideToken,
  onCopyToken,
  onRotateToken
}: Props): ReactElement {
  const host = service?.host || '127.0.0.1'
  const port = service?.port || 6131
  const localOnly = isLoopbackHost(host)
  const copyAddress = (): void => void onCopy(`http://${host}:${port}`, '监听地址已复制')
  return (
    <aside className="api-runtime-panel" id="api-runtime-panel">
      <div className="api-runtime-scroll">
        <section>
          <div className="api-runtime-title">
            <h2>运行状态</h2>
            <span className={service?.running ? 'ready' : 'stopped'}>
              {service?.running ? 'API 已启用' : '已停止'}
            </span>
          </div>
          <dl>
            <div>
              <dt>监听地址</dt>
              <dd>
                {host}:{port}
              </dd>
            </div>
            <div>
              <dt>数据库</dt>
              <dd className={dbReady ? 'ready-text' : ''}>{dbReady ? '已连接' : '未连接'}</dd>
            </div>
            <div>
              <dt>鉴权方式</dt>
              <dd>{tokenStatus?.hasToken ? 'Bearer Token' : '不可用'}</dd>
            </div>
            <div>
              <dt>访问范围</dt>
              <dd className={localOnly ? 'ready-text' : 'warning-text'}>
                {localOnly ? '仅本机访问' : '可能被局域网访问'}
              </dd>
            </div>
          </dl>
          {service?.error && <p className="api-inline-error">{service.error}</p>}
          <div className="api-runtime-actions">
            {service?.running ? (
              <button type="button" onClick={() => onControl('stop')}>
                停止服务
              </button>
            ) : (
              <button
                type="button"
                className="api-primary-button"
                onClick={() => onControl('start')}
              >
                启动服务
              </button>
            )}
            <button type="button" onClick={() => onControl('restart')}>
              重启服务
            </button>
            <button type="button" onClick={copyAddress}>
              复制地址
            </button>
            <button type="button" onClick={onOpenSettings}>
              API 设置
            </button>
          </div>
        </section>
        {!localOnly && (
          <p className="api-security-warning">
            当前服务可能被局域网设备访问。Bearer Token 不能替代可信网络边界。
          </p>
        )}
        <section className="api-token-section">
          <div className="api-runtime-title">
            <h3>API Token</h3>
            <span className={tokenStatus?.hasToken ? 'ready' : 'stopped'}>
              {tokenStatus?.hasToken ? 'Token 已生成' : 'Token 不可用'}
            </span>
          </div>
          <code className="api-token-value">
            {revealedToken || tokenStatus?.maskedToken || '••••••••••••••••'}
          </code>
          {tokenStatus?.error && <p className="api-inline-error">{tokenStatus.error}</p>}
          <div className="api-runtime-actions">
            <button
              type="button"
              disabled={!tokenStatus?.hasToken}
              onClick={() => void (revealedToken ? onHideToken() : onRevealToken())}
            >
              {revealedToken ? '隐藏 Token' : '显示 Token'}
            </button>
            <button
              type="button"
              disabled={!tokenStatus?.hasToken}
              onClick={() => void onCopyToken()}
            >
              复制 Token
            </button>
            <button
              type="button"
              disabled={!tokenStatus?.available}
              onClick={() => void onRotateToken()}
            >
              重新生成 Token
            </button>
          </div>
        </section>
        <section>
          <h3>最近响应</h3>
          {response ? (
            <>
              <div className="api-response-summary">
                <span>
                  {response.endpoint.method} {response.endpoint.path}
                </span>
                <b className={response.status < 300 ? 'ready-text' : 'warning-text'}>
                  {response.status}
                </b>
              </div>
              <pre>{formatJson(response.text)}</pre>
              <p className="api-response-meta">
                耗时 {response.durationMs}ms · 大小 {formatResponseSize(response.responseSize)}
                {inferResponseCount(response.data) !== null
                  ? ` · ${inferResponseCount(response.data)} 条`
                  : ''}
              </p>
              <button
                type="button"
                onClick={() => void onCopy(formatJson(response.text), 'JSON 响应已复制')}
              >
                复制 JSON
              </button>
            </>
          ) : (
            <p className="api-empty-text">尚未在本页面发起测试请求。</p>
          )}
        </section>
        <section id="api-request-history">
          <h3>本次调试历史</h3>
          {history.length ? (
            <ol className="api-history">
              {history.map((item) => (
                <li key={item.id}>
                  <span>
                    {item.method} {item.path}
                  </span>
                  <b className={item.success ? 'ready-text' : 'warning-text'}>{item.status}</b>
                  <small>
                    {new Date(item.timestamp).toLocaleTimeString()} · {item.durationMs}ms
                  </small>
                </li>
              ))}
            </ol>
          ) : (
            <p className="api-empty-text">仅记录本页面主动发出的最近 30 条请求。</p>
          )}
        </section>
        <section className="api-privacy">
          <h3>隐私说明</h3>
          <p>
            {localOnly
              ? '本地 API 默认监听 127.0.0.1。TraceMemo 不会通过该接口自动把聊天内容发送到云端。外部 Agent 是否调用第三方模型，取决于其自身配置。'
              : '当前服务并非仅本机访问。请确认局域网环境可信；API Token 不等同于公网安全防护。'}
          </p>
        </section>
      </div>
    </aside>
  )
}
