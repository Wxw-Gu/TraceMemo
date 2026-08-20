import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AboutPage } from '../../src/renderer/src/features/settings/pages/AboutPage'
import { AdvancedPage } from '../../src/renderer/src/features/settings/pages/AdvancedPage'
import { RecallProtectionPage } from '../../src/renderer/src/features/settings/pages/RecallProtectionPage'

const api = {
  checkAppUpdate: vi.fn(),
  downloadAppUpdate: vi.fn(),
  getAppUpdateState: vi.fn(),
  getSettings: vi.fn(),
  installAppUpdate: vi.fn(),
  onAppUpdateState: vi.fn(),
  revealAppLog: vi.fn(),
  setSettings: vi.fn()
}

describe('basic settings pages', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(window, 'api', { configurable: true, value: api })
    api.getAppUpdateState.mockResolvedValue({ status: 'idle', currentVersion: '2.2.2' })
    api.onAppUpdateState.mockReturnValue(vi.fn())
    api.checkAppUpdate.mockResolvedValue(undefined)
    api.revealAppLog.mockResolvedValue(undefined)
    api.getSettings.mockResolvedValue({ settings: { debugEnabled: false } })
    api.setSettings.mockResolvedValue({ settings: { debugEnabled: true } })
  })

  it('keeps update and log actions connected to the desktop APIs', async () => {
    const user = userEvent.setup()
    render(<AboutPage onNotice={vi.fn()} />)

    await screen.findByText('v2.2.2')
    await user.click(screen.getByRole('button', { name: '检查更新' }))
    await user.click(screen.getByRole('button', { name: '打开诊断日志目录' }))

    await waitFor(() => expect(api.checkAppUpdate).toHaveBeenCalledOnce())
    expect(api.revealAppLog).toHaveBeenCalledOnce()
  })

  it('uses the shared switch without changing the debug settings contract', async () => {
    const user = userEvent.setup()
    const onNotice = vi.fn()
    render(<AdvancedPage onNotice={onNotice} />)

    const debugSwitch = await screen.findByRole('switch', { name: '显示诊断日志' })
    expect(debugSwitch).not.toBeChecked()
    await user.click(debugSwitch)

    await waitFor(() => expect(api.setSettings).toHaveBeenCalledWith({ debugEnabled: true }))
    expect(debugSwitch).toBeChecked()
    expect(onNotice).toHaveBeenCalledWith('已开启调试日志')
  })

  it('uses the shared switch without changing the recall protection settings contract', async () => {
    api.getSettings.mockResolvedValue({ settings: { recallProtectionEnabled: false } })
    api.setSettings.mockResolvedValue({ settings: { recallProtectionEnabled: true } })
    const user = userEvent.setup()
    const onNotice = vi.fn()
    render(<RecallProtectionPage onNotice={onNotice} />)

    const recallSwitch = await screen.findByRole('switch', { name: '开启防撤回' })
    expect(recallSwitch).not.toBeChecked()
    await user.click(recallSwitch)

    await waitFor(() =>
      expect(api.setSettings).toHaveBeenCalledWith({ recallProtectionEnabled: true })
    )
    expect(recallSwitch).toBeChecked()
    expect(onNotice).toHaveBeenCalledWith('已开启防撤回')
  })
})
