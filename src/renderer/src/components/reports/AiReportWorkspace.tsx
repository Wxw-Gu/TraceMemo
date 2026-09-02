import React, { useMemo, useState } from 'react'
import { Contact } from '../../../../shared/types'
import type { ReportModelChoice } from '../../../../shared/ai-provider'
import {
  AiModelConfig,
  RangeMessageState,
  ReportMemberNamePreference,
  ReportGenerationPhase,
  ReportPaths
} from '../../hooks/useGroupReportGeneration'
import { SummaryDateRange, SummaryMessageType } from '../../utils/group-report'
import { MessageTypeSelector } from './MessageTypeSelector'
import { ModelSummary } from './ModelSummary'
import { ReportDensitySelector } from './ReportDensitySelector'
import { ReportRangeSelector } from './ReportRangeSelector'
import { ReportMemberNameSelector } from './ReportMemberNameSelector'
import { ReportGroupMemberSelector } from './ReportGroupMemberSelector'
import { ReportSectionSelector } from './ReportSectionSelector'
import { ReportTemplateSelector, SelectableReportTemplateId } from './ReportTemplateSelector'
import { Button, Input } from '../ui'

interface AiReportWorkspaceProps {
  sourceContact: Contact | null
  summaryDateRange: SummaryDateRange
  summaryMessageTypes: SummaryMessageType[]
  modelConfig: AiModelConfig
  visionModelConfig?: ReportModelChoice
  textModelOptions: ReportModelChoice[]
  visionModelOptions: ReportModelChoice[]
  rangeMessageCount: number
  reportMessageCount: number
  messageTypeCounts: Record<SummaryMessageType, number>
  rangeState: RangeMessageState
  phase: ReportGenerationPhase
  error: string
  generatedImage: string | null
  reportPaths: ReportPaths | null
  isGenerating: boolean
  onSummaryDateRangeChange: (value: SummaryDateRange) => void
  onSummaryMessageTypesChange: (value: SummaryMessageType[]) => void
  onOpenModelSettings: () => void
  onTextModelChange: (model: ReportModelChoice) => void
  onVisionModelChange: (model: ReportModelChoice) => void
  onGenerate: () => void
  onCloseResult: () => void
  onCopyImage: () => Promise<{ success: boolean; error?: string }>
  onRevealReport: () => Promise<{ success: boolean; error?: string }>
  onViewResult: () => void
  hasReportResult: boolean
  templateId: SelectableReportTemplateId
  onTemplateIdChange: (value: SelectableReportTemplateId) => void
  memberNamePreference: ReportMemberNamePreference
  onMemberNamePreferenceChange: (value: ReportMemberNamePreference) => void
  reportTimeoutSeconds: number
  onReportTimeoutSecondsChange: (value: number) => void
}

const rangeLabel = (range: SummaryDateRange): string => {
  if (range === 'yesterday') return '昨日'
  if (range === '7days') return '近 7 天'
  return '今天'
}

const modelLabel = (model: string): string => {
  if (model === 'deepseek-chat') return 'DeepSeek Chat'
  if (model === 'gpt-4o-mini') return 'GPT-4o Mini'
  if (model === 'gpt-4o') return 'GPT-4o'
  if (model === 'gpt-4-turbo') return 'GPT-4 Turbo'
  if (model === 'claude-3-5-sonnet-20240620') return 'Claude 3.5 Sonnet'
  if (model === 'moonshot-v1-8k') return 'Moonshot V1'
  return model || '未选择模型'
}

export function AiReportWorkspace({
  sourceContact,
  summaryDateRange,
  summaryMessageTypes,
  modelConfig,
  visionModelConfig,
  textModelOptions,
  visionModelOptions,
  rangeMessageCount,
  reportMessageCount,
  messageTypeCounts,
  rangeState,
  phase,
  error,
  generatedImage,
  reportPaths,
  isGenerating,
  onSummaryDateRangeChange,
  onSummaryMessageTypesChange,
  onOpenModelSettings,
  onTextModelChange,
  onVisionModelChange,
  onGenerate,
  onCloseResult,
  onCopyImage,
  onRevealReport,
  onViewResult,
  hasReportResult,
  templateId,
  onTemplateIdChange,
  memberNamePreference,
  onMemberNamePreferenceChange,
  reportTimeoutSeconds,
  onReportTimeoutSecondsChange
}: AiReportWorkspaceProps): React.ReactElement {
  const [actionStatus, setActionStatus] = useState('')
  const groupName = sourceContact?.m_nsNickName || sourceContact?.m_nsUsrName || '未选择群聊'
  const configDisabled = isGenerating
  const disabledReason = useMemo(() => {
    if (!sourceContact) return '请先选择群聊'
    if (!modelConfig.configured) return '请先配置默认 AI 模型'
    if (rangeState.status === 'loading') return '正在计算消息数量'
    if (rangeState.status === 'error') return rangeState.error
    if (!reportMessageCount) return '当前范围没有可总结消息'
    if (!summaryMessageTypes.length) return '请至少选择一种消息类型'
    return ''
  }, [
    modelConfig.configured,
    rangeState,
    reportMessageCount,
    sourceContact,
    summaryMessageTypes.length
  ])
  const canGenerate = !isGenerating && !disabledReason
  const modelStatus = modelConfig.configured ? '配置正常' : '尚未配置'

  const handleCopy = async (): Promise<void> => {
    const result = await onCopyImage()
    setActionStatus(result.success ? '图片已复制' : result.error || '复制失败')
  }

  const handleReveal = async (): Promise<void> => {
    const result = await onRevealReport()
    setActionStatus(result.success ? '已在文件夹中显示' : result.error || '打开文件夹失败')
  }

  return (
    <main className="ai-report-workspace">
      <header className="ai-report-header">
        <div>
          <h1>生成群聊日报</h1>
          <p>
            {groupName} · {rangeLabel(summaryDateRange)}
          </p>
        </div>
        {phase === 'error' && error && <div className="report-inline-error">{error}</div>}
      </header>

      <div className="ai-report-body">
        {!sourceContact && (
          <div className="report-empty-state">
            <h2>未选择群聊</h2>
            <p>从左侧选择一个群聊后，可以配置范围并生成 AI 群聊日报。</p>
          </div>
        )}

        <ReportRangeSelector
          value={summaryDateRange}
          messageCount={rangeMessageCount}
          rangeState={rangeState}
          disabled={configDisabled}
          onChange={onSummaryDateRangeChange}
        />
        <MessageTypeSelector
          value={summaryMessageTypes}
          counts={messageTypeCounts}
          disabled={configDisabled}
          onChange={onSummaryMessageTypesChange}
        />
        <ReportSectionSelector />
        <ReportDensitySelector />
        <ReportTemplateSelector
          value={templateId}
          onChange={onTemplateIdChange}
          disabled={configDisabled}
        />
        <ReportMemberNameSelector
          value={memberNamePreference}
          onChange={onMemberNamePreferenceChange}
          disabled={configDisabled}
        />
        <ReportGroupMemberSelector sourceContact={sourceContact} disabled={configDisabled} />
        <ModelSummary
          config={modelConfig}
          visionConfig={visionModelConfig}
          textModels={textModelOptions}
          visionModels={visionModelOptions}
          disabled={configDisabled}
          onTextModelChange={onTextModelChange}
          onVisionModelChange={onVisionModelChange}
          onOpenSettings={onOpenModelSettings}
        />
        <section className="report-config-section report-timeout-section">
          <div>
            <h3>日报生成超时</h3>
            <p>大群聊和图片识别耗时较长，可单独设置本次日报最多等待时间。</p>
          </div>
          <label>
            <Input
              className="w-24"
              type="number"
              min={30}
              max={1800}
              step={30}
              value={reportTimeoutSeconds}
              disabled={configDisabled}
              onChange={(event) => onReportTimeoutSecondsChange(Number(event.target.value))}
            />
            <span>秒</span>
          </label>
        </section>
        <section className="report-privacy-note">
          <h3>隐私说明</h3>
          <p>微信数据库和聊天记录默认从本机读取。</p>
          <p>所选内容将发送至你配置的模型服务进行处理。</p>
          <p>TraceMemo 本身不额外保存或转发内容。</p>
        </section>

        {generatedImage && (
          <section className="report-result-panel">
            <div className="report-section-heading">
              <h3>生成成功</h3>
              <span>{reportPaths ? 'HTML 与 PNG 已导出' : '结果已生成'}</span>
            </div>
            <div className="report-result-preview">
              <img src={generatedImage} alt="生成的群聊日报" />
            </div>
            <div className="report-result-actions">
              <Button onClick={onViewResult}>查看生成结果</Button>
              <Button variant="outline" onClick={handleCopy}>
                复制图片
              </Button>
              <Button variant="outline" onClick={handleReveal} disabled={!reportPaths}>
                在文件夹中显示
              </Button>
              <Button variant="ghost" onClick={onCloseResult}>
                关闭预览
              </Button>
            </div>
            {actionStatus && <p className="report-action-status">{actionStatus}</p>}
          </section>
        )}
      </div>

      <footer className="ai-report-footer">
        <span className="report-footer-note">
          {modelConfig.modelName || modelLabel(modelConfig.model)} · {modelStatus} ·
          所选内容会发送至你配置的模型服务
        </span>
        <div className="report-footer-actions">
          {disabledReason && !isGenerating && <span>{disabledReason}</span>}
          {hasReportResult && !isGenerating && (
            <Button className="min-w-[92px]" variant="outline" onClick={onViewResult}>
              查看结果
            </Button>
          )}
          <Button className="min-w-[132px]" disabled={!canGenerate} onClick={onGenerate}>
            {isGenerating ? '正在生成日报' : '开始生成日报'}
          </Button>
        </div>
      </footer>
    </main>
  )
}
