import React from 'react'
import type { ReportModelChoice } from '../../../../shared/ai-provider'
import { AiModelConfig } from '../../hooks/useGroupReportGeneration'
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui'

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
    <section className="report-config-section report-model-config-section">
      <div className="report-model-summary">
        <div className="report-model-summary-content">
          <h3>模型配置</h3>
          <div className="report-model-selects">
            <label>
              <span>文字总结模型</span>
              <Select
                value={modelKey(config)}
                disabled={disabled || !textModels.length}
                onValueChange={(key) => changeModel(key, textModels, onTextModelChange)}
              >
                <SelectTrigger aria-label="文字总结模型">
                  <SelectValue placeholder="没有已配置的文字模型" />
                </SelectTrigger>
                <SelectContent>
                  {textModels.map((model) => (
                    <SelectItem key={modelKey(model)} value={modelKey(model)}>
                      {optionLabel(model)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label>
              <span>图片理解模型</span>
              <Select
                value={modelKey(visionConfig) || undefined}
                disabled={disabled || !visionModels.length}
                onValueChange={(key) => changeModel(key, visionModels, onVisionModelChange)}
              >
                <SelectTrigger aria-label="图片理解模型">
                  <SelectValue placeholder="没有已验证的图片理解模型" />
                </SelectTrigger>
                <SelectContent>
                  {visionModels.map((model) => (
                    <SelectItem key={modelKey(model)} value={modelKey(model)}>
                      {optionLabel(model)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          </div>
          <small>图片识别缓存 10 分钟；识图完成后仍由文字总结模型生成日报。</small>
        </div>
        <Button variant="outline" size="sm" onClick={onOpenSettings} disabled={disabled}>
          更改模型
        </Button>
      </div>
    </section>
  )
}
