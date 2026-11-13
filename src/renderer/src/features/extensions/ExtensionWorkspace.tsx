import * as React from 'react'
import {
  EXTENSION_PERMISSION_INFO,
  sortPermissionsByRisk,
  type ExtensionPermission
} from '../../../../shared/extensions/permissions'
import type {
  ExtensionLogEntry,
  ExtensionPageDescriptor,
  InstalledExtension
} from '../../../../shared/extensions/types'
import { Button, Spinner, useToast } from '../../components/ui'
import { ExtensionPageHost } from './ExtensionPageHost'

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

export function ExtensionWorkspace(): React.ReactElement {
  const { toast } = useToast()
  const [extensions, setExtensions] = React.useState<InstalledExtension[]>([])
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [logs, setLogs] = React.useState<ExtensionLogEntry[]>([])
  const [busy, setBusy] = React.useState(false)
  const [page, setPage] = React.useState<ExtensionPageDescriptor | null>(null)
  const [pendingEnable, setPendingEnable] = React.useState<InstalledExtension | null>(null)
  const [pendingUninstall, setPendingUninstall] = React.useState<string | null>(null)

  const refresh = React.useCallback(async (): Promise<void> => {
    const list = await window.api.listExtensions()
    setExtensions(list)
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
        {!selected ? (
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
                {selected.runtime.lastError && (
                  <p className="extension-runtime-error">{selected.runtime.lastError}</p>
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

              <section className="extension-card">
                <h4>权限</h4>
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
                        <span
                          className={`extension-grant ${selected.grantedPermissions.includes(permission) ? 'is-granted' : ''}`}
                        >
                          {selected.grantedPermissions.includes(permission) ? '已授予' : '未授予'}
                        </span>
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
