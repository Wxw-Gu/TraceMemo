import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../../src/renderer/src/components/ui'
import { ExtensionWorkspace } from '../../src/renderer/src/features/extensions/ExtensionWorkspace'
import type {
  ExtensionSystemHealth,
  InstalledExtension
} from '../../src/shared/extensions/types'

function extension(overrides: Partial<InstalledExtension> = {}): InstalledExtension {
  return {
    id: 'com.example.demo',
    name: '演示扩展',
    version: '1.0.0',
    apiVersion: '1',
    enabled: false,
    installedAt: 1,
    updatedAt: 1,
    compatibility: { compatible: true },
    source: 'directory',
    permissions: ['storage', 'contacts.list'],
    grantedPermissions: ['storage'],
    pendingPermissions: ['contacts.list'],
    runtime: { state: 'inactive', since: 1, restarts: 0 },
    pages: [{ id: 'settings', title: '设置' }],
    automationActions: [],
    filesPresent: true,
    storage: { state: 'ok' },
    ...overrides
  }
}

const healthy: ExtensionSystemHealth = { registry: { state: 'ok' } }

let api: Record<string, ReturnType<typeof vi.fn>>

function setup(list: InstalledExtension[], health: ExtensionSystemHealth = healthy): void {
  api = {
    listExtensions: vi.fn(async () => list),
    getExtensionHealth: vi.fn(async () => health),
    getExtensionLogs: vi.fn(async () => []),
    clearExtensionLogs: vi.fn(async () => ({ success: true })),
    openExtensionDataDir: vi.fn(async () => ({ success: true })),
    onExtensionChanged: vi.fn(() => vi.fn()),
    setExtensionEnabled: vi.fn(async () => ({ success: true })),
    grantExtensionPermissions: vi.fn(async () => ({ success: true })),
    resetExtensionStorage: vi.fn(async () => ({ success: true })),
    uninstallExtension: vi.fn(async () => ({ success: true })),
    getExtensionPageUrl: vi.fn(),
    pickExtensionDirectory: vi.fn(),
    pickExtensionPackage: vi.fn(),
    installExtensionFromDirectory: vi.fn(),
    installExtensionFromPackage: vi.fn(),
    extensionPageRequest: vi.fn(),
    listExtensionTemplates: vi.fn(async () => []),
    installExtensionTemplate: vi.fn(async () => ({ success: true })),
    acknowledgeExtensionRecovery: vi.fn(async () => ({ success: true })),
    acknowledgeExtensionStorage: vi.fn(async () => ({ success: true })),
    adoptExtensionCode: vi.fn(async () => ({ success: true })),
    rollbackExtensionUpgrade: vi.fn(async () => ({ success: true }))
  }
  Object.defineProperty(window, 'api', { configurable: true, value: api })
}

function renderWorkspace(): void {
  render(
    <ToastProvider>
      <ExtensionWorkspace />
    </ToastProvider>
  )
}

describe('扩展中心状态提示', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('状态文件从扫描重建时显示提示条', async () => {
    setup([extension()], {
      registry: {
        state: 'recovered-by-scan',
        message: '扩展状态文件与备份均不可用，已按磁盘目录重建为未启用状态'
      }
    })
    renderWorkspace()

    await waitFor(() => {
      expect(
        screen.getByText(/扩展状态文件与备份均不可用，已按磁盘目录重建/)
      ).toBeTruthy()
    })
  })

  it('状态文件无法恢复时提示保留现场', async () => {
    setup([extension()], { registry: { state: 'unreadable' } })
    renderWorkspace()

    await waitFor(() => {
      expect(screen.getByText(/已停止写入以保留现场/)).toBeTruthy()
    })
  })

  it('正常状态不显示提示条', async () => {
    setup([extension()])
    renderWorkspace()

    await waitFor(() => {
      // 列表项与详情标题都会出现扩展名。
      expect(screen.getAllByText('演示扩展').length).toBeGreaterThan(0)
    })
    expect(screen.queryByText(/保留现场/)).toBeNull()
    expect(screen.queryByText(/已按磁盘目录重建/)).toBeNull()
  })

  it('配置损坏且无法恢复时显示重置入口', async () => {
    setup([
      extension({
        storage: {
          state: 'unrecovered',
          message: '扩展配置损坏且没有可用备份；写入已停止以保留现场'
        }
      })
    ])
    renderWorkspace()

    await waitFor(() => {
      expect(screen.getByText(/扩展配置损坏且没有可用备份/)).toBeTruthy()
    })
    expect(screen.getByRole('button', { name: '重置配置' })).toBeTruthy()
  })

  it('存在待授权权限时显示授权入口', async () => {
    setup([extension()])
    renderWorkspace()

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '授权新增权限' })).toBeTruthy()
    })
    expect(screen.getByText(/新版本申请了 1 项尚未授予的权限/)).toBeTruthy()
    // M4：未授权项给出「授权」按钮（逐项授权），不再是纯文本标签。
    expect(screen.getAllByRole('button', { name: '授权' }).length).toBeGreaterThan(0)
  })

  it('只有页面入口的扩展显示说明而不是运行中', async () => {
    setup([
      extension({
        enabled: true,
        runtime: {
          state: 'inactive',
          since: 1,
          restarts: 0,
          note: '仅提供页面，没有后台任务'
        }
      })
    ])
    renderWorkspace()

    await waitFor(() => {
      expect(screen.getByText('仅提供页面，没有后台任务')).toBeTruthy()
    })
  })
})
