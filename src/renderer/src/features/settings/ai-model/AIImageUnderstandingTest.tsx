import type { AIProviderSummary, AIRuntimeModelConfig } from '../../../../../shared/ai-provider'
import type { AIVisionTestState } from './types'

export function AIImageUnderstandingTest({
  runtime,
  provider,
  state,
  onSelectImage,
  onPromptChange,
  onTest,
  onClear
}: {
  runtime: AIRuntimeModelConfig | null
  provider?: AIProviderSummary
  state: AIVisionTestState
  onSelectImage: (file: File) => void
  onPromptChange: (prompt: string) => void
  onTest: () => void
  onClear: () => void
}): React.ReactElement {
  const model = provider?.models.find((item) => item.id === runtime?.model)
  const testing = state.status === 'testing'
  const result = state.result
  return (
    <section className="settings-card ai-vision-test">
      <header>
        <div>
          <h2>AI 能力测试</h2>
          <h3>图片理解测试</h3>
          <p>上传图片验证当前模型是否支持视觉理解。</p>
        </div>
        <span className={`ai-vision-capability ${model?.capabilities.vision ? 'supported' : ''}`}>
          图片理解 {model?.capabilities.vision ? '✓' : '待验证'}
        </span>
      </header>

      <div className="ai-vision-model">
        <span>当前供应商：{runtime?.providerName || '尚未配置'}</span>
        <span>当前模型：{runtime?.modelName || '尚未选择'}</span>
      </div>

      <label className={`ai-vision-upload ${state.image ? 'has-image' : ''}`}>
        <input
          type="file"
          accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0]
            if (file) onSelectImage(file)
            event.currentTarget.value = ''
          }}
        />
        {state.image ? (
          <>
            <img src={state.image.dataUrl} alt="图片理解测试预览" />
            <div>
              <strong>{state.image.fileName}</strong>
              <small>{formatFileSize(state.image.size)} · 仅保存在内存中</small>
            </div>
          </>
        ) : (
          <div>
            <strong>{state.status === 'reading' ? '正在读取图片…' : '选择本地图片'}</strong>
            <small>支持 PNG、JPG、JPEG、WebP，最大 10 MB</small>
          </div>
        )}
      </label>

      <label className="ai-vision-prompt">
        识别提示词
        <textarea
          value={state.prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          rows={3}
        />
      </label>

      <p className="ai-vision-privacy">
        图片只会发送给你配置的 AI 服务，不会上传到 TraceMemo 的其他服务器，也不会写入本地缓存。
      </p>

      {state.error ? <p className="ai-vision-error">{state.error}</p> : null}
      {result?.success ? (
        <div className="ai-vision-result">
          <h3>识别结果</h3>
          <dl>
            <div>
              <dt>模型</dt>
              <dd>{result.modelName || result.modelId}</dd>
            </div>
            <div>
              <dt>耗时</dt>
              <dd>{result.latencyMs ?? 0} ms</dd>
            </div>
            <div>
              <dt>Token</dt>
              <dd>{result.usage?.total ?? 'API 未返回'}</dd>
            </div>
          </dl>
          <p>{result.answer}</p>
        </div>
      ) : null}

      <footer>
        {state.image ? <button onClick={onClear}>移除图片</button> : null}
        <button
          className="database-key-primary"
          disabled={!runtime?.configured || !state.image || testing || !state.prompt.trim()}
          onClick={onTest}
        >
          {testing ? '识别中…' : '开始识别'}
        </button>
      </footer>
    </section>
  )
}

function formatFileSize(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
