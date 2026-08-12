import React, { useState } from 'react'
import {
  DEFAULT_REPORT_TEMPLATE,
  REPORT_TEMPLATES,
  type ReportTemplateDefinition,
  type SelectableReportTemplateId
} from '../../../../shared/report-templates'

export type { SelectableReportTemplateId } from '../../../../shared/report-templates'

interface ReportTemplateSelectorProps {
  value: SelectableReportTemplateId
  onChange: (value: SelectableReportTemplateId) => void
  disabled?: boolean
}

const TemplateDiagram = ({
  template
}: {
  template: ReportTemplateDefinition
}): React.ReactElement => (
  <div className={`report-template-diagram diagram-${template.id}`} aria-hidden="true">
    <div className="diagram-masthead">
      <i />
      <b />
      <span />
    </div>
    <div className="diagram-kpis">
      <i />
      <i />
      <i />
      <i />
    </div>
    <div className="diagram-content">
      <div className="diagram-column diagram-column-a">
        <b />
        <span />
        <span />
      </div>
      <div className="diagram-column diagram-column-b">
        <b />
        <span />
        <span />
        <span />
      </div>
      <div className="diagram-column diagram-column-c">
        <b />
        <span />
        <span />
      </div>
    </div>
  </div>
)

export const ReportTemplateSelector: React.FC<ReportTemplateSelectorProps> = ({
  value,
  onChange,
  disabled
}) => {
  const [previewing, setPreviewing] = useState<ReportTemplateDefinition | null>(null)
  const mobileTemplates = REPORT_TEMPLATES.filter((template) => template.platform === 'mobile')
  const desktopTemplates = REPORT_TEMPLATES.filter((template) => template.platform === 'desktop')

  const renderGroup = (
    title: string,
    templates: readonly ReportTemplateDefinition[]
  ): React.ReactElement => (
    <div className="report-template-group">
      <div className="report-template-group-title">{title}</div>
      <div className="report-template-list">
        {templates.map((template) => {
          const active = value === template.id
          return (
            <div
              key={template.id}
              className={`report-template-item ${active ? 'active' : ''} ${disabled ? 'disabled' : ''}`}
            >
              <label>
                <input
                  type="radio"
                  name="report-template"
                  value={template.id}
                  checked={active}
                  disabled={disabled}
                  onChange={() => onChange(template.id)}
                />
                <TemplateDiagram template={template} />
                <div className="report-template-body">
                  <div className="report-template-eyebrow">{template.label}</div>
                  <div className="report-template-title">{template.name}</div>
                  <div className="report-template-tagline">{template.tagline}</div>
                </div>
              </label>
              <button
                type="button"
                className="report-template-preview-btn"
                onClick={() => setPreviewing(template)}
              >
                查看版式
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )

  return (
    <section className="report-section">
      <h3>日报模板</h3>
      <p className="report-section-desc">
        默认模板与五套新版模板读取同一份真实日报数据。手机模板适合长图和群内分享，桌面模板适合宽屏阅读与归档。
      </p>
      <div className="report-template-catalog">
        {renderGroup('默认模板', [DEFAULT_REPORT_TEMPLATE])}
        {renderGroup('手机端 · 375–414 px', mobileTemplates)}
        {renderGroup('电脑端 · 1280–1920 px', desktopTemplates)}
      </div>
      {previewing && (
        <div className="report-template-preview-mask" onClick={() => setPreviewing(null)}>
          <div
            className="report-template-preview-card"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="report-template-preview-heading">
              <div>
                <span>{previewing.label}</span>
                <h4>{previewing.name}</h4>
              </div>
              <em>
                {previewing.platform === 'desktop'
                  ? '桌面宽屏'
                  : previewing.platform === 'default'
                    ? '经典长图'
                    : '手机长图'}
              </em>
            </div>
            <p className="muted">{previewing.tagline}</p>
            <TemplateDiagram template={previewing} />
            <p className="report-template-preview-note">
              生成时会自动代入当前群聊的真实头像、昵称、消息、讨论摘要、Q&amp;A、统计与关键词。
            </p>
            <div className="report-template-preview-actions">
              <button type="button" className="secondary" onClick={() => setPreviewing(null)}>
                关闭
              </button>
              <button
                type="button"
                onClick={() => {
                  onChange(previewing.id)
                  setPreviewing(null)
                }}
              >
                选择此模板
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
