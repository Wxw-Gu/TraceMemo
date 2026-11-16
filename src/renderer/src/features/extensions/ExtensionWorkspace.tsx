import * as React from 'react'
import {
  EXTENSION_PERMISSION_INFO,
  sortPermissionsByRisk,
  type ExtensionPermission
} from '../../../../shared/extensions/permissions'
import type {
  ExtensionLogEntry,
  ExtensionPageDescriptor,
  ExtensionSystemHealth,
  InstalledExtension
} from '../../../../shared/extensions/types'
import type {
  ExtensionTemplateEntry,
  ExtensionTemplateStatus
} from '../../../../shared/extensions/templates'
import type { ExtensionDeepLink } from '../../../../shared/extensions/types'
import { Button, Spinner, useToast } from '../../components/ui'
import { ExtensionPageHost } from './ExtensionPageHost'
import { CreateProjectDialog } from './CreateProjectDialog'
import { DevelopmentGuide } from './DevelopmentGuide'
import { ExtensionTemplateGallery } from './ExtensionTemplateGallery'

const STATUS_LABELS: Record<InstalledExtension['runtime']['state'], string> = {
  inactive: '未运行',
  starting: '启动中',
  active: '运行中',
  error: '运行错误',
  crashed: '已停止'
}

function formatTimestamp(value: number): string {
  if (!value) return '—'
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

function statusTone(extension: InstalledExtension): 'success' | 'warning' | 'danger' | 'muted' {
  if (!extension.enabled) return 'muted'
  if (extension.runtime.state === 'active') return 'success'
  if (extension.runtime.state === 'crashed' || extension.runtime.state === 'error') return 'danger'
  return 'warning'
}

export interface ExtensionWorkspaceProps {
  /** 从其它页面跳过来时的定位目标。 */
  deepLink?: ExtensionDeepLink | null
  /** 消费后清空，避免返回再进来又跳一次。 */
  onConsumeDeepLink?: () => void
}

export function ExtensionWorkspace({
  deepLink,
  onConsumeDeepLink
}: ExtensionWorkspaceProps = {}): React.ReactElement {
  const { toast } = useToast()
  const [extensions, setExtensions] = React.useState<InstalledExtension[]>([])
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [logs, setLogs] = React.useState<ExtensionLogEntry[]>([])
  const [busy, setBusy] = React.useState(false)
  const [page, setPage] = React.useState<ExtensionPageDescriptor | null>(null)
  const [pendingEnable, setPendingEnable] = React.useState<InstalledExtension | null>(null)
  const [pendingUninstall, setPendingUninstall] = React.useState<string | null>(null)
  const [health, setHealth] = React.useState<ExtensionSystemHealth | null>(null)
  const [templates, setTemplates] = React.useState<ExtensionTemplateStatus[]>([])
  const [templatesLoading, setTemplatesLoading] = React.useState(true)
  const [installingTemplate, setInstallingTemplate] = React.useState<string | null>(null)
  /** 右侧主区域：扩展列表 or 官方模板画廊。 */
  const [view, setView] = React.useState<'extensions' | 'templates' | 'guide'>('extensions')
  /** 深链定位的模板：进入画廊时自动展开它。 */
  const [focusedTemplateId, setFocusedTemplateId] = React.useState<string | null>(null)
  /** 正在创建项目的模板；非空时显示创建对话框。 */
  const [creatingTemplate, setCreatingTemplate] = React.useState<ExtensionTemplateEntry | null>(
    null
  )
  /** 高风险权限的二次确认；低风险直接授权。 */
  const [pendingGrant, setPendingGrant] = React.useState<{
    extensionId: string
    permission: ExtensionPermission
  } | null>(null)
  /** 「转为正式安装」的二次确认。 */
  const [pendingConvert, setPendingConvert] = React.useState<InstalledExtension | null>(null)

  const refresh = React.useCallback(async (): Promise<void> => {
    const [list, systemHealth, templateList] = await Promise.all([
      window.api.listExtensions(),
      window.api.getExtensionHealth().catch(() => null),
      window.api.listExtensionTemplates().catch(() => [])
    ])
    setExtensions(list)
    setHealth(systemHealth)
    setTemplates(templateList)
    setTemplatesLoading(false)
    setSelectedId((current) => {
      if (current && list.some((item) => item.id === current)) return current
      return list[0]?.id ?? null
    })
  }, [])

  React.useEffect(() => {
    void refresh().catch(() => undefined)
    const unsubscribe = window.api.onExtensionChanged(() => {
      void refresh().catch(() => undefined)
    })
    return unsubscribe
  }, [refresh])

  /**
   * 消费深链：只切视图与选中项，不触发任何安装/启用动作。
   * 真正的操作仍要用户在界面上点。
   */
  React.useEffect(() => {
    if (!deepLink) return
    if (deepLink.development) {
      setView('guide')
    }
    if (deepLink.templateId) {
      setView('templates')
      setFocusedTemplateId(deepLink.templateId)
    }
    if (deepLink.extensionId) {
      setView('extensions')
      setSelectedId(deepLink.extensionId)
    }
    onConsumeDeepLink?.()
  }, [deepLink, onConsumeDeepLink])

  const selected = React.useMemo(
    () => extensions.find((item) => item.id === selectedId) ?? null,
    [extensions, selectedId]
  )

  const selectedIdForLogs = selected?.id
  const selectedRuntimeState = selected?.runtime.state
  const selectedUpdatedAt = selected?.updatedAt

  React.useEffect(() => {
    if (!selectedIdForLogs) {
      setLogs([])
      return
    }
    let disposed = false
    void window.api
      .getExtensionLogs(selectedIdForLogs, 60)
      .then((entries) => {
        if (!disposed) setLogs(entries)
      })
      .catch(() => undefined)
    return () => {
      disposed = true
    }
  }, [selectedIdForLogs, selectedRuntimeState, selectedUpdatedAt])

  const run = async <T,>(action: () => Promise<T>, successMessage?: string): Promise<T | null> => {
    setBusy(true)
    try {
      return await action()
    } catch (error) {
      toast({
        title: '操作失败',
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive'
      })
      return null
    } finally {
      setBusy(false)
      if (successMessage) toast({ title: successMessage, variant: 'success' })
    }
  }

  const installFrom = async (kind: 'directory' | 'package'): Promise<void> => {
    const target =
      kind === 'directory'
        ? await window.api.pickExtensionDirectory()
        : await window.api.pickExtensionPackage()
    if (!target) return
    setBusy(true)
    try {
      const result =
        kind === 'directory'
          ? await window.api.installExtensionFromDirectory(target)
          : await window.api.installExtensionFromPackage(target)
      if (!result.success) {
        toast({
          title: '安装失败',
          description: result.error?.message || '扩展安装失败',
          variant: 'destructive'
        })
        return
      }
      await refresh()
      if (result.extension) setSelectedId(result.extension.id)
      toast({
        title: '扩展已安装',
        description: `${result.extension?.name || ''} ${result.extension?.version || ''}`.trim(),
        variant: 'success'
      })
    } finally {
      setBusy(false)
    }
  }

  const requestEnable = (extension: InstalledExtension): void => {
    const risky = extension.permissions.filter(
      (permission) => EXTENSION_PERMISSION_INFO[permission].risk !== 'low'
    )
    if (risky.length > 0) {
      setPendingEnable(extension)
      return
    }
    void toggleEnabled(extension, true)
  }

  const toggleEnabled = async (extension: InstalledExtension, enabled: boolean): Promise<void> => {
    setPendingEnable(null)
    const result = await run(() => window.api.setExtensionEnabled(extension.id, enabled))
    if (result?.success) {
      toast({
        title: enabled ? '扩展已启用' : '扩展已停用',
        description: extension.name,
        variant: 'success'
      })
      await refresh()
    } else if (result && !result.success) {
      toast({
        title: enabled ? '启用失败' : '停用失败',
        description: result.error?.message || '操作失败',
        variant: 'destructive'
      })
    }
  }

  const confirmUninstall = async (extension: InstalledExtension): Promise<void> => {
    setPendingUninstall(null)
    const result = await run(() => window.api.uninstallExtension(extension.id, true))
    if (result?.success) {
      toast({ title: '扩展已卸载', description: '扩展数据已保留', variant: 'success' })
      await refresh()
    } else if (result && !result.success) {
      toast({
        title: '卸载失败',
        description: result.error?.message || '操作失败',
        variant: 'destructive'
      })
    }
  }

  /** 授权 manifest 新声明的权限；后台会重启，新能力立即生效。 */
  const grantPending = async (extension: InstalledExtension): Promise<void> => {
    if (extension.pendingPermissions.length === 0) return
    const result = await run(() =>
      window.api.grantExtensionPermissions(extension.id, extension.pendingPermissions)
    )
    if (result?.success) {
      toast({ title: '权限已更新', description: extension.name, variant: 'success' })
      await refresh()
    } else if (result && !result.success) {
      toast({
        title: '授权失败',
        description: result.error?.message || '操作失败',
        variant: 'destructive'
      })
    }
  }

  /** 重置损坏的扩展配置；损坏现场已经由存储层另存。 */
  const resetStorage = async (extension: InstalledExtension): Promise<void> => {
    const result = await run(() => window.api.resetExtensionStorage(extension.id))
    if (result?.success) {
      toast({ title: '配置已重置', description: extension.name, variant: 'success' })
      await refresh()
    } else if (result && !result.success) {
      toast({
        title: '重置失败',
        description: result.error?.message || '操作失败',
        variant: 'destructive'
      })
    }
  }

  const grantPermission = async (
    extension: InstalledExtension,
    permission: ExtensionPermission
  ): Promise<void> => {
    const result = await run(() => window.api.grantExtensionPermissions(extension.id, [permission]))
    setPendingGrant(null)
    if (result?.success) {
      toast({
        title: '已授权',
        description: EXTENSION_PERMISSION_INFO[permission].label,
        variant: 'success'
      })
      await refresh()
    } else if (result && !result.success) {
      toast({
        title: '授权失败',
        description: result.error?.message || '操作失败',
        variant: 'destructive'
      })
    }
  }

  const revokePermission = async (
    extension: InstalledExtension,
    permission: ExtensionPermission
  ): Promise<void> => {
    const result = await run(() => window.api.revokeExtensionPermission(extension.id, permission))
    if (result?.success) {
      toast({
        title: '已撤销',
        description: EXTENSION_PERMISSION_INFO[permission].label,
        variant: 'success'
      })
      await refresh()
    } else if (result && !result.success) {
      toast({
        title: '撤销失败',
        description: result.error?.message || '操作失败',
        variant: 'destructive'
      })
    }
  }

  /** 接受从备份恢复出来的配置；之后才允许启用该扩展。 */
  const acknowledgeStorage = async (extension: InstalledExtension): Promise<void> => {
    const result = await run(() => window.api.acknowledgeExtensionStorage(extension.id))
    if (result?.success) {
      toast({ title: '已接受恢复的配置', description: '现在可以启用该扩展', variant: 'success' })
      await refresh()
    }
  }

  /** 把状态记录的版本对齐到磁盘上的 manifest。 */
  const adoptInstalledCode = async (extension: InstalledExtension): Promise<void> => {
    const result = await run(() => window.api.adoptExtensionCode(extension.id))
    if (result?.success) {
      toast({ title: '已采用当前代码版本', description: extension.name, variant: 'success' })
      await refresh()
    }
  }

  /** 把升级过渡备份换回来。 */
  const rollbackUpgrade = async (extension: InstalledExtension): Promise<void> => {
    const result = await run(() => window.api.rollbackExtensionUpgrade(extension.id))
    if (result?.success) {
      toast({ title: '已回滚到备份版本', description: extension.name, variant: 'success' })
      await refresh()
    }
  }

  /** 确认「状态文件曾损坏并恢复」，只清除提示。 */
  const acknowledgeRecovery = async (): Promise<void> => {
    const result = await run(() => window.api.acknowledgeExtensionRecovery())
    if (result?.success) await refresh()
  }

  const installTemplate = async (templateId: string): Promise<void> => {
    setInstallingTemplate(templateId)
    try {
      const result = await window.api.installExtensionTemplate(templateId)
      if (!result.success) {
        toast({
          title: '模板安装失败',
          description: result.error?.message || '安装失败',
          variant: 'destructive'
        })
        return
      }
      await refresh()
      setView('extensions')
      if (result.extension) setSelectedId(result.extension.id)
      toast({
        title: '模板已安装',
        description: `${result.extension?.name || ''} 需要你确认权限后手动启用`.trim(),
        variant: 'success'
      })
    } catch (error) {
      toast({
        title: '模板安装失败',
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive'
      })
    } finally {
      setInstallingTemplate(null)
    }
  }

  /** 链接外部开发项目；目录由主进程再校验一次。 */
  const linkProject = async (): Promise<void> => {
    const directory = await window.api.pickExtensionProjectDirectory()
    if (!directory) return
    const result = await run(() => window.api.linkExtensionDevelopment(directory))
    if (result?.success) {
      toast({
        title: '已链接开发项目',
        description: '确认权限后即可启用；修改代码后可点「重新加载」',
        variant: 'success'
      })
      await refresh()
      setView('extensions')
      if (result.extension) setSelectedId(result.extension.id)
    } else if (result && !result.success) {
      toast({
        title: '链接失败',
        description: result.error?.message || '操作失败',
        variant: 'destructive'
      })
    }
  }

  const submitCreateProject = async (input: {
    extensionId: string
    name: string
  }): Promise<void> => {
    const template = creatingTemplate
    if (!template) return
    const targetDirectory = await window.api.pickExtensionProjectDirectory()
    if (!targetDirectory) return
    setInstallingTemplate(`create:${template.templateId}`)
    try {
      const result = await window.api.createExtensionProject({
        templateId: template.templateId,
        targetDirectory,
        extensionId: input.extensionId,
        name: input.name
      })
      if (!result.success) {
        toast({
          title: '创建项目失败',
          description: result.error?.message || '操作失败',
          variant: 'destructive'
        })
        return
      }
      setCreatingTemplate(null)
      toast({
        title: '项目已生成',
        description: result.projectPath || '',
        variant: 'success'
      })
      await refresh()
    } finally {
      setInstallingTemplate(null)
    }
  }

  const reloadDevelopment = async (extension: InstalledExtension): Promise<void> => {
    const result = await run(() => window.api.reloadExtensionDevelopment(extension.id))
    if (result?.success) {
      toast({ title: '已重新加载', description: extension.name, variant: 'success' })
    } else if (result && !result.success) {
      toast({
        title: '重新加载失败',
        description: result.error?.message || '操作失败',
        variant: 'destructive'
      })
    }
    await refresh()
  }

  const unlinkDevelopment = async (extension: InstalledExtension): Promise<void> => {
    const result = await run(() => window.api.unlinkExtensionDevelopment(extension.id, true))
    if (result?.success) {
      toast({
        title: '已移除开发链接',
        description: '外部源码目录没有被删除',
        variant: 'success'
      })
      await refresh()
    } else if (result && !result.success) {
      toast({
        title: '移除失败',
        description: result.error?.message || '操作失败',
        variant: 'destructive'
      })
    }
  }

  const convertDevelopment = async (extension: InstalledExtension): Promise<void> => {
    const result = await run(() => window.api.convertExtensionDevelopment(extension.id))
    if (result?.success) {
      toast({ title: '已转为正式安装', description: extension.name, variant: 'success' })
      await refresh()
    } else if (result && !result.success) {
      toast({
        title: '转换失败',
        description: result.error?.message || '操作失败',
        variant: 'destructive'
      })
    }
  }

  const exportProject = async (extension: InstalledExtension): Promise<void> => {
    const targetDirectory = await window.api.pickExtensionProjectDirectory()
    if (!targetDirectory) return
    const result = await run(() =>
      window.api.exportExtensionAsProject(extension.id, targetDirectory)
    )
    if (result?.success) {
      toast({
        title: '已导出为开发项目',
        description: result.projectPath || '',
        variant: 'success'
      })
      await refresh()
    } else if (result && !result.success) {
      toast({
        title: '导出失败',
        description: result.error?.message || '操作失败',
        variant: 'destructive'
      })
    }
  }

  const openDevelopmentSource = async (extension: InstalledExtension): Promise<void> => {
    const result = await window.api.openExtensionDevelopmentSource(extension.id)
    if (!result.success) {
      toast({
        title: '无法打开源码目录',
        description: result.error?.message || '目录不可用',
        variant: 'destructive'
      })
    }
  }

  if (page) {
    return (
      <ExtensionPageHost
        descriptor={page}
        onBack={() => {
          setPage(null)
          void refresh().catch(() => undefined)
        }}
      />
    )
  }

  return (
    <div className="extension-workspace">
      <aside className="extension-sidebar">
        <header className="extension-sidebar-header">
          <div>
            <h2>扩展</h2>
            <p>把二次开发从官方源码里剥离出来</p>
          </div>
          <span className="extension-count">{extensions.length}</span>
        </header>
        {health && health.registry.state !== 'ok' && (
          <div className="extension-health-banner">
            <span>
              {health.registry.state === 'unreadable'
                ? '扩展状态文件损坏且无法恢复，已停止写入以保留现场。请保留 extensions-state 下的损坏文件。'
                : health.registry.message || '扩展状态文件曾损坏，已自动恢复。'}
            </span>
            {health.registry.state !== 'unreadable' && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void acknowledgeRecovery()}
              >
                我知道了
              </Button>
            )}
          </div>
        )}
        <Button
          size="sm"
          variant={view === 'templates' ? 'default' : 'outline'}
          className="extension-template-entry"
          onClick={() => setView(view === 'templates' ? 'extensions' : 'templates')}
        >
          官方模板{templates.length > 0 ? ` (${templates.length})` : ''}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className={
            view === 'guide' ? 'extension-template-entry is-active' : 'extension-template-entry'
          }
          onClick={() => setView(view === 'guide' ? 'extensions' : 'guide')}
        >
          二次开发
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="extension-template-entry"
          disabled={busy}
          onClick={() => void linkProject()}
        >
          链接本地项目
        </Button>
        <div className="extension-install-row">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void installFrom('directory')}
          >
            安装目录
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void installFrom('package')}
          >
            安装 ZIP
          </Button>
        </div>
        <div className="extension-list" role="listbox" aria-label="已安装扩展">
          {extensions.length === 0 ? (
            <p className="extension-empty">
              还没有安装扩展。可以在 <code>examples/extensions</code> 下找到两个可直接安装的示例。
            </p>
          ) : (
            extensions.map((extension) => (
              <button
                key={extension.id}
                type="button"
                role="option"
                aria-selected={extension.id === selectedId}
                className={`extension-list-item ${extension.id === selectedId ? 'is-active' : ''}`}
                onClick={() => setSelectedId(extension.id)}
              >
                <span
                  className={`extension-status-dot tone-${statusTone(extension)}`}
                  aria-hidden
                />
                <span className="extension-list-main">
                  <span className="extension-list-name">{extension.name}</span>
                  <span className="extension-list-meta">
                    v{extension.version} ·{' '}
                    {extension.enabled ? STATUS_LABELS[extension.runtime.state] : '已停用'}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>
      </aside>

      <section className="extension-detail" aria-label="扩展详情">
        {view === 'guide' ? (
          <DevelopmentGuide
            onBack={() => setView('extensions')}
            onCreateProject={() => setView('templates')}
            onLinkProject={() => void linkProject()}
          />
        ) : view === 'templates' ? (
          <ExtensionTemplateGallery
            templates={templates}
            loading={templatesLoading}
            busyId={installingTemplate}
            onInstall={(templateId) => void installTemplate(templateId)}
            focusTemplateId={focusedTemplateId}
            onCreateProject={(templateId) => {
              const found = templates.find((item) => item.template.templateId === templateId)
              if (found) setCreatingTemplate(found.template)
            }}
          />
        ) : !selected ? (
          <div className="extension-detail-empty">
            <h3>选择左侧的扩展</h3>
            <p>安装后在这里查看权限、页面、自动化动作与执行日志。</p>
          </div>
        ) : (
          <>
            <header className="extension-detail-header">
              <div>
                <div className="extension-detail-title">
                  <h3>{selected.name}</h3>
                  <span className="extension-version">v{selected.version}</span>
                  <span className={`extension-badge tone-${statusTone(selected)}`}>
                    {selected.enabled ? STATUS_LABELS[selected.runtime.state] : '已停用'}
                  </span>
                </div>
                <p className="extension-detail-description">
                  {selected.description || '该扩展没有提供描述。'}
                </p>
                <p className="extension-detail-id">{selected.id}</p>
                {!selected.compatibility.compatible && (
                  <p className="extension-incompatible">
                    {selected.compatibility.reason || '扩展与当前版本不兼容'}
                  </p>
                )}
                {selected.storage.state !== 'ok' && (
                  <div className="extension-runtime-error extension-alert-row">
                    <span>
                      {selected.storage.state === 'recovered-from-backup'
                        ? '扩展配置曾损坏，已从备份恢复；确认前不会启动。'
                        : '扩展配置损坏且没有可用备份，写入已停止。可在下方重置配置。'}
                    </span>
                    {selected.storage.state === 'recovered-from-backup' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => void acknowledgeStorage(selected)}
                      >
                        使用恢复的配置
                      </Button>
                    )}
                  </div>
                )}
                {selected.runtime.note && (
                  <p className="extension-muted">{selected.runtime.note}</p>
                )}
                {selected.runtime.lastError && (
                  <div className="extension-runtime-error extension-alert-row">
                    <span>{selected.runtime.lastError}</span>
                    {selected.runtime.lastError.includes('升级可能中断') && (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => void adoptInstalledCode(selected)}
                        >
                          采用当前代码
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => void rollbackUpgrade(selected)}
                        >
                          回滚到备份
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </div>
              <div className="extension-detail-actions">
                <Button
                  size="sm"
                  variant={selected.enabled ? 'outline' : 'default'}
                  disabled={busy || !selected.compatibility.compatible}
                  onClick={() =>
                    selected.enabled ? void toggleEnabled(selected, false) : requestEnable(selected)
                  }
                >
                  {selected.enabled ? '停用' : '启用'}
                </Button>
                {selected.pages.length > 0 && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      void window.api
                        .getExtensionPageUrl(selected.id, selected.pages[0]?.id)
                        .then(setPage)
                        .catch(() => undefined)
                    }}
                  >
                    打开页面
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void window.api.openExtensionDataDir(selected.id)}
                >
                  数据目录
                </Button>
              </div>
            </header>

            <div className="extension-detail-grid">
              <section className="extension-card">
                <h4>页面</h4>
                {selected.pages.length === 0 ? (
                  <p className="extension-muted">该扩展没有注册页面。</p>
                ) : (
                  <ul className="extension-page-list">
                    {selected.pages.map((item) => (
                      <li key={item.id}>
                        <span>{item.title}</span>
                        <Button
                          size="sm"
                          variant="link"
                          onClick={() => {
                            void window.api
                              .getExtensionPageUrl(selected.id, item.id)
                              .then(setPage)
                              .catch(() => undefined)
                          }}
                        >
                          打开
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {selected.development && (
                <section className="extension-card">
                  <div className="extension-card-header">
                    <h4>开发模式</h4>
                    <span
                      className={`extension-grant ${selected.development.available ? 'is-granted' : ''}`}
                    >
                      {selected.development.available ? '源码可用' : '源码不可用'}
                    </span>
                  </div>
                  <p className="extension-muted extension-source-path">
                    {selected.development.sourcePath || '未记录源码路径'}
                  </p>
                  {!selected.development.available && (
                    <p className="extension-runtime-error">
                      源码目录被移动或删除。扩展配置与规则都还在，重新链接后即可继续。
                    </p>
                  )}
                  {pendingConvert?.id === selected.id && (
                    <div className="extension-confirm-block">
                      <p>
                        将把当前源码<strong>复制</strong>到 TraceMemo
                        用户数据目录，之后运行的是这份安装副本。
                        外部源码目录不会被删除，但你之后对它的修改<strong>不会</strong>
                        自动同步过去。
                        转换会停止当前后台，转换后保持「未启用」；已有配置、规则与缓存都保留。
                      </p>
                      <div className="extension-confirm-actions">
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() => {
                            const target = pendingConvert
                            setPendingConvert(null)
                            if (target) void convertDevelopment(target)
                          }}
                        >
                          确认转换
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setPendingConvert(null)}>
                          取消
                        </Button>
                      </div>
                    </div>
                  )}
                  <div className="extension-detail-actions">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || !selected.development.available}
                      onClick={() => void reloadDevelopment(selected)}
                    >
                      重新加载
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy || !selected.development.available}
                      onClick={() => void openDevelopmentSource(selected)}
                    >
                      打开源码目录
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setPendingConvert(selected)}
                    >
                      转为正式安装
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void unlinkDevelopment(selected)}
                    >
                      移除链接
                    </Button>
                  </div>
                </section>
              )}

              <section className="extension-card">
                <div className="extension-card-header">
                  <h4>权限</h4>
                  {selected.pendingPermissions.length > 0 && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void grantPending(selected)}
                    >
                      授权新增权限
                    </Button>
                  )}
                </div>
                {selected.pendingPermissions.length > 0 && (
                  <p className="extension-muted">
                    新版本申请了 {selected.pendingPermissions.length} 项尚未授予的权限，当前不可用。
                  </p>
                )}
                {selected.permissions.length === 0 ? (
                  <p className="extension-muted">未申请任何权限。</p>
                ) : (
                  <ul className="extension-permission-list">
                    {sortPermissionsByRisk(selected.permissions).map((permission) => (
                      <li key={permission}>
                        <div>
                          <span className="extension-permission-label">
                            {EXTENSION_PERMISSION_INFO[permission].label}
                          </span>
                          <span
                            className={`extension-permission-risk risk-${EXTENSION_PERMISSION_INFO[permission].risk}`}
                          >
                            {EXTENSION_PERMISSION_INFO[permission].risk === 'high'
                              ? '高'
                              : EXTENSION_PERMISSION_INFO[permission].risk === 'medium'
                                ? '中'
                                : '低'}
                          </span>
                        </div>
                        <p>{EXTENSION_PERMISSION_INFO[permission].description}</p>
                        {selected.grantedPermissions.includes(permission) ? (
                          <div className="extension-permission-actions">
                            <span className="extension-grant is-granted">已授予</span>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => void revokePermission(selected, permission)}
                            >
                              撤销
                            </Button>
                          </div>
                        ) : (
                          <div className="extension-permission-actions">
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => {
                                if (EXTENSION_PERMISSION_INFO[permission].risk === 'high') {
                                  setPendingGrant({ extensionId: selected.id, permission })
                                } else {
                                  void grantPermission(selected, permission)
                                }
                              }}
                            >
                              授权
                            </Button>
                          </div>
                        )}
                        {pendingGrant?.extensionId === selected.id &&
                          pendingGrant.permission === permission && (
                            <div className="extension-confirm-row">
                              <span>
                                该权限可以代替你执行敏感操作，确认授予「
                                {EXTENSION_PERMISSION_INFO[permission].label}」？
                              </span>
                              <Button
                                size="sm"
                                disabled={busy}
                                onClick={() => void grantPermission(selected, permission)}
                              >
                                确认授权
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setPendingGrant(null)}
                              >
                                取消
                              </Button>
                            </div>
                          )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="extension-card extension-card-wide">
                <h4>自动化动作</h4>
                {selected.automationActions.length === 0 ? (
                  <p className="extension-muted">该扩展没有注册自动化动作。</p>
                ) : (
                  <ul className="extension-action-list">
                    {selected.automationActions.map((action) => (
                      <li key={action.id}>
                        <span>{action.title}</span>
                        <span
                          className={`extension-grant ${action.registered ? 'is-granted' : ''}`}
                        >
                          {action.registered ? '已注册' : '未注册'}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="extension-card extension-card-wide">
                <div className="extension-card-header">
                  <h4>运行日志</h4>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      void window.api.clearExtensionLogs(selected.id).then(() => setLogs([]))
                    }}
                  >
                    清空
                  </Button>
                </div>
                {logs.length === 0 ? (
                  <p className="extension-muted">暂无日志。</p>
                ) : (
                  <ul className="extension-log-list">
                    {logs.map((entry) => (
                      <li key={entry.id} className={`log-${entry.level}`}>
                        <span className="extension-log-time">{formatTimestamp(entry.at)}</span>
                        <span className="extension-log-source">
                          {entry.source === 'extension' ? '扩展' : '宿主'}
                        </span>
                        <span className="extension-log-message">{entry.message}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>

            <footer className="extension-detail-footer">
              <span>安装于 {formatTimestamp(selected.installedAt)}</span>
              {!selected.development && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void exportProject(selected)}
                >
                  导出为开发项目
                </Button>
              )}
              {selected.storage.state === 'unrecovered' && (
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => void resetStorage(selected)}
                >
                  重置配置
                </Button>
              )}
              {pendingUninstall === selected.id ? (
                <span className="extension-uninstall-confirm">
                  卸载后扩展代码会被移除，配置与数据默认保留。
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => void confirmUninstall(selected)}
                  >
                    确认卸载
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setPendingUninstall(null)}>
                    取消
                  </Button>
                </span>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => setPendingUninstall(selected.id)}>
                  卸载
                </Button>
              )}
            </footer>
          </>
        )}
      </section>

      {creatingTemplate && (
        <CreateProjectDialog
          template={creatingTemplate}
          busy={installingTemplate === `create:${creatingTemplate.templateId}`}
          onCancel={() => setCreatingTemplate(null)}
          onSubmit={(input) => void submitCreateProject(input)}
        />
      )}

      {pendingEnable && (
        <div className="extension-modal-backdrop" role="dialog" aria-modal="true">
          <div className="extension-modal">
            <h3>启用「{pendingEnable.name}」</h3>
            <p>该扩展会获得以下权限。扩展代码在独立进程中运行，但仍属于受信任的本地代码。</p>
            <ul className="extension-permission-list">
              {sortPermissionsByRisk(pendingEnable.permissions).map(
                (permission: ExtensionPermission) => (
                  <li key={permission}>
                    <div>
                      <span className="extension-permission-label">
                        {EXTENSION_PERMISSION_INFO[permission].label}
                      </span>
                    </div>
                    <p>{EXTENSION_PERMISSION_INFO[permission].description}</p>
                  </li>
                )
              )}
            </ul>
            <div className="extension-modal-actions">
              <Button variant="ghost" onClick={() => setPendingEnable(null)}>
                取消
              </Button>
              <Button onClick={() => void toggleEnabled(pendingEnable, true)}>确认启用</Button>
            </div>
          </div>
        </div>
      )}

      {busy && (
        <div className="extension-busy" aria-live="polite">
          <Spinner />
        </div>
      )}
    </div>
  )
}
