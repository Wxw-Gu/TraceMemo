import { beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_UPDATE_RELEASES_URL } from '../../src/shared/app-update'

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  return {
    listeners,
    updater: {
      autoDownload: true,
      autoInstallOnAppQuit: false,
      checkForUpdates: vi.fn(),
      downloadUpdate: vi.fn(),
      quitAndInstall: vi.fn(),
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        const eventListeners = listeners.get(event) || new Set()
        eventListeners.add(listener)
        listeners.set(event, eventListeners)
      })
    },
    shell: {
      openExternal: vi.fn()
    },
    emit(event: string, ...args: unknown[]): void {
      for (const listener of listeners.get(event) || []) listener(...args)
    }
  }
})

vi.mock('electron', () => ({
  app: {
    getVersion: () => '1.9.0',
    isPackaged: false
  },
  BrowserWindow: {
    getAllWindows: () => []
  },
  shell: mocks.shell
}))

vi.mock('electron-updater', () => ({ autoUpdater: mocks.updater }))
vi.mock('../../src/main/runtime-mode', () => ({ isPackagedRuntime: () => false }))

import { AppUpdateService } from '../../src/main/services/app-update-service'

describe('AppUpdateService', () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    mocks.listeners.clear()
  })

  it('keeps update-not-available as the final state when checkForUpdates returns metadata', async () => {
    const service = new AppUpdateService({ packagedRuntime: () => true, platform: 'win32' })
    mocks.updater.checkForUpdates.mockImplementationOnce(async () => {
      mocks.emit('checking-for-update')
      mocks.emit('update-not-available', { version: '1.9.0' })
      return { updateInfo: { version: '1.9.0' } }
    })

    const result = await service.check('manual')

    expect(result.success).toBe(true)
    expect(result.state).toMatchObject({
      status: 'up-to-date',
      currentVersion: '1.9.0',
      delivery: 'automatic',
      source: 'manual'
    })
  })

  it('simulates a realistic 2.0.0 download without invoking the real updater', async () => {
    vi.useFakeTimers()
    const states: ReturnType<AppUpdateService['getState']>[] = []
    const service = new AppUpdateService({
      simulationEnabled: true,
      simulationDurationMs: 1_000,
      currentVersion: () => '1.9.0'
    })
    service.handleState((state) => states.push(state))

    const checkPromise = service.check('startup')
    await vi.advanceTimersByTimeAsync(350)
    const checkResult = await checkPromise
    expect(checkResult.state).toMatchObject({
      status: 'available',
      version: '2.0.0',
      source: 'startup',
      isSimulation: true
    })

    const downloadPromise = service.download()
    await vi.advanceTimersByTimeAsync(1_100)
    const downloadResult = await downloadPromise

    expect(downloadResult.state).toMatchObject({
      status: 'downloaded',
      version: '2.0.0',
      percent: 100,
      transferred: 60 * 1024 * 1024,
      total: 60 * 1024 * 1024
    })
    expect(
      states.filter((state) => state.status === 'downloading').map((state) => state.percent)
    ).toEqual([0, 5, 12, 21, 33, 46, 58, 69, 78, 86, 93, 97, 100])
    expect(states.some((state) => (state.bytesPerSecond || 0) > 0)).toBe(true)
    expect(mocks.updater.downloadUpdate).not.toHaveBeenCalled()

    expect(service.install()).toEqual({
      success: true,
      simulated: true,
      message: '开发模拟模式：更新安装动作已模拟，未实际退出应用。'
    })
    expect(mocks.updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('uses release-page delivery on unsigned macOS without downloading or installing', async () => {
    const service = new AppUpdateService({
      platform: 'darwin',
      packagedRuntime: () => true,
      currentVersion: () => '2.2.2',
      macAutoUpdateEnabled: false
    })
    mocks.updater.checkForUpdates.mockImplementationOnce(async () => {
      mocks.emit('checking-for-update')
      mocks.emit('update-available', { version: '2.2.3' })
      return { updateInfo: { version: '2.2.3' } }
    })

    const result = await service.check('manual')
    expect(result.state).toMatchObject({
      status: 'available',
      delivery: 'release-page',
      version: '2.2.3'
    })

    const download = await service.download()
    expect(download.success).toBe(false)
    expect(download.state.status).toBe('available')
    expect(mocks.updater.downloadUpdate).not.toHaveBeenCalled()
    expect(service.install()).toMatchObject({ success: false })
    expect(mocks.updater.quitAndInstall).not.toHaveBeenCalled()

    mocks.shell.openExternal.mockResolvedValue(undefined)
    await expect(service.openDownloadPage()).resolves.toEqual({ success: true })
    expect(mocks.shell.openExternal).toHaveBeenCalledWith(APP_UPDATE_RELEASES_URL)
  })

  it('keeps automatic download and quitAndInstall on Windows', async () => {
    const service = new AppUpdateService({
      platform: 'win32',
      packagedRuntime: () => true,
      currentVersion: () => '2.2.2'
    })
    mocks.updater.checkForUpdates.mockImplementationOnce(async () => {
      mocks.emit('checking-for-update')
      mocks.emit('update-available', { version: '2.2.3' })
      return { updateInfo: { version: '2.2.3' } }
    })
    mocks.updater.downloadUpdate.mockImplementationOnce(async () => {
      mocks.emit('download-progress', {
        percent: 50,
        transferred: 30,
        total: 60,
        bytesPerSecond: 10
      })
      mocks.emit('update-downloaded', { version: '2.2.3' })
    })

    await service.check('manual')
    const download = await service.download()
    expect(download.state).toMatchObject({
      status: 'downloaded',
      delivery: 'automatic',
      version: '2.2.3',
      percent: 100
    })
    expect(mocks.updater.downloadUpdate).toHaveBeenCalledOnce()

    expect(service.install()).toEqual({ success: true })
    expect(mocks.updater.quitAndInstall).toHaveBeenCalledOnce()
  })
})
