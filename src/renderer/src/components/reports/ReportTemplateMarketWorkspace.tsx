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
import { Button } from '../ui'
import {
  ReportTemplatePreviewDialog,
  TemplateDiagram,
  reportTemplatePlatformLabel,
  type ReportTemplatePreviewItem
} from './ReportTemplatePreview'

/** 社区模板仓库：投稿模板从这里提交 PR。 */
const TEMPLATE_REPOSITORY_URL = 'https://github.com/Wxw-Gu/TraceMemo-Templates'

/**
 * 社区模板市场独立页面：日报工作区顶部标签页的第三个入口。
 *
 * 与「生成群聊日报」里的模板选择器读同一套 IPC 与远端 catalog。这里是模板市场的主入口：
 * 浏览、预览、安装、选用和卸载；生成页只保留选用与预览，不再重复展示市场列表。
 */
export function ReportTemplateMarketWorkspace({
  value,
  onChange
}: {
  value: ReportTemplateSelectionId
  onChange: (value: ReportTemplateSelectionId) => void
}): React.ReactElement {
  const [installed, setInstalled] = useState<InstalledReportTemplate[]>([])
  const [catalog, setCatalog] = useState<ReportTemplateCatalog | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [busyKey, setBusyKey] = useState('')
  const [previewing, setPreviewing] = useState<ReportTemplatePreviewItem | null>(null)
  const previewTriggerRef = useRef<HTMLButtonElement | null>(null)

  const refresh = async (): Promise<void> => {
    if (typeof window === 'undefined' || !window.api) {
      setLoading(false)
      return
    }
    setError('')
    if (typeof window.api.listReportTemplates === 'function') {
      try {
        const listed = await window.api.listReportTemplates()
        if (Array.isArray(listed)) setInstalled(listed)
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : '已安装模板加载失败')
      }
    }
    if (typeof window.api.listReportTemplateCatalog === 'function') {
      try {
        const result = await window.api.listReportTemplateCatalog()
        if (result.success && result.catalog) setCatalog(result.catalog)
        else setError(result.error || '远端模板目录加载失败')
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : '远端模板目录加载失败')
      }
    }
    setLoading(false)
  }

  useEffect(() => {
    void refresh()
  }, [])

  const externalInstalled = useMemo(
    () => installed.filter((template) => template.source === 'installed'),
    [installed]
  )
  const catalogEntries = catalog?.templates || []
  const installedKeys = useMemo(
    () =>
      new Set(
        externalInstalled.map((template) =>
          encodeExternalReportTemplateId(template.id, template.version)
        )
      ),
    [externalInstalled]
  )
  const availableEntries = useMemo(
    () =>
      catalogEntries.filter(
        (entry) => !installedKeys.has(encodeExternalReportTemplateId(entry.id, entry.version))
      ),
    [catalogEntries, installedKeys]
  )

  const catalogEntryFor = (
    template: InstalledReportTemplate
  ): ReportTemplateCatalogEntry | undefined =>
    catalogEntries.find((entry) => entry.id === template.id && entry.version === template.version)

  const install = async (entry: ReportTemplateCatalogEntry): Promise<void> => {
    const key = encodeExternalReportTemplateId(entry.id, entry.version)
    if (typeof window.api.installReportTemplateFromCatalog !== 'function') {
      setError('当前 TraceMemo 版本不支持模板市场安装')
      return
    }
    setBusyKey(key)
    setError('')
    try {
      const result = await window.api.installReportTemplateFromCatalog(entry.id, entry.version)
      if (!result.success) {
        setError(result.error || `模板安装失败：${entry.name}`)
        return
      }
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `模板安装失败：${entry.name}`)
    } finally {
      setBusyKey('')
    }
  }

  /**
   * 卸载市场模板。卸载掉的正好是当前选中的模板时回退到默认模板，
   * 避免生成页保留一个已经不存在的模板引用。
   */
  const uninstall = async (template: InstalledReportTemplate): Promise<void> => {
    const key = encodeExternalReportTemplateId(template.id, template.version)
    setBusyKey(key)
    setError('')
    try {
      const result = await window.api.uninstallReportTemplate(template.id, template.version)
      if (!result.success) {
        setError(result.error || `模板卸载失败：${template.name}`)
        return
      }
      if (value === key) onChange(DEFAULT_REPORT_TEMPLATE.id)
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `模板卸载失败：${template.name}`)
    } finally {
      setBusyKey('')
    }
  }

  const openPreview = (item: ReportTemplatePreviewItem, trigger: HTMLButtonElement): void => {
    previewTriggerRef.current = trigger
    setPreviewing(item)
  }

  const renderBuiltinRow = (template: ReportTemplateDefinition): React.ReactElement => (
    <div
      key={template.id}
      className={`report-template-item ${value === template.id ? 'active' : ''}`}
    >
      <TemplateDiagram template={template} />
      <div className="report-template-body">
        <div className="report-template-eyebrow">
          {template.platform === 'default' ? '默认模板' : template.label}
        </div>
        <div className="report-template-title">{template.name}</div>
        <div className="report-template-tagline">{template.tagline}</div>
      </div>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={(event) => openPreview({ kind: 'builtin', template }, event.currentTarget)}
        >
          查看版式
        </Button>
      </div>
    </div>
  )

  const renderInstalledGroup = (): React.ReactElement | null => {
    if (!externalInstalled.length) return null
    return (
      <section className="report-template-group">
        <div className="report-template-group-title">已安装市场模板</div>
        <div className="report-template-list">
          {externalInstalled.map((template) => {
            const key = encodeExternalReportTemplateId(template.id, template.version)
            const entry = catalogEntryFor(template)
            return (
              <div key={key} className={`report-template-item ${value === key ? 'active' : ''}`}>
                {entry?.preview ? (
                  <img className="report-template-diagram" src={entry.preview} alt="" />
                ) : (
                  <TemplateDiagram template={DEFAULT_REPORT_TEMPLATE} />
                )}
                <div className="report-template-body">
                  <div className="report-template-eyebrow">市场 · v{template.version}</div>
                  <div className="report-template-title">{template.name}</div>
                  <div className="report-template-tagline">
                    {entry?.description || `${template.author} · ${reportTemplatePlatformLabel(entry?.platform)}`}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={(event) =>
                      openPreview(
                        {
                          kind: 'external',
                          id: template.id,
                          version: template.version,
                          name: template.name,
                          description:
                            entry?.description || `${template.author} · ${template.version}`,
                          installed: true,
                          platform: entry?.platform,
                          preview: entry?.preview
                        },
                        event.currentTarget
                      )
                    }
                  >
                    查看版式
                  </Button>
                  {value === key ? (
                    <Button variant="ghost" size="sm" disabled>
                      当前使用
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busyKey === key}
                    onClick={() => void uninstall(template)}
                  >
                    {busyKey === key ? '处理中…' : '卸载'}
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      </section>
    )
  }

  const renderAvailableGroup = (): React.ReactElement | null => {
    if (!availableEntries.length) return null
    return (
      <section className="report-template-group">
        <div className="report-template-group-title">模板市场</div>
        <div className="report-template-list">
          {availableEntries.map((entry) => {
            const key = encodeExternalReportTemplateId(entry.id, entry.version)
            return (
              <div key={key} className="report-template-item">
                {entry.preview ? (
                  <img className="report-template-diagram" src={entry.preview} alt="" />
                ) : (
                  <TemplateDiagram template={DEFAULT_REPORT_TEMPLATE} />
                )}
                <div className="report-template-body">
                  <div className="report-template-eyebrow">
                    市场 · v{entry.version} · {entry.author}
                  </div>
                  <div className="report-template-title">{entry.name}</div>
                  <div className="report-template-tagline">{entry.description}</div>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={(event) =>
                      openPreview(
                        {
                          kind: 'external',
                          id: entry.id,
                          version: entry.version,
                          name: entry.name,
                          description: entry.description,
                          installed: false,
                          platform: entry.platform,
                          preview: entry.preview
                        },
                        event.currentTarget
                      )
                    }
                  >
                    查看版式
                  </Button>
                  <Button size="sm" disabled={busyKey === key} onClick={() => void install(entry)}>
                    {busyKey === key ? '安装中…' : '安装'}
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      </section>
    )
  }

  const describeMarketState = (): string => {
    if (loading) return '正在读取模板市场…'
    if (error) return `模板市场：${error}`
    if (!catalogEntries.length && !externalInstalled.length) return '模板市场暂无可安装模板。'
    return `已安装 ${externalInstalled.length} 个市场模板，另有 ${availableEntries.length} 个可以安装。`
  }

  return (
    <div className="report-market-page">
      <header className="report-market-header">
        <div>
          <h1>社区模板市场</h1>
          <p>
            模板与默认日报读取同一份真实数据，只改变展示方式，适合手机长图分享、桌面归档与团队复盘。
            这里可以浏览、预览、安装、选用和卸载社区模板。
          </p>
        </div>
        <Button variant="outline" size="sm" disabled={loading} onClick={() => void refresh()}>
          {loading ? '刷新中…' : '刷新'}
        </Button>
      </header>

      <section className="report-market-contribute" aria-label="投稿模板">
        <div>
          <strong>想把你做的模板分享给其他人？</strong>
          <p>
            如果想提供给其他人模板样式，可以来 TraceMemo-Templates
            项目里提交 PR，方便给其他用户使用。
          </p>
        </div>
        <a
          className="report-market-contribute-link"
          href={TEMPLATE_REPOSITORY_URL}
          target="_blank"
          rel="noreferrer"
        >
          前往提交模板
        </a>
      </section>

      <p className="report-market-summary" role="status">
        {describeMarketState()}
      </p>

      <div className="report-market-body">
        <section className="report-template-group">
          <div className="report-template-group-title">默认模板</div>
          <div className="report-template-list">{renderBuiltinRow(DEFAULT_REPORT_TEMPLATE)}</div>
        </section>

        <section className="report-template-group">
          <div className="report-template-group-title">手机端 · 375–414 px</div>
          <div className="report-template-list">
            {REPORT_TEMPLATES.filter((template) => template.platform === 'mobile').map(
              renderBuiltinRow
            )}
          </div>
        </section>

        <section className="report-template-group">
          <div className="report-template-group-title">电脑端 · 1280–1920 px</div>
          <div className="report-template-list">
            {REPORT_TEMPLATES.filter((template) => template.platform === 'desktop').map(
              renderBuiltinRow
            )}
          </div>
        </section>

        {renderInstalledGroup()}
        {renderAvailableGroup()}

        {catalog?.generatedAt ? (
          <p className="report-market-footnote">
            目录更新于 {new Date(catalog.generatedAt).toLocaleString('zh-CN')}
            {catalog.source?.commit ? ` · ${catalog.source.commit.slice(0, 8)}` : ''}
          </p>
        ) : null}
      </div>

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
    </div>
  )
}
