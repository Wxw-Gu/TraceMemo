import * as React from 'react'
import {
  EXTENSION_PERMISSION_INFO,
  sortPermissionsByRisk,
  type ExtensionPermission
} from '../../../../shared/extensions/permissions'
import type { ExtensionTemplateStatus } from '../../../../shared/extensions/templates'
import { Button, Spinner } from '../../components/ui'

interface ExtensionTemplateGalleryProps {
  templates: ExtensionTemplateStatus[]
  loading: boolean
  busyId: string | null
  onInstall: (templateId: string) => void
  /** 从该模板生成独立项目；未提供时不显示入口。 */
  onCreateProject?: (templateId: string) => void
  /** 深链定位：自动展开该模板的详情。 */
  focusTemplateId?: string | null
}

const STATE_LABELS: Record<ExtensionTemplateStatus['state'], string> = {
  'not-installed': '未安装',
  installed: '已安装',
  'update-available': '有更新',
  conflict: '已被占用',
  unsupported: '不支持当前平台',
  damaged: '资源损坏'
}

function stateTone(state: ExtensionTemplateStatus['state']): string {
  if (state === 'not-installed' || state === 'installed') return 'muted'
  if (state === 'update-available') return 'warning'
  return 'danger'
}

function formatBytes(bytes: number): string {
  if (!bytes) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 官方模板画廊。
 *
 * 只负责展示与触发安装；是否可安装、装完是什么状态全部来自主进程，
 * 这里不做第二套判断，避免界面和实际能力说两套话。
 */
export function ExtensionTemplateGallery({
  templates,
  loading,
  busyId,
  onInstall,
  onCreateProject,
  focusTemplateId
}: ExtensionTemplateGalleryProps): React.ReactElement {
  const [expanded, setExpanded] = React.useState<string | null>(null)

  // 深链进来时展开目标模板；滚动交给浏览器默认行为即可。
  React.useEffect(() => {
    if (focusTemplateId) setExpanded(focusTemplateId)
  }, [focusTemplateId])

  if (loading) {
    return (
      <div className="extension-template-empty">
        <Spinner />
        <p>正在读取官方模板…</p>
      </div>
    )
  }

  if (templates.length === 0) {
    return (
      <div className="extension-template-empty">
        <h3>官方模板</h3>
        <p>当前安装包没有携带模板资源。如果你是从源码运行，请先执行模板构建脚本。</p>
      </div>
    )
  }

  return (
    <div className="extension-template-gallery">
      <header className="extension-template-header">
        <div>
          <h3>官方模板</h3>
          <p>安装后仍需你确认权限并手动启用，不会自动运行。</p>
        </div>
      </header>

      <ul className="extension-template-list">
        {templates.map((item) => {
          const { template } = item
          const isOpen = expanded === template.templateId
          const canInstall = item.state === 'not-installed' || item.state === 'update-available'
          const blocked =
            item.state === 'conflict' || item.state === 'damaged' || item.state === 'unsupported'
          const missingBlocking = item.dependencies.checks.filter(
            (check) => check.blocking && !check.ok
          )

          return (
            <li key={template.templateId} className="extension-template-card">
              <div className="extension-template-card-head">
                <div>
                  <div className="extension-template-title">
                    <strong>{template.name}</strong>
                    <span className="extension-template-version">v{template.version}</span>
                    <span className={`extension-grant tone-${stateTone(item.state)}`}>
                      {STATE_LABELS[item.state]}
                    </span>
                  </div>
                  <p className="extension-template-desc">
                    {template.description || '官方提供的扩展示例。'}
                  </p>
                  <p className="extension-template-meta">
                    {template.fileCount} 个文件 · {formatBytes(template.bytes)}
                    {item.installedVersion && item.state !== 'not-installed'
                      ? ` · 已安装 v${item.installedVersion}`
                      : ''}
                  </p>
                </div>
                <div className="extension-template-actions">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setExpanded(isOpen ? null : template.templateId)}
                  >
                    {isOpen ? '收起详情' : '查看详情'}
                  </Button>
                  {onCreateProject && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busyId === `create:${template.templateId}`}
                      onClick={() => onCreateProject(template.templateId)}
                    >
                      创建项目
                    </Button>
                  )}
                  <Button
                    size="sm"
                    disabled={!canInstall || busyId === template.templateId}
                    onClick={() => onInstall(template.templateId)}
                  >
                    {busyId === template.templateId
                      ? '安装中…'
                      : item.state === 'update-available'
                        ? '更新'
                        : '安装'}
                  </Button>
                </div>
              </div>

              {item.message && <p className="extension-template-warning">{item.message}</p>}

              {missingBlocking.length > 0 && (
                <p className="extension-template-warning">
                  缺少 {missingBlocking.map((check) => check.label).join('、')}
                  ：安装后可以查看配置页，但主要功能暂时不可用。
                </p>
              )}

              {isOpen && (
                <div className="extension-template-detail">
                  <section>
                    <h4>权限</h4>
                    <ul className="extension-permission-list">
                      {sortPermissionsByRisk(template.permissions).map(
                        (permission: ExtensionPermission) => (
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
                          </li>
                        )
                      )}
                    </ul>
                  </section>

                  <section>
                    <h4>依赖</h4>
                    {item.dependencies.checks.length === 0 ? (
                      <p className="extension-muted">该模板不需要额外依赖。</p>
                    ) : (
                      <ul className="extension-template-deps">
                        {item.dependencies.checks.map((check) => (
                          <li key={check.id}>
                            <span
                              className={`extension-dot ${check.ok ? 'is-ok' : 'is-missing'}`}
                            />
                            <span>{check.label}</span>
                            <span className="extension-muted">{check.detail}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                </div>
              )}

              {item.state === 'conflict' && (
                <p className="extension-muted">
                  你之前用同一扩展 ID 安装过其他来源的扩展。请先卸载它，或改用「安装 ZIP」手动更新。
                </p>
              )}
              {blocked && item.state === 'damaged' && (
                <p className="extension-muted">
                  模板资源与你安装的版本不匹配，建议重新安装 TraceMemo。
                </p>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
