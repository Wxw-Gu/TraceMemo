import type {
  AIModelDefinition,
  AIProviderConfig,
  AIProviderType
} from '../../../../../shared/ai-provider'
import {
  Button,
  Checkbox,
  Input,
  RadioGroup,
  RadioGroupItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea
} from '../../../components/ui'
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
    <section id="ai-provider-editor" className="settings-card ai-provider-editor">
      <header>
        <div>
          <h2>{editing ? '编辑供应商' : '新增供应商'}</h2>
          <p>API Key 保存后不会再次显示。</p>
        </div>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          关闭
        </Button>
      </header>
      {!editing ? (
        <label>
          快速模板
          <Select value={presetId} onValueChange={onPreset}>
            <SelectTrigger aria-label="快速模板">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROVIDER_PRESETS.map((preset) => (
                <SelectItem key={preset.id} value={preset.id}>
                  {preset.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      ) : null}
      <div className="ai-provider-form-grid">
        <label>
          供应商名称
          <Input
            id="ai-provider-name"
            value={provider.name}
            onChange={(event) => patch({ name: event.target.value })}
          />
        </label>
        <label>
          供应商 ID
          <Input
            value={provider.id}
            disabled={editing}
            onChange={(event) => patch({ id: event.target.value })}
          />
        </label>
        <label>
          供应商类型
          <Select
            value={provider.type}
            onValueChange={(value) => patch({ type: value as AIProviderType })}
          >
            <SelectTrigger aria-label="供应商类型">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(PROVIDER_TYPE_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label>
          认证方式
          <Select
            value={provider.auth.type}
            onValueChange={(value) =>
              patch({
                auth: {
                  ...provider.auth,
                  type: value as AIProviderConfig['auth']['type']
                }
              })
            }
          >
            <SelectTrigger aria-label="认证方式">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="bearer">Authorization Bearer</SelectItem>
              <SelectItem value="x-api-key">X-API-Key</SelectItem>
              <SelectItem value="custom-header">自定义 Header</SelectItem>
              <SelectItem value="none">无需认证</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <label className="wide">
          Base URL
          <Input
            value={provider.baseUrl}
            onChange={(event) => patch({ baseUrl: event.target.value })}
            placeholder="https://api.example.com/v1"
          />
        </label>
        <label>
          API Key
          <Input
            type="password"
            value={provider.apiKey || ''}
            onChange={(event) => patch({ apiKey: event.target.value })}
            placeholder="留空则保留已保存的 Key"
            autoComplete="off"
          />
        </label>
        <label>
          认证字段
          <Input
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
        <Button
          variant="outline"
          size="sm"
          onClick={() => patch({ models: [...provider.models, emptyModel()] })}
        >
          新增模型
        </Button>
      </div>
      <RadioGroup
        className="ai-model-table"
        aria-label="默认模型"
        value={provider.defaultModel}
        onValueChange={(value) => patch({ defaultModel: value })}
      >
        {provider.models.map((model, index) => (
          <div className="ai-model-row" key={`${index}-${model.id}`}>
            <label className="ai-model-identity-field">
              <span>模型名称</span>
              <Input
                value={model.name}
                onChange={(event) => patchModel(index, { name: event.target.value })}
                placeholder="例如：DeepSeek Chat"
              />
            </label>
            <label className="ai-model-identity-field">
              <span>模型 ID</span>
              <Input
                value={model.id}
                onChange={(event) => patchModel(index, { id: event.target.value })}
                placeholder="例如：deepseek-chat"
              />
            </label>
            <label htmlFor={`ai-model-chat-${index}`}>
              <Checkbox
                id={`ai-model-chat-${index}`}
                aria-label={`聊天 ${model.name || index + 1}`}
                checked={model.capabilities.chat}
                onCheckedChange={(checked) =>
                  patchModel(index, {
                    capabilities: { ...model.capabilities, chat: checked === true }
                  })
                }
              />
              聊天
            </label>
            <label htmlFor={`ai-model-vision-${index}`}>
              <Checkbox
                id={`ai-model-vision-${index}`}
                aria-label={`图片理解 ${model.name || index + 1}`}
                checked={model.capabilities.vision}
                onCheckedChange={(checked) => {
                  const vision = checked === true
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
            <label htmlFor={`ai-model-ocr-${index}`} title="图片文字识别,跟随图片理解能力">
              <Checkbox
                id={`ai-model-ocr-${index}`}
                aria-label={`图片文字识别 ${model.name || index + 1}`}
                checked={model.capabilities.ocr}
                onCheckedChange={(checked) =>
                  patchModel(index, {
                    capabilities: { ...model.capabilities, ocr: checked === true }
                  })
                }
              />
              图片文字识别
            </label>
            <label htmlFor={`ai-model-long-context-${index}`}>
              <Checkbox
                id={`ai-model-long-context-${index}`}
                aria-label={`长上下文 ${model.name || index + 1}`}
                checked={model.capabilities.longContext}
                onCheckedChange={(checked) =>
                  patchModel(index, {
                    capabilities: { ...model.capabilities, longContext: checked === true }
                  })
                }
              />
              长上下文
            </label>
            <Input
              aria-label={`最大 Token ${index + 1}`}
              type="number"
              value={model.maxTokens || ''}
              onChange={(event) =>
                patchModel(index, { maxTokens: Number(event.target.value) || undefined })
              }
              placeholder="最大 Token"
            />
            <label className="ai-model-default" htmlFor={`ai-default-model-${index}`}>
              <RadioGroupItem
                id={`ai-default-model-${index}`}
                value={model.id}
                aria-label={`默认 ${model.name || index + 1}`}
              />
              默认
            </label>
            <Button
              variant="destructive"
              size="sm"
              disabled={provider.models.length === 1}
              onClick={() =>
                patch({ models: provider.models.filter((_, itemIndex) => itemIndex !== index) })
              }
            >
              移除
            </Button>
          </div>
        ))}
      </RadioGroup>

      <details className="ai-provider-advanced">
        <summary>高级设置</summary>
        <div>
          <label>
            请求超时（ms）
            <Input
              type="number"
              value={provider.advanced.timeoutMs}
              onChange={(event) =>
                patch({ advanced: { ...provider.advanced, timeoutMs: Number(event.target.value) } })
              }
            />
          </label>
          <label>
            Temperature
            <Input
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
            <Input
              type="number"
              value={provider.advanced.maxTokens ?? ''}
              onChange={(event) =>
                patch({ advanced: { ...provider.advanced, maxTokens: Number(event.target.value) } })
              }
            />
          </label>
          <label className="wide">
            额外 Headers（JSON）
            <Textarea
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
        <Button variant="outline" onClick={onCancel}>
          取消
        </Button>
        <Button disabled={saving} onClick={onSave}>
          {saving ? '保存中…' : '保存供应商'}
        </Button>
      </footer>
    </section>
  )
}

function emptyModel(): AIModelDefinition {
  return {
    name: '',
    id: '',
    capabilities: { chat: true, vision: false, ocr: false, longContext: false }
  }
}
