import React from 'react'
import type { ReportModelChoice } from '../../../../shared/ai-provider'
import { AiModelConfig } from '../../hooks/useGroupReportGeneration'

interface ModelSummaryProps {
  config: AiModelConfig
  visionConfig?: ReportModelChoice
  textModels: ReportModelChoice[]
  visionModels: ReportModelChoice[]
  disabled?: boolean
  onTextModelChange: (model: ReportModelChoice) => void
  onVisionModelChange: (model: ReportModelChoice) => void
  onOpenSettings: () => void
}

const modelKey = (model: { providerId?: string; model: string } | undefined): string =>
  model?.providerId && model.model ? `${model.providerId}::${model.model}` : ''

const optionLabel = (model: ReportModelChoice): string =>
  `${model.providerName} · ${model.modelName || model.model}`

export function ModelSummary({
  config,
  visionConfig,
  textModels,
  visionModels,
  disabled = false,
  onTextModelChange,
  onVisionModelChange,
  onOpenSettings
}: ModelSummaryProps): React.ReactElement {
  const changeModel = (
    key: string,
    models: ReportModelChoice[],
    onChange: (model: ReportModelChoice) => void
  ): void => {
    const selected = models.find((model) => modelKey(model) === key)
    if (selected) onChange(selected)
  }

  return (
    <section className="report-config-section">
      <div className="report-model-summary">
        <div className="report-model-summary-content">
          <h3>模型配置</h3>
          <div className="report-model-selects">
            <label>
              <span>文字总结模型</span>
              <select
                aria-label="文字总结模型"
                value={modelKey(config)}
                disabled={disabled || !textModels.length}
                onChange={(event) => changeModel(event.target.value, textModels, onTextModelChange)}
              >
                {!textModels.length && <option value="">没有已配置的文字模型</option>}
                {textModels.map((model) => (
                  <option key={modelKey(model)} value={modelKey(model)}>
                    {optionLabel(model)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>图片理解模型</span>
              <select
                aria-label="图片理解模型"
                value={modelKey(visionConfig)}
                disabled={disabled || !visionModels.length}
                onChange={(event) =>
                  changeModel(event.target.value, visionModels, onVisionModelChange)
                }
              >
                {!visionModels.length && <option value="">没有已验证的图片理解模型</option>}
                {visionModels.map((model) => (
                  <option key={modelKey(model)} value={modelKey(model)}>
                    {optionLabel(model)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <small>图片识别缓存 10 分钟；识图完成后仍由文字总结模型生成日报。</small>
        </div>
        <button type="button" onClick={onOpenSettings} disabled={disabled}>
          更改模型
        </button>
      </div>
    </section>
  )
}
