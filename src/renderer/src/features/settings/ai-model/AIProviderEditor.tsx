import type {
  AIModelDefinition,
  AIProviderConfig,
  AIProviderType
} from '../../../../../shared/ai-provider'
import { PROVIDER_PRESETS, PROVIDER_TYPE_LABELS } from './presets'

export function AIProviderEditor({
  provider,
  presetId,
  editing,
  saving,
  onPreset,
  onChange,
  onCancel,
  onSave
}: {
  provider: AIProviderConfig
  presetId: string
  editing: boolean
  saving: boolean
  onPreset: (id: string) => void
  onChange: (provider: AIProviderConfig) => void
  onCancel: () => void
  onSave: () => void
}): React.ReactElement {
  const patch = (value: Partial<AIProviderConfig>): void => onChange({ ...provider, ...value })
  const patchModel = (index: number, value: Partial<AIModelDefinition>): void => {
    const models = provider.models.map((model, modelIndex) =>
      modelIndex === index ? { ...model, ...value } : model
    )
    patch({
      models,
      defaultModel: models.some((model) => model.id === provider.defaultModel)
        ? provider.defaultModel
        : models[0]?.id || ''
    })
  }
  const preview = JSON.stringify(
    { ...provider, apiKey: provider.apiKey ? '***' : undefined },
    null,
    2
  )

  return (
    <section className="settings-card ai-provider-editor">
      <header>
        <div>
          <h2>{editing ? '编辑供应商' : '新增供应商'}</h2>
          <p>API Key 保存后不会再次显示。</p>
        </div>
        <button onClick={onCancel}>关闭</button>
      </header>
      {!editing ? (
        <label>
          快速模板
          <select value={presetId} onChange={(event) => onPreset(event.target.value)}>
            {PROVIDER_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div className="ai-provider-form-grid">
        <label>
          供应商名称
          <input value={provider.name} onChange={(event) => patch({ name: event.target.value })} />
        </label>
        <label>
          供应商 ID
          <input
            value={provider.id}
            disabled={editing}
            onChange={(event) => patch({ id: event.target.value })}
          />
        </label>
        <label>
          供应商类型
          <select
            value={provider.type}
            onChange={(event) => patch({ type: event.target.value as AIProviderType })}
          >
            {Object.entries(PROVIDER_TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          认证方式
          <select
            value={provider.auth.type}
            onChange={(event) =>
              patch({
                auth: {
                  ...provider.auth,
                  type: event.target.value as AIProviderConfig['auth']['type']
                }
              })
            }
          >
            <option value="bearer">Authorization Bearer</option>
            <option value="x-api-key">X-API-Key</option>
            <option value="custom-header">自定义 Header</option>
            <option value="none">无需认证</option>
          </select>
        </label>
        <label className="wide">
          Base URL
          <input
            value={provider.baseUrl}
            onChange={(event) => patch({ baseUrl: event.target.value })}
            placeholder="https://api.example.com/v1"
          />
        </label>
        <label>
          API Key
          <input
            type="password"
            value={provider.apiKey || ''}
            onChange={(event) => patch({ apiKey: event.target.value })}
            placeholder="留空则保留已保存的 Key"
            autoComplete="off"
          />
        </label>
        <label>
          认证字段
          <input
            value={provider.auth.headerName || ''}
            disabled={provider.auth.type !== 'custom-header'}
            onChange={(event) =>
              patch({ auth: { ...provider.auth, headerName: event.target.value } })
            }
            placeholder="Authorization"
          />
        </label>
      </div>

      <div className="ai-model-table-heading">
        <h3>模型配置</h3>
        <button onClick={() => patch({ models: [...provider.models, emptyModel()] })}>
          新增模型
        </button>
      </div>
      <div className="ai-model-table">
        {provider.models.map((model, index) => (
          <div className="ai-model-row" key={`${index}-${model.id}`}>
            <input
              value={model.name}
              onChange={(event) => patchModel(index, { name: event.target.value })}
              placeholder="显示名称"
            />
            <input
              value={model.id}
              onChange={(event) => patchModel(index, { id: event.target.value })}
              placeholder="实际模型 ID"
            />
            <label>
              <input
                type="checkbox"
                checked={model.capabilities.chat}
                onChange={(event) =>
                  patchModel(index, {
                    capabilities: { ...model.capabilities, chat: event.target.checked }
                  })
                }
              />
              聊天
            </label>
            <label>
              <input
                type="checkbox"
                checked={model.capabilities.vision}
                onChange={(event) => {
                  const vision = event.target.checked
                  // OCR 是 vision 的派生能力:勾 vision 时自动带 OCR
                  patchModel(index, {
                    capabilities: {
                      ...model.capabilities,
                      vision,
                      ocr: vision ? true : model.capabilities.ocr
                    }
                  })
                }}
              />
              图片理解
            </label>
            <label title="图片文字识别,跟随图片理解能力">
              <input
                type="checkbox"
                checked={model.capabilities.ocr}
                onChange={(event) =>
                  patchModel(index, {
                    capabilities: { ...model.capabilities, ocr: event.target.checked }
                  })
                }
              />
              图片文字识别
            </label>
            <label>
              <input
                type="checkbox"
                checked={model.capabilities.longContext}
                onChange={(event) =>
                  patchModel(index, {
                    capabilities: { ...model.capabilities, longContext: event.target.checked }
                  })
                }
              />
              长上下文
            </label>
            <input
              type="number"
              value={model.maxTokens || ''}
              onChange={(event) =>
                patchModel(index, { maxTokens: Number(event.target.value) || undefined })
              }
              placeholder="最大 Token"
            />
            <label className="ai-model-default">
              <input
                type="radio"
                name="default-model"
                checked={provider.defaultModel === model.id}
                onChange={() => patch({ defaultModel: model.id })}
              />
              默认
            </label>
            <button
              className="danger"
              disabled={provider.models.length === 1}
              onClick={() =>
                patch({ models: provider.models.filter((_, itemIndex) => itemIndex !== index) })
              }
            >
              移除
            </button>
          </div>
        ))}
      </div>

      <details className="ai-provider-advanced">
        <summary>高级设置</summary>
        <div>
          <label>
            请求超时（ms）
            <input
              type="number"
              value={provider.advanced.timeoutMs}
              onChange={(event) =>
                patch({ advanced: { ...provider.advanced, timeoutMs: Number(event.target.value) } })
              }
            />
          </label>
          <label>
            Temperature
            <input
              type="number"
              step="0.1"
              value={provider.advanced.temperature ?? ''}
              onChange={(event) =>
                patch({
                  advanced: { ...provider.advanced, temperature: Number(event.target.value) }
                })
              }
            />
          </label>
          <label>
            Max Tokens
            <input
              type="number"
              value={provider.advanced.maxTokens ?? ''}
              onChange={(event) =>
                patch({ advanced: { ...provider.advanced, maxTokens: Number(event.target.value) } })
              }
            />
          </label>
          <label className="wide">
            额外 Headers（JSON）
            <textarea
              key={JSON.stringify(provider.advanced.extraHeaders)}
              defaultValue={JSON.stringify(provider.advanced.extraHeaders, null, 2)}
              onBlur={(event) => {
                try {
                  patch({
                    advanced: {
                      ...provider.advanced,
                      extraHeaders: JSON.parse(event.target.value) as Record<string, string>
                    }
                  })
                } catch {
                  /* Keep the last valid headers. */
                }
              }}
            />
          </label>
        </div>
      </details>
      <details className="ai-provider-preview">
        <summary>导出配置（只读）</summary>
        <pre>{preview}</pre>
      </details>
      <footer>
        <button onClick={onCancel}>取消</button>
        <button className="database-key-primary" disabled={saving} onClick={onSave}>
          {saving ? '保存中…' : '保存供应商'}
        </button>
      </footer>
    </section>
  )
}

function emptyModel(): AIModelDefinition {
  return { name: '', id: '', capabilities: { chat: true, vision: false, ocr: false, longContext: false } }
}
