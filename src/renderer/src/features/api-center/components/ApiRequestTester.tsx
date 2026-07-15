import type { ApiEndpoint, ApiServiceState, ApiSettings } from '../model/types'
import { type ReactElement } from 'react'
import { buildApiUrl } from '../utils/buildApiUrl'

interface Props {
  endpoint: ApiEndpoint
  settings: ApiSettings | null
  service: ApiServiceState | null
  params: Record<string, string>
  body: string
  state: 'idle' | 'loading' | 'success' | 'error'
  error: string
  onParams: (params: Record<string, string>) => void
  onBody: (body: string) => void
  onSend: () => void
  onClear: () => void
  onCopyCurl: (command: string) => Promise<void>
}

export function ApiRequestTester({
  endpoint,
  settings,
  service,
  params,
  body,
  state,
  error,
  onParams,
  onBody,
  onSend,
  onClear,
  onCopyCurl
}: Props): ReactElement {
  const url = settings ? buildApiUrl(settings.apiHost, settings.apiPort, endpoint.path, params) : ''
  const copyCurl = (): void => {
    const command =
      endpoint.method === 'POST'
        ? `curl -X POST '${url}' -H 'Content-Type: application/json' -d '${body.replaceAll("'", "\\'")}'`
        : `curl '${url}'`
    void onCopyCurl(command)
  }
  const update = (key: string, value: string): void => onParams({ ...params, [key]: value })
  const selectTestImage = async (): Promise<void> => {
    const result = await window.api.selectAgentHubTestImage()
    if (result.canceled || !result.path) return
    let payload: Record<string, unknown> = {}
    try {
      payload = JSON.parse(body) as Record<string, unknown>
    } catch {
      // Replace an invalid draft with a valid send-test request.
    }
    onBody(JSON.stringify({ ...payload, media_url: result.path }, null, 2))
  }
  return (
    <section className="api-request-tester" id="api-request-tester">
      <div className="api-section-heading">
        <h2>快速测试</h2>
        <span>轻量本地调试</span>
      </div>
      <div className="api-request-meta">
        <span className={`api-method ${endpoint.method.toLowerCase()}`}>{endpoint.method}</span>
        <code>{url || endpoint.path}</code>
      </div>
      {endpoint.parameters?.length ? (
        <div className="api-param-grid">
          {endpoint.parameters.map((parameter) => (
            <label key={parameter.key}>
              <span>
                {parameter.label}
                {parameter.required && <b>必填</b>}
              </span>
              <input
                value={params[parameter.key] || ''}
                onChange={(event) => update(parameter.key, event.target.value)}
                placeholder={parameter.placeholder}
              />
            </label>
          ))}
        </div>
      ) : null}
      {endpoint.body && (
        <label className="api-json-input">
          <span>JSON 请求体</span>
          <textarea
            value={body}
            onChange={(event) => onBody(event.target.value)}
            spellCheck={false}
          />
        </label>
      )}
      {endpoint.id === 'agent-send' && (
        <div className="api-upload-test-row">
          <button type="button" onClick={() => void selectTestImage()}>
            选择测试图片
          </button>
          <span>选择后只会填入本地路径；点击“发送请求”才会真正发送。</span>
        </div>
      )}
      <div className="api-tester-actions">
        <button type="button" onClick={onClear}>
          清空
        </button>
        <button type="button" onClick={copyCurl}>
          复制 curl
        </button>
        <button
          type="button"
          className="api-primary-button"
          disabled={!service?.running || state === 'loading'}
          onClick={onSend}
        >
          {state === 'loading'
            ? '发送中…'
            : service?.running
              ? '发送请求'
              : '请先启动本地 API 服务'}
        </button>
      </div>
      {error && <p className="api-inline-error">{error}</p>}
    </section>
  )
}
