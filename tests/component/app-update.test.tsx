import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppUpdateState } from '../../src/shared/app-update'
import { AppUpdatePrompt } from '../../src/renderer/src/features/app-update/AppUpdatePrompt'
import { AboutPage } from '../../src/renderer/src/features/settings/pages/AboutPage'

let updateListener: ((state: AppUpdateState) => void) | undefined
const api = {
  checkAppUpdate: vi.fn(),
  downloadAppUpdate: vi.fn(),
  getAppUpdateState: vi.fn(),
  installAppUpdate: vi.fn(),
  openAppUpdateDownloadPage: vi.fn(),
  onAppUpdateState: vi.fn((listener: (state: AppUpdateState) => void) => {
    updateListener = listener
    return vi.fn()
  }),
  revealAppLog: vi.fn()
}

describe('app update UI', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    updateListener = undefined
    Object.defineProperty(window, 'api', { configurable: true, value: api })
  })

  it('prompts once for a startup update and starts the download after navigation', async () => {
    const user = userEvent.setup()
    const state: AppUpdateState = {
      status: 'available',
      currentVersion: '1.9.0',
      delivery: 'automatic',
      version: '2.0.0',
      source: 'startup',
      isSimulation: true
    }
    api.getAppUpdateState.mockResolvedValue(state)
    api.downloadAppUpdate.mockResolvedValue({ success: true, state })
    const onDownloadStart = vi.fn()

    render(<AppUpdatePrompt onDownloadStart={onDownloadStart} onNotice={vi.fn()} />)

    await screen.findByRole('alertdialog', { name: '发现新版本 v2.0.0' })
    await user.click(screen.getByRole('button', { name: '立即下载' }))

    expect(onDownloadStart).toHaveBeenCalledOnce()
    expect(api.downloadAppUpdate).toHaveBeenCalledOnce()
    await waitFor(() =>
      expect(
        screen.queryByRole('alertdialog', { name: '发现新版本 v2.0.0' })
      ).not.toBeInTheDocument()
    )
  })

  it('renders live transfer details and keeps simulated install inside the app', async () => {
    const user = userEvent.setup()
    api.getAppUpdateState.mockResolvedValue({
      status: 'downloading',
      currentVersion: '1.9.0',
      delivery: 'automatic',
      version: '2.0.0',
      percent: 76,
      transferred: 45.6 * 1024 * 1024,
      total: 60 * 1024 * 1024,
      bytesPerSecond: 3.8 * 1024 * 1024,
      isSimulation: true
    })
    api.installAppUpdate.mockResolvedValue({
      success: true,
      simulated: true,
      message: '开发模拟模式：更新安装动作已模拟，未实际退出应用。'
    })
    const onNotice = vi.fn()
    render(<AboutPage onNotice={onNotice} />)

    await screen.findByText('正在下载 v2.0.0')
    expect(screen.getByText('76%')).toBeVisible()
    expect(screen.getByText('45.6 MB / 60.0 MB')).toBeVisible()
    expect(screen.getByText('3.8 MB/s')).toBeVisible()

    act(() => {
      updateListener?.({
        status: 'downloaded',
        currentVersion: '1.9.0',
        delivery: 'automatic',
        version: '2.0.0',
        percent: 100,
        transferred: 60 * 1024 * 1024,
        total: 60 * 1024 * 1024,
        isSimulation: true
      })
    })
    await user.click(screen.getByRole('button', { name: '立即重启更新' }))

    expect(api.installAppUpdate).toHaveBeenCalledOnce()
    expect(onNotice).toHaveBeenCalledWith('开发模拟模式：更新安装动作已模拟，未实际退出应用。')
  })

  it('opens the latest release page instead of downloading in unsigned macOS mode', async () => {
    const user = userEvent.setup()
    const state: AppUpdateState = {
      status: 'available',
      currentVersion: '2.2.2',
      delivery: 'release-page',
      version: '2.2.3',
      source: 'startup'
    }
    api.getAppUpdateState.mockResolvedValue(state)
    api.openAppUpdateDownloadPage.mockResolvedValue({ success: true })
    const onDownloadStart = vi.fn()

    render(<AppUpdatePrompt onDownloadStart={onDownloadStart} onNotice={vi.fn()} />)
    await screen.findByRole('alertdialog', { name: '发现新版本 v2.2.3' })
    await user.click(screen.getByRole('button', { name: '前往下载' }))

    expect(api.openAppUpdateDownloadPage).toHaveBeenCalledOnce()
    expect(api.downloadAppUpdate).not.toHaveBeenCalled()
    expect(onDownloadStart).not.toHaveBeenCalled()
  })

  it('shows a release-page action in About without progress UI', async () => {
    const user = userEvent.setup()
    api.getAppUpdateState.mockResolvedValue({
      status: 'available',
      currentVersion: '2.2.2',
      delivery: 'release-page',
      version: '2.2.3'
    })
    api.openAppUpdateDownloadPage.mockResolvedValue({ success: true })
    render(<AboutPage onNotice={vi.fn()} />)

    await screen.findByText('发现新版本 v2.2.3')
    expect(screen.getByText('当前版本：v2.2.2')).toBeVisible()
    expect(screen.getByText('最新版本：v2.2.3')).toBeVisible()
    expect(screen.getByRole('button', { name: '前往下载' })).toBeVisible()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '前往下载' }))
    expect(api.openAppUpdateDownloadPage).toHaveBeenCalledOnce()
    expect(api.downloadAppUpdate).not.toHaveBeenCalled()
  })

  it.each([
    ['up-to-date', '已是最新版本', '检查更新'],
    ['error', '检查更新失败', '重试']
  ] as const)('renders the %s manual-check result', async (status, message, action) => {
    api.getAppUpdateState.mockResolvedValue({
      status,
      currentVersion: '2.2.2',
      delivery: 'release-page',
      message
    })
    render(<AboutPage onNotice={vi.fn()} />)

    await screen.findByText(message)
    expect(screen.getByRole('button', { name: action })).toBeVisible()
  })
})
