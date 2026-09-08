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
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  RadioGroup,
  RadioGroupItem
} from '../ui'

export type {
  SelectableReportTemplateId,
  ReportTemplateSelectionId
} from '../../../../shared/report-templates'

interface ReportTemplateSelectorProps {
  value: ReportTemplateSelectionId
  onChange: (value: ReportTemplateSelectionId) => void
  disabled?: boolean
}

type PreviewItem =
  | { kind: 'builtin'; template: ReportTemplateDefinition }
  | {
      kind: 'external'
      id: string
      version: string
      name: string
      description: string
      installed: boolean
      platform?: 'default' | 'mobile' | 'desktop'
      preview?: string
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
  const [previewing, setPreviewing] = useState<PreviewItem | null>(null)
  const [installed, setInstalled] = useState<InstalledReportTemplate[]>([])
  const [catalog, setCatalog] = useState<ReportTemplateCatalog | null>(null)
  const [marketError, setMarketError] = useState('')
  const [marketBusyKey, setMarketBusyKey] = useState('')
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
  const installedKeys = useMemo(
    () => new Set(externalInstalled.map((template) => encodeExternalReportTemplateId(template.id, template.version))),
    [externalInstalled]
  )

  const platformLabel = (platform?: 'default' | 'mobile' | 'desktop'): string =>
    platform === 'desktop' ? '桌面宽屏' : platform === 'default' ? '经典长图' : '手机长图'

  const catalogEntryFor = (template: InstalledReportTemplate): ReportTemplateCatalogEntry | undefined =>
    catalogEntries.find((entry) => entry.id === template.id && entry.version === template.version)

  const installFromCatalog = async (entry: ReportTemplateCatalogEntry): Promise<void> => {
    const key = encodeExternalReportTemplateId(entry.id, entry.version)
    if (typeof window.api.installReportTemplateFromCatalog !== 'function') {
      setMarketError('当前 TraceMemo 版本不支持模板市场安装')
      return
    }
    setMarketBusyKey(key)
    setMarketError('')
    try {
      const result = await window.api.installReportTemplateFromCatalog(entry.id, entry.version)
      if (!result.success) {
        setMarketError(result.error || `模板安装失败：${entry.name}`)
        return
      }
      await refreshMarket()
    } catch (error) {
      setMarketError(error instanceof Error ? error.message : `模板安装失败：${entry.name}`)
    } finally {
      setMarketBusyKey('')
    }
  }

  const uninstallExternal = async (template: InstalledReportTemplate): Promise<void> => {
    const key = encodeExternalReportTemplateId(template.id, template.version)
    setMarketBusyKey(key)
    setMarketError('')
    try {
      const result = await window.api.uninstallReportTemplate(template.id, template.version)
      if (!result.success) {
        setMarketError(result.error || `模板卸载失败：${template.name}`)
        return
      }
      if (value === key) onChange('v1')
      await refreshMarket()
    } catch (error) {
      setMarketError(error instanceof Error ? error.message : `模板卸载失败：${template.name}`)
    } finally {
      setMarketBusyKey('')
    }
  }

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
                    <div className="flex gap-2">
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
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={disabled || marketBusyKey === key}
                        onClick={() => void uninstallExternal(template)}
                      >
                        {marketBusyKey === key ? '处理中…' : '卸载'}
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
        {catalogEntries.filter((entry) => !installedKeys.has(encodeExternalReportTemplateId(entry.id, entry.version))).length > 0 && (
          <div className="report-template-group report-template-market">
            <div className="report-template-group-title">模板市场</div>
            <div className="report-template-list">
              {catalogEntries
                .filter((entry) => !installedKeys.has(encodeExternalReportTemplateId(entry.id, entry.version)))
                .map((entry) => {
                  const key = encodeExternalReportTemplateId(entry.id, entry.version)
                  return (
                    <div key={key} className="report-template-item">
                      <div className="report-template-body">
                        <div className="report-template-eyebrow">远端 · v{entry.version}</div>
                        <div className="report-template-title">{entry.name}</div>
                        <div className="report-template-tagline">{entry.description}</div>
                        <div className="text-xs text-muted-foreground">
                          接口 {entry.interfaceVersion} · {platformLabel(entry.platform)} · {entry.sizeBytes} bytes
                        </div>
                      </div>
                      <div className="flex gap-2">
                        {entry.preview && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={(event) => {
                              previewTriggerRef.current = event.currentTarget
                              setPreviewing({
                                kind: 'external',
                                id: entry.id,
                                version: entry.version,
                                name: entry.name,
                                description: entry.description,
                                installed: false,
                                platform: entry.platform,
                                preview: entry.preview
                              })
                            }}
                          >
                            查看版式
                          </Button>
                        )}
                        <Button
                          size="sm"
                          disabled={disabled || marketBusyKey === key}
                          onClick={() => void installFromCatalog(entry)}
                        >
                          {marketBusyKey === key ? '安装中…' : '安装'}
                        </Button>
                      </div>
                    </div>
                  )
                })}
            </div>
          </div>
        )}
      </RadioGroup>
      {marketError && <p className="report-inline-error">模板市场：{marketError}</p>}
      <Dialog
        open={Boolean(previewing)}
        onOpenChange={(open) => {
          if (!open) setPreviewing(null)
        }}
      >
        {previewing && (
          <DialogContent
            className="report-template-preview-card max-h-[90vh] max-w-[520px] overflow-y-auto bg-surface-muted p-[18px]"
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              previewTriggerRef.current?.focus()
            }}
          >
            <DialogHeader className="pr-8">
              <div className="report-template-preview-heading">
                <div>
                  <span>
                    {previewing.kind === 'builtin'
                      ? previewing.template.label
                      : `市场 · v${previewing.version}`}
                  </span>
                  <DialogTitle>
                    {previewing.kind === 'builtin' ? previewing.template.name : previewing.name}
                  </DialogTitle>
                </div>
                <em>
                  {platformLabel(
                    previewing.kind === 'builtin' ? previewing.template.platform : previewing.platform
                  )}
                </em>
              </div>
              <DialogDescription>
                {previewing.kind === 'builtin' ? previewing.template.tagline : previewing.description}
              </DialogDescription>
            </DialogHeader>
            {previewing.kind === 'builtin' ? (
              <TemplateDiagram template={previewing.template} />
            ) : previewing.preview ? (
              <img src={previewing.preview} alt={`${previewing.name} 预览`} className="max-h-[60vh] w-full object-contain" />
            ) : (
              <TemplateDiagram template={DEFAULT_REPORT_TEMPLATE} />
            )}
            <DialogDescription className="report-template-preview-note">
              生成时会自动代入当前群聊的真实头像、昵称、消息、讨论摘要、Q&amp;A、统计与关键词。
            </DialogDescription>
            <DialogFooter className="report-template-preview-actions">
              <DialogClose asChild>
                <Button variant="outline">关闭</Button>
              </DialogClose>
              {previewing.kind === 'builtin' || previewing.installed ? (
                <Button
                  onClick={() => {
                    onChange(
                      previewing.kind === 'builtin'
                        ? previewing.template.id
                        : encodeExternalReportTemplateId(previewing.id, previewing.version)
                    )
                    setPreviewing(null)
                  }}
                >
                  选择此模板
                </Button>
              ) : (
                <Button disabled>请先安装</Button>
              )}
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </section>
  )
}
