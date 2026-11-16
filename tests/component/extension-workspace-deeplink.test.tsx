import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../../src/renderer/src/components/ui'
import { ExtensionWorkspace } from '../../src/renderer/src/features/extensions/ExtensionWorkspace'
import type { ExtensionSystemHealth, InstalledExtension } from '../../src/shared/extensions/types'
import type { ExtensionTemplateStatus } from '../../src/shared/extensions/templates'
import type { ExtensionDeepLink } from '../../src/shared/extensions/types'

const templateStatus: ExtensionTemplateStatus = {
  template: {
    templateId: 'keyword-bot',
    extensionId: 'com.example.keyword-bot',
    name: '关键词回复机器人',
    version: '1.0.1',
    description: '命中关键词后回复',
    permissions: ['storage'],
    file: 'keyword-bot-1.0.1.zip',
    sha256: 'a'.repeat(64),
    bytes: 100,
    fileCount: 7,
    platforms: ['darwin', 'win32'],
    requires: {}
  },
  state: 'not-installed',
  dependencies: { ready: true, checks: [] }
}

function extension(overrides: Partial<InstalledExtension> = {}): InstalledExtension {
  return {
    id: 'com.example.keyword-bot',
    name: '关键词回复机器人',
    version: '1.0.1',
    apiVersion: '1',
    enabled: true,
    installedAt: 1,
    updatedAt: 1,
    compatibility: { compatible: true },
    source: 'template',
    template: { id: 'keyword-bot', version: '1.0.1' },
    permissions: ['storage'],
    grantedPermissions: ['storage'],
    pendingPermissions: [],
    runtime: { state: 'active', since: 1, restarts: 0 },
    pages: [{ id: 'settings', title: '配置' }],
    automationActions: [],
    filesPresent: true,
    storage: { state: 'ok' },
    ...overrides
  }
}

const healthy: ExtensionSystemHealth = { registry: { state: 'ok' } }

function setup(list: InstalledExtension[]): void {
  const api = {
    listExtensions: vi.fn(async () => list),
    getExtensionHealth: vi.fn(async () => healthy),
    listExtensionTemplates: vi.fn(async () => [templateStatus]),
    getExtensionLogs: vi.fn(async () => []),
    onExtensionChanged: vi.fn(() => vi.fn()),
    clearExtensionLogs: vi.fn(async () => ({ success: true })),
    openExtensionDataDir: vi.fn(async () => ({ success: true })),
    setExtensionEnabled: vi.fn(async () => ({ success: true })),
    grantExtensionPermissions: vi.fn(async () => ({ success: true })),
    revokeExtensionPermission: vi.fn(async () => ({ success: true })),
    resetExtensionStorage: vi.fn(async () => ({ success: true })),
    uninstallExtension: vi.fn(async () => ({ success: true })),
    getExtensionPageUrl: vi.fn(),
    pickExtensionDirectory: vi.fn(),
    pickExtensionPackage: vi.fn(),
    installExtensionFromDirectory: vi.fn(),
    installExtensionFromPackage: vi.fn(),
    installExtensionTemplate: vi.fn(),
    extensionPageRequest: vi.fn(),
    acknowledgeExtensionRecovery: vi.fn(),
    acknowledgeExtensionStorage: vi.fn(),
    adoptExtensionCode: vi.fn(),
    rollbackExtensionUpgrade: vi.fn(),
    listExtensionActions: vi.fn(async () => []),
    pickExtensionProjectDirectory: vi.fn(),
    linkExtensionDevelopment: vi.fn(),
    reloadExtensionDevelopment: vi.fn(),
    unlinkExtensionDevelopment: vi.fn(),
    convertExtensionDevelopment: vi.fn(),
    createExtensionProject: vi.fn(),
    exportExtensionAsProject: vi.fn(),
    openExtensionDevelopmentSource: vi.fn()
  }
  Object.defineProperty(window, 'api', { configurable: true, value: api })
}

function renderWorkspace(props: {
  deepLink?: ExtensionDeepLink | null
  onConsumeDeepLink?: () => void
}): void {
  render(
    <ToastProvider>
      <ExtensionWorkspace {...props} />
    </ToastProvider>
  )
}

describe('扩展中心深链', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('模板深链进入官方模板视图并展开该模板', async () => {
    setup([])
    const onConsume = vi.fn()
    renderWorkspace({ deepLink: { templateId: 'keyword-bot' }, onConsumeDeepLink: onConsume })

    await waitFor(() => {
      expect(screen.getByText('关键词回复机器人')).toBeTruthy()
    })
    // 展开态会显示「收起详情」，说明定位生效。
    expect(screen.getByRole('button', { name: '收起详情' })).toBeTruthy()
    expect(onConsume).toHaveBeenCalled()
  })

  it('扩展深链选中对应扩展详情', async () => {
    setup([extension()])
    renderWorkspace({ deepLink: { extensionId: 'com.example.keyword-bot' } })

    await waitFor(() => {
      expect(screen.getByText('com.example.keyword-bot')).toBeTruthy()
    })
  })

  it('开发引导深链显示三步与文档路径', async () => {
    setup([])
    renderWorkspace({ deepLink: { development: true } })

    await waitFor(() => {
      expect(screen.getByText('克隆与改造成自己的扩展')).toBeTruthy()
    })
    expect(screen.getByText('docs/extensions/clone-and-customize.md')).toBeTruthy()
    expect(screen.getByRole('button', { name: '从模板创建项目' })).toBeTruthy()
    // 侧栏与引导面板各有一个「链接本地项目」。
    expect(screen.getAllByRole('button', { name: '链接本地项目' }).length).toBeGreaterThanOrEqual(2)
  })

  it('没有深链时保持默认视图', async () => {
    setup([extension()])
    const onConsume = vi.fn()
    renderWorkspace({ deepLink: null, onConsumeDeepLink: onConsume })

    await waitFor(() => {
      // 侧栏列表与详情标题都会出现扩展名。
      expect(screen.getAllByText('关键词回复机器人').length).toBeGreaterThan(0)
    })
    expect(onConsume).not.toHaveBeenCalled()
  })
})
