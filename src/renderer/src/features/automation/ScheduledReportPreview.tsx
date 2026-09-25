import * as React from 'react'

import { SUMMARY_TYPE_OPTIONS } from '../../utils/group-report'
import {
  formatScheduledSlot,
  scheduledReportRangeLabel,
  scheduledReportTemplateLabel,
  type ScheduledReportDraft,
  type ScheduledReportTargetType
} from './model/scheduled-report-preview'

/**
 * ScheduledReportPreview —— 右侧「效果预览」。
 *
 * 与左侧表单逐项联动，**绝不执行任何真实动作**：
 * 不调 scheduler、不生成日报、不发送、不碰 store。
 *
 * 定时日报用「流程」表达比微信气泡准确：一次执行是
 * 定时触发 → 生成日报 → 模型 → 模板 → 发送 的链条，而不是一段对话。
 */

export interface ScheduledReportPreviewProps {
  draft: ScheduledReportDraft
  /** 来源群的**显示名**（草稿里存的可能是内部标识，展示前已在调用方解析）。 */
  groupLabel: string
  /** 指定好友的显示名。 */
  contactName: string
}

export function ScheduledReportPreview({
  draft,
  groupLabel,
  contactName
}: ScheduledReportPreviewProps): React.ReactElement {
  const groupText = groupLabel.trim() || '未选择群聊'

  /** 发送目标的显示文案（四种类型各取真实语义，不回落成内部 id）。 */
  const targetText = React.useMemo((): string => {
    const labels: Record<ScheduledReportTargetType, string> = {
      source_chat: groupText,
      self: '我',
      file_transfer: '文件传输助手',
      contact: contactName.trim() || '未选择好友'
    }
    return labels[draft.targetType]
  }, [draft.targetType, groupText, contactName])

  /**
   * 纳入的消息类型只做**摘要**：左侧才是详细配置，
   * 右侧逐条列出来会把预览拉得很长。
   */
  const messageTypesSummary = React.useMemo((): string => {
    if (draft.messageTypes.length === 0) return '未选择'
    if (draft.messageTypes.length === SUMMARY_TYPE_OPTIONS.length) return '全部类型'
    return draft.messageTypes
      .map((value) => SUMMARY_TYPE_OPTIONS.find((option) => option.value === value)?.label ?? value)
      .join('、')
  }, [draft.messageTypes])

  return (
    <section className="automation-preview" aria-label="效果模拟预览">
      <div className="automation-preview-heading">
        <h3>效果预览</h3>
        <span className="automation-preview-badge">仅预览，不会真实执行</span>
      </div>

      <ol className="automation-preview-flow">
        <li className="automation-preview-flow-step">
          <span className="automation-preview-flow-time">{draft.scheduleTime}</span>
          <span className="automation-preview-flow-title">定时任务触发</span>
          <small>每天 {draft.scheduleTime}</small>
        </li>

        <li className="automation-preview-flow-arrow" aria-hidden="true">
          ↓
        </li>

        <li className="automation-preview-flow-step">
          <span className="automation-preview-flow-title">生成日报</span>
          <small>来源：{groupText}</small>
          <small>范围：{scheduledReportRangeLabel(draft.reportRange)}</small>
          <small>纳入消息：{messageTypesSummary}</small>
        </li>

        <li className="automation-preview-flow-arrow" aria-hidden="true">
          ↓
        </li>

        <li className="automation-preview-flow-step">
          <span className="automation-preview-flow-title">模型</span>
          <small>默认日报模型</small>
        </li>

        <li className="automation-preview-flow-arrow" aria-hidden="true">
          ↓
        </li>

        <li className="automation-preview-flow-step">
          <span className="automation-preview-flow-title">模板</span>
          <small>{scheduledReportTemplateLabel(draft.templateId)}</small>
        </li>

        <li className="automation-preview-flow-arrow" aria-hidden="true">
          ↓
        </li>

        <li className="automation-preview-flow-step">
          <span className="automation-preview-flow-title">发送到</span>
          <small>{targetText}</small>
        </li>
      </ol>

      {/* 日报图片的形状示意（不是真实截图，也不触发生成）。 */}
      <div className="automation-preview-report-card" aria-hidden="true">
        <div className="automation-preview-report-head">
          <span>{groupText}</span>
          <span>{scheduledReportRangeLabel(draft.reportRange)}</span>
        </div>
        <div className="automation-preview-report-line wide" />
        <div className="automation-preview-report-line" />
        <div className="automation-preview-report-line" />
        <div className="automation-preview-report-line short" />
      </div>

      <dl className="automation-preview-facts">
        <div>
          <dt>触发方式</dt>
          <dd>每天 {draft.scheduleTime}</dd>
        </div>
        <div>
          <dt>日报来源</dt>
          <dd>{groupText}</dd>
        </div>
        <div>
          <dt>日报范围</dt>
          <dd>{scheduledReportRangeLabel(draft.reportRange)}</dd>
        </div>
        <div>
          <dt>日报模板</dt>
          <dd>{scheduledReportTemplateLabel(draft.templateId)}</dd>
        </div>
        <div>
          <dt>发送目标</dt>
          <dd>{targetText}</dd>
        </div>
      </dl>

      <p className="automation-preview-footnote">
        预计下次执行：{formatScheduledSlot(draft.scheduleTime)}
      </p>
    </section>
  )
}
