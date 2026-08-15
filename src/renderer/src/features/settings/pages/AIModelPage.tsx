import { useEffect, useRef } from 'react'
import type { AIRuntimeModelConfig } from '../../../../../shared/ai-provider'
import { AIProviderCard } from '../ai-model/AIProviderCard'
import { AIProviderEditor } from '../ai-model/AIProviderEditor'
import { AIImageUnderstandingTest } from '../ai-model/AIImageUnderstandingTest'
import { useAIModelSettingsController } from '../ai-model/useAIModelSettingsController'

export function AIModelPage({
  onRuntimeChange,
  onNotice
}: {
  onRuntimeChange: (config: AIRuntimeModelConfig) => void
  onNotice: (message: string) => void
}): React.ReactElement {
  const controller = useAIModelSettingsController({ onRuntimeChange, onNotice })
  const shouldRevealNewEditor = useRef(false)
  const runtime = controller.state.runtime
  const defaultProvider = controller.state.providers.find(
    (provider) => provider.id === runtime?.providerId
  )

  useEffect(() => {
    if (!controller.state.editor || !shouldRevealNewEditor.current) return
    shouldRevealNewEditor.current = false
    const editor = document.getElementById('ai-provider-editor')
    editor?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    editor?.querySelector<HTMLInputElement>('#ai-provider-name')?.focus({ preventScroll: true })
  }, [controller.state.editor])

  const openNewProvider = (): void => {
    shouldRevealNewEditor.current = true
    controller.openNew()
  }

  return (
    <div className="settings-page ai-model-page">
      <header className="settings-page-header">
        <div>
          <h1>AI 模型</h1>
          <p>管理模型供应商、连接信息和默认模型</p>
        </div>
        <button className="database-key-primary" onClick={openNewProvider}>
          添加供应商
        </button>
      </header>
      <div className="settings-page-scroll">
        <div className="settings-page-content ai-model-content">
          <section className="settings-card ai-model-default">
            <div>
              <span>当前默认模型</span>
              <strong>{runtime?.modelName || '尚未配置'}</strong>
              <small>{runtime?.providerName || '请添加供应商'}</small>
            </div>
            <span className={`settings-status-badge ${runtime?.configured ? '' : 'unavailable'}`}>
              {runtime?.configured ? '可用' : '未配置'}
            </span>
          </section>
          <AIImageUnderstandingTest
            runtime={runtime}
            provider={defaultProvider}
            state={controller.state.visionTest}
            onSelectImage={(file) => void controller.selectVisionImage(file)}
            onPromptChange={controller.setVisionPrompt}
            onTest={() => void controller.runVisionTest()}
            onClear={controller.clearVisionImage}
          />
          {controller.state.error ? (
            <p className="ai-model-page-error">{controller.state.error}</p>
          ) : null}
          {controller.state.editor ? (
            <AIProviderEditor
              provider={controller.state.editor}
              presetId={controller.state.presetId}
              editing={Boolean(controller.state.originalProviderId)}
              saving={controller.state.saving}
              onPreset={controller.selectPreset}
              onChange={controller.updateEditor}
              onCancel={controller.closeEditor}
              onSave={() => void controller.save()}
            />
          ) : null}
          <h2 className="settings-section-heading">供应商列表</h2>
          <div className="ai-provider-list">
            {controller.state.providers.map((provider) => (
              <AIProviderCard
                key={provider.id}
                provider={provider}
                testing={controller.state.testingId === provider.id}
                onEdit={() => controller.openEdit(provider)}
                onTest={() => void controller.test(provider.id)}
                onDefault={() => void controller.setDefault(provider.id)}
                onDelete={() => void controller.remove(provider.id)}
              />
            ))}
            {!controller.state.loading && !controller.state.providers.length ? (
              <div className="settings-card ai-provider-empty">
                <strong>尚未配置 AI 供应商</strong>
                <p>添加 OpenAI、Anthropic、DeepSeek、Ollama 或兼容服务。</p>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
