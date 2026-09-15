import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  DEFAULT_REPORT_TEMPLATE,
  REPORT_TEMPLATES,
  encodeExternalReportTemplateId,
  type ReportTemplateDefinition,
  type ReportTemplateSelectionId
} from '../../../../shared/report-templates'
import type {
  ReportTemplateCatalog,
  ReportTemplateCatalogEntry
} from '../../../../shared/report-template-market'
import type { InstalledReportTemplate } from '../../../../shared/report-template-package'
import {
  Button,
  RadioGroup,
  RadioGroupItem
} from '../ui'
import {
  ReportTemplatePreviewDialog,
  TemplateDiagram,
  reportTemplatePlatformLabel,
  type ReportTemplatePreviewItem
} from './ReportTemplatePreview'

export type {
  SelectableReportTemplateId,
  ReportTemplateSelectionId
} from '../../../../shared/report-templates'

interface ReportTemplateSelectorProps {
  value: ReportTemplateSelectionId
  onChange: (value: ReportTemplateSelectionId) => void
  disabled?: boolean
}

export const ReportTemplateSelector: React.FC<ReportTemplateSelectorProps> = ({
  value,
  onChange,
  disabled
}) => {
  const [previewing, setPreviewing] = useState<ReportTemplatePreviewItem | null>(null)
  const [installed, setInstalled] = useState<InstalledReportTemplate[]>([])
  const [catalog, setCatalog] = useState<ReportTemplateCatalog | null>(null)
  const [marketError, setMarketError] = useState('')
  const previewTriggerRef = useRef<HTMLButtonElement | null>(null)
  const mobileTemplates = REPORT_TEMPLATES.filter((template) => template.platform === 'mobile')
  const desktopTemplates = REPORT_TEMPLATES.filter((template) => template.platform === 'desktop')

  const refreshMarket = async (): Promise<void> => {
    if (typeof window === 'undefined' || !window.api) return
    if (typeof window.api.listReportTemplates === 'function') {
      try {
        const listed = await window.api.listReportTemplates()
        if (Array.isArray(listed)) setInstalled(listed)
      } catch (error) {
        setMarketError(error instanceof Error ? error.message : '已安装模板加载失败')
      }
    }
    if (typeof window.api.listReportTemplateCatalog !== 'function') return
    try {
      const result = await window.api.listReportTemplateCatalog()
      if (result.success && result.catalog) {
        setCatalog(result.catalog)
        setMarketError('')
      } else {
        setMarketError(result.error || '远端模板目录加载失败')
      }
    } catch (error) {
      setMarketError(error instanceof Error ? error.message : '远端模板目录加载失败')
    }
  }

  useEffect(() => {
    void refreshMarket()
  }, [])

  const externalInstalled = useMemo(
    () => installed.filter((template) => template.source === 'installed'),
    [installed]
  )
  const catalogEntries = catalog?.templates || []

  const platformLabel = reportTemplatePlatformLabel

  const catalogEntryFor = (template: InstalledReportTemplate): ReportTemplateCatalogEntry | undefined =>
    catalogEntries.find((entry) => entry.id === template.id && entry.version === template.version)

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
              <label htmlFor={`report-template-${template.id}`}>
                <RadioGroupItem
                  id={`report-template-${template.id}`}
                  value={template.id}
                  aria-label={template.name}
                />
                <TemplateDiagram template={template} />
                <div className="report-template-body">
                  <div className="report-template-eyebrow">{template.label}</div>
                  <div className="report-template-title">{template.name}</div>
                  <div className="report-template-tagline">{template.tagline}</div>
                </div>
              </label>
              <Button
                variant="outline"
                size="sm"
                onClick={(event) => {
                  previewTriggerRef.current = event.currentTarget
                  setPreviewing({ kind: 'builtin', template })
                }}
              >
                查看版式
              </Button>
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
      <RadioGroup
        className="report-template-catalog"
        value={value}
        disabled={disabled}
        onValueChange={(nextValue) => onChange(nextValue as ReportTemplateSelectionId)}
      >
        {renderGroup('默认模板', [DEFAULT_REPORT_TEMPLATE])}
        {renderGroup('手机端 · 375–414 px', mobileTemplates)}
        {renderGroup('电脑端 · 1280–1920 px', desktopTemplates)}
        {externalInstalled.length > 0 && (
          <div className="report-template-group">
            <div className="report-template-group-title">已安装市场模板</div>
            <div className="report-template-list">
              {externalInstalled.map((template) => {
                const key = encodeExternalReportTemplateId(template.id, template.version)
                const entry = catalogEntryFor(template)
                const active = value === key
                return (
                  <div
                    key={key}
                    className={`report-template-item ${active ? 'active' : ''} ${disabled ? 'disabled' : ''}`}
                  >
                    <label htmlFor={`report-template-${key}`}>
                      <RadioGroupItem
                        id={`report-template-${key}`}
                        value={key}
                        aria-label={template.name}
                      />
                      {entry?.preview ? (
                        <img className="report-template-diagram" src={entry.preview} alt="" />
                      ) : (
                        <TemplateDiagram template={DEFAULT_REPORT_TEMPLATE} />
                      )}
                      <div className="report-template-body">
                        <div className="report-template-eyebrow">市场 · v{template.version}</div>
                        <div className="report-template-title">{template.name}</div>
                        <div className="report-template-tagline">
                          {entry?.description || `${template.author} · ${platformLabel(entry?.platform)}`}
                        </div>
                      </div>
                    </label>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={(event) => {
                        previewTriggerRef.current = event.currentTarget
                        setPreviewing({
                          kind: 'external',
                          id: template.id,
                          version: template.version,
                          name: template.name,
                          description: entry?.description || `${template.author} · ${template.version}`,
                          installed: true,
                          platform: entry?.platform,
                          preview: entry?.preview
                        })
                      }}
                    >
                      查看版式
                    </Button>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </RadioGroup>
      {marketError && <p className="report-inline-error">模板市场：{marketError}</p>}
      <ReportTemplatePreviewDialog
        previewing={previewing}
        restoreFocusRef={previewTriggerRef}
        onClose={() => setPreviewing(null)}
        onConfirm={(item) => {
          onChange(
            item.kind === 'builtin'
              ? item.template.id
              : encodeExternalReportTemplateId(item.id, item.version)
          )
          setPreviewing(null)
        }}
      />
    </section>
  )
}
