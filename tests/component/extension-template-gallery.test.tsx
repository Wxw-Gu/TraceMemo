import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../../src/renderer/src/components/ui'
import { ExtensionTemplateGallery } from '../../src/renderer/src/features/extensions/ExtensionTemplateGallery'
import type { ExtensionTemplateStatus } from '../../src/shared/extensions/templates'

function template(overrides: Partial<ExtensionTemplateStatus> = {}): ExtensionTemplateStatus {
  return {
    template: {
      templateId: 'keyword-bot',
      extensionId: 'com.example.keyword-bot',
      name: '关键词回复机器人',
      version: '1.0.0',
      description: '命中关键词后经 Gateway 回复',
      permissions: ['storage', 'wechat.send.text'],
      file: 'keyword-bot-1.0.0.zip',
      sha256: 'a'.repeat(64),
      bytes: 19121,
      fileCount: 7,
      platforms: ['darwin', 'win32'],
      requires: { python: false, chrome: false, externalScript: false }
    },
    state: 'not-installed',
    dependencies: { ready: true, checks: [] },
    ...overrides
  }
}

function renderGallery(
  templates: ExtensionTemplateStatus[],
  handlers: { onInstall?: (id: string) => void; busyId?: string | null } = {}
): void {
  render(
    <ToastProvider>
      <ExtensionTemplateGallery
        templates={templates}
        loading={false}
        busyId={handlers.busyId ?? null}
        onInstall={handlers.onInstall ?? (() => undefined)}
      />
    </ToastProvider>
  )
}

describe('官方模板画廊', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('展示模板名称、版本与安装按钮', () => {
    renderGallery([template()])
    expect(screen.getByText('关键词回复机器人')).toBeTruthy()
    expect(screen.getByText('v1.0.0')).toBeTruthy()
    expect(screen.getByRole('button', { name: '安装' })).toBeTruthy()
  })

  it('点击安装把模板 id 交给上层', async () => {
    const onInstall = vi.fn()
    const user = userEvent.setup()
    renderGallery([template()], { onInstall })
    await user.click(screen.getByRole('button', { name: '安装' }))
    expect(onInstall).toHaveBeenCalledWith('keyword-bot')
  })

  it('有更新时显示「更新」按钮', () => {
    renderGallery([template({ state: 'update-available', installedVersion: '0.9.0' })])
    expect(screen.getByRole('button', { name: '更新' })).toBeTruthy()
    expect(screen.getByText('有更新')).toBeTruthy()
  })

  it('已安装同版本时按钮不可用', () => {
    renderGallery([template({ state: 'installed', installedVersion: '1.0.0' })])
    const button = screen.getByRole('button', { name: '安装' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
  })

  it('同 ID 冲突时说明不会自动替换', () => {
    renderGallery([
      template({
        state: 'conflict',
        message: '已安装同 ID 的非官方扩展，不会自动替换'
      })
    ])
    expect(screen.getByText(/不会自动替换/)).toBeTruthy()
    const button = screen.getByRole('button', { name: '安装' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
  })

  it('缺少关键依赖时明确提示主要功能不可用', () => {
    renderGallery([
      template({
        template: {
          ...template().template,
          templateId: 'douyin-sender',
          extensionId: 'com.example.douyin-sender',
          name: '抖音视频处理',
          requires: { python: { required: true }, chrome: { required: true } }
        },
        state: 'not-installed',
        dependencies: {
          ready: false,
          checks: [
            { id: 'python', label: 'Python', ok: false, blocking: true, detail: '未找到' },
            { id: 'chrome', label: 'Chrome', ok: false, blocking: true, detail: '未找到' }
          ]
        }
      })
    ])
    expect(screen.getByText(/缺少 Python、Chrome/)).toBeTruthy()
    expect(screen.getByText(/主要功能暂时不可用/)).toBeTruthy()
  })

  it('查看详情展开权限与依赖', async () => {
    const user = userEvent.setup()
    renderGallery([
      template({
        dependencies: {
          ready: true,
          checks: [{ id: 'python', label: 'Python', ok: true, blocking: true, detail: '已找到' }]
        }
      })
    ])
    await user.click(screen.getByRole('button', { name: '查看详情' }))
    expect(screen.getByText('发送微信文本')).toBeTruthy()
    expect(screen.getByText('已找到')).toBeTruthy()
  })

  it('资源损坏时提示重新安装且禁用安装按钮', () => {
    renderGallery([
      template({ state: 'damaged', message: '模板资源缺失或校验失败，请重新安装 TraceMemo' })
    ])
    expect(screen.getByText(/校验失败/)).toBeTruthy()
    const button = screen.getByRole('button', { name: '安装' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
  })

  it('没有模板资源时说明原因', () => {
    render(
      <ToastProvider>
        <ExtensionTemplateGallery
          templates={[]}
          loading={false}
          busyId={null}
          onInstall={() => undefined}
        />
      </ToastProvider>
    )
    expect(screen.getByText(/没有携带模板资源/)).toBeTruthy()
  })
})
