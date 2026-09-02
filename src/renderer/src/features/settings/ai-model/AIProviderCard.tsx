import type { AIProviderSummary } from '../../../../../shared/ai-provider'
import { Button } from '../../../components/ui'
import { PROVIDER_TYPE_LABELS } from './presets'

const STATUS_LABELS = { untested: '未测试', connected: '已连接', error: '连接失败' }

export function AIProviderCard({
  provider,
  testing,
  onEdit,
  onTest,
  onDefault,
  onDelete
}: {
  provider: AIProviderSummary
  testing: boolean
  onEdit: () => void
  onTest: () => void
  onDefault: () => void
  onDelete: () => void
}): React.ReactElement {
  const model = provider.models.find((item) => item.id === provider.defaultModel)
  return (
    <article className="ai-provider-card">
      <header>
        <div>
          <h3>{provider.name}</h3>
          <span>{PROVIDER_TYPE_LABELS[provider.type]}</span>
        </div>
        <span className={`ai-provider-status ${provider.status}`}>
          {STATUS_LABELS[provider.status]}
        </span>
      </header>
      <dl>
        <div>
          <dt>地址</dt>
          <dd title={provider.baseUrl}>{provider.baseUrl}</dd>
        </div>
        <div>
          <dt>默认模型</dt>
          <dd>{model?.name || provider.defaultModel}</dd>
        </div>
        <div>
          <dt>API Key</dt>
          <dd>
            {provider.hasApiKey ? '已安全保存' : provider.type === 'ollama' ? '无需配置' : '未配置'}
          </dd>
        </div>
      </dl>
      {provider.lastError ? <p className="ai-provider-error">{provider.lastError}</p> : null}
      <footer>
        <Button variant="outline" size="sm" onClick={onEdit}>
          编辑
        </Button>
        <Button variant="outline" size="sm" disabled={testing} onClick={onTest}>
          {testing ? '测试中…' : '测试连接'}
        </Button>
        <Button variant="outline" size="sm" disabled={provider.isDefault} onClick={onDefault}>
          {provider.isDefault ? '当前默认' : '设为默认'}
        </Button>
        <Button variant="destructive" size="sm" onClick={onDelete}>
          删除
        </Button>
      </footer>
    </article>
  )
}
