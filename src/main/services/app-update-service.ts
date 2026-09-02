import { app, BrowserWindow, shell } from 'electron'
import { autoUpdater, type ProgressInfo } from 'electron-updater'
import type {
  AppUpdateCheckResult,
  AppUpdateCheckSource,
  AppUpdateDelivery,
  AppUpdateInstallResult,
  AppUpdateOpenDownloadPageResult,
  AppUpdateState
} from '../../shared/app-update'
import { APP_UPDATE_RELEASES_URL } from '../../shared/app-update'
import { isPackagedRuntime } from '../runtime-mode'

const SIMULATION_VERSION = '2.0.0'
const SIMULATION_TOTAL_BYTES = 60 * 1024 * 1024
const SIMULATION_PROGRESS = [0, 5, 12, 21, 33, 46, 58, 69, 78, 86, 93, 97, 100]
const DEFAULT_SIMULATION_DURATION_MS = 8_000
const STARTUP_CHECK_DELAY_MS = 1_500
// Enable only after macOS packages use Developer ID Application signing and notarization.
const MAC_AUTO_UPDATE_ENABLED = false

interface AppUpdateServiceOptions {
  currentVersion?: () => string
  packagedRuntime?: () => boolean
  simulationEnabled?: boolean
  simulationDurationMs?: number
  platform?: NodeJS.Platform
  macAutoUpdateEnabled?: boolean
  broadcast?: (state: AppUpdateState) => void
}

export class AppUpdateService {
  private readonly currentVersion: () => string
  private readonly packagedRuntime: () => boolean
  private readonly simulationEnabled: boolean
  private readonly simulationDurationMs: number
  private readonly delivery: AppUpdateDelivery
  private readonly broadcast?: (state: AppUpdateState) => void
  private state: AppUpdateState
  private listeners = new Set<(state: AppUpdateState) => void>()
  private activeCheckSource: AppUpdateCheckSource = 'manual'
  private startupCheckScheduled = false
  private checkInFlight?: Promise<AppUpdateCheckResult>
  private downloadInFlight?: Promise<AppUpdateCheckResult>

  constructor(options: AppUpdateServiceOptions = {}) {
    this.currentVersion = options.currentVersion || (() => app.getVersion())
    this.packagedRuntime = options.packagedRuntime || isPackagedRuntime
    this.simulationEnabled =
      options.simulationEnabled ??
      (!app.isPackaged && process.env['TRACEMEMO_UPDATE_SIMULATION'] === 'true')
    const configuredDuration = Number(
      options.simulationDurationMs ?? process.env['TRACEMEMO_UPDATE_SIMULATION_DURATION_MS']
    )
    this.simulationDurationMs = Number.isFinite(configuredDuration)
      ? Math.max(1_000, configuredDuration)
      : DEFAULT_SIMULATION_DURATION_MS
    const platform = options.platform || process.platform
    const macAutoUpdateEnabled = options.macAutoUpdateEnabled ?? MAC_AUTO_UPDATE_ENABLED
    this.delivery =
      !this.simulationEnabled && platform === 'darwin' && !macAutoUpdateEnabled
        ? 'release-page'
        : 'automatic'
    this.broadcast = options.broadcast
    this.state = {
      status: 'idle',
      currentVersion: this.currentVersion(),
      delivery: this.delivery,
      isSimulation: this.simulationEnabled
    }

    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = this.delivery === 'automatic'
    autoUpdater.on('checking-for-update', () =>
      this.setState({
        status: 'checking',
        source: this.activeCheckSource,
        message: '正在检查更新',
        version: undefined,
        percent: undefined,
        transferred: undefined,
        total: undefined,
        bytesPerSecond: undefined,
        error: undefined
      })
    )
    autoUpdater.on('update-available', (info) =>
      this.setState({
        status: 'available',
        source: this.activeCheckSource,
        version: info.version,
        message: '发现新版本',
        error: undefined
      })
    )
    autoUpdater.on('update-not-available', () =>
      this.setState({
        status: 'up-to-date',
        source: this.activeCheckSource,
        message: '已是最新版本',
        error: undefined
      })
    )
    autoUpdater.on('download-progress', (progress: ProgressInfo) => {
      if (this.delivery !== 'automatic') return
      this.setState({
        status: 'downloading',
        percent: progress.percent,
        transferred: progress.transferred,
        total: progress.total,
        bytesPerSecond: progress.bytesPerSecond
      })
    })
    autoUpdater.on('update-downloaded', (info) => {
      if (this.delivery !== 'automatic') return
      this.setState({
        status: 'downloaded',
        version: info.version || this.state.version,
        percent: 100,
        transferred: this.state.total,
        message: '更新已下载'
      })
    })
    autoUpdater.on('error', (error) =>
      this.setState({
        status: 'error',
        message: '检查更新失败',
        error: error.message || '更新失败'
      })
    )
  }

  getState(): AppUpdateState {
    return { ...this.state, currentVersion: this.currentVersion() }
  }

  scheduleStartupCheck(delayMs = STARTUP_CHECK_DELAY_MS): void {
    if (this.startupCheckScheduled) return
    if (!this.simulationEnabled && !this.packagedRuntime()) return
    this.startupCheckScheduled = true
    setTimeout(() => void this.check('startup'), Math.max(0, delayMs))
  }

  check(source: AppUpdateCheckSource = 'manual'): Promise<AppUpdateCheckResult> {
    if (this.checkInFlight) return this.checkInFlight
    this.checkInFlight = this.runCheck(source).finally(() => {
      this.checkInFlight = undefined
    })
    return this.checkInFlight
  }

  private async runCheck(source: AppUpdateCheckSource): Promise<AppUpdateCheckResult> {
    this.activeCheckSource = source
    if (this.simulationEnabled) {
      this.setState({
        status: 'checking',
        source,
        isSimulation: true,
        message: '正在检查模拟更新',
        version: undefined,
        percent: undefined,
        transferred: undefined,
        total: undefined,
        bytesPerSecond: undefined,
        error: undefined
      })
      await this.delay(350)
      const state = this.setState({
        status: 'available',
        source,
        version: SIMULATION_VERSION,
        message: '发现模拟更新',
        error: undefined
      })
      return { success: true, state }
    }

    if (!this.packagedRuntime()) {
      const state = this.setState({
        status: 'unsupported',
        source,
        message: '开发模式不执行安装包更新，请在正式安装包中检查更新',
        error: undefined
      })
      return { success: false, state }
    }
    try {
      await autoUpdater.checkForUpdates()
      return { success: true, state: this.getState() }
    } catch (error) {
      const state = this.setState({
        status: 'error',
        message: '检查更新失败',
        error: error instanceof Error ? error.message : String(error)
      })
      return { success: false, state }
    }
  }

  download(): Promise<AppUpdateCheckResult> {
    if (this.downloadInFlight) return this.downloadInFlight
    this.downloadInFlight = this.runDownload().finally(() => {
      this.downloadInFlight = undefined
    })
    return this.downloadInFlight
  }

  private async runDownload(): Promise<AppUpdateCheckResult> {
    if (this.simulationEnabled) return this.simulateDownload()

    if (this.delivery === 'release-page') {
      const state = this.setState({
        status: 'available',
        message: '有新版本可用，前往 GitHub 下载最新版本。'
      })
      return { success: false, state }
    }

    if (!this.packagedRuntime()) {
      const state = this.setState({
        status: 'unsupported',
        message: '开发模式不能下载更新',
        error: undefined
      })
      return { success: false, state }
    }
    try {
      this.setState({ status: 'downloading', percent: 0, error: undefined })
      await autoUpdater.downloadUpdate()
      return { success: true, state: this.getState() }
    } catch (error) {
      const state = this.setState({
        status: 'error',
        message: '下载更新失败',
        error: error instanceof Error ? error.message : String(error)
      })
      return { success: false, state }
    }
  }

  install(): AppUpdateInstallResult {
    if (this.delivery !== 'automatic') {
      return { success: false, error: '当前 macOS 版本不支持自动安装，请前往 GitHub 下载更新。' }
    }
    if (this.state.status !== 'downloaded') {
      return { success: false, error: '更新包尚未下载完成' }
    }
    if (this.simulationEnabled) {
      const message = '开发模拟模式：更新安装动作已模拟，未实际退出应用。'
      this.setState({ status: 'downloaded', message })
      return { success: true, simulated: true, message }
    }
    this.setState({ status: 'installing', message: '正在重启并安装更新' })
    autoUpdater.quitAndInstall()
    return { success: true }
  }

  async openDownloadPage(): Promise<AppUpdateOpenDownloadPageResult> {
    try {
      await shell.openExternal(APP_UPDATE_RELEASES_URL)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  handleState(callback: (state: AppUpdateState) => void): () => void {
    this.listeners.add(callback)
    callback(this.getState())
    return () => this.listeners.delete(callback)
  }

  private setState(patch: Partial<AppUpdateState>): AppUpdateState {
    this.state = { ...this.state, ...patch, currentVersion: this.currentVersion() }
    const state = this.getState()
    if (this.broadcast) {
      this.broadcast(state)
    } else {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send('app-update:state', state)
      }
    }
    for (const listener of this.listeners) listener(state)
    return state
  }

  private async simulateDownload(): Promise<AppUpdateCheckResult> {
    const stepDuration = this.simulationDurationMs / (SIMULATION_PROGRESS.length - 1)
    let previousTransferred = 0
    this.setState({
      status: 'downloading',
      version: SIMULATION_VERSION,
      percent: 0,
      transferred: 0,
      total: SIMULATION_TOTAL_BYTES,
      bytesPerSecond: 0,
      message: '正在下载模拟更新'
    })

    for (const percent of SIMULATION_PROGRESS.slice(1)) {
      await this.delay(stepDuration)
      const transferred = Math.round((SIMULATION_TOTAL_BYTES * percent) / 100)
      const bytesPerSecond = Math.round(((transferred - previousTransferred) * 1000) / stepDuration)
      previousTransferred = transferred
      this.setState({
        status: 'downloading',
        percent,
        transferred,
        total: SIMULATION_TOTAL_BYTES,
        bytesPerSecond
      })
    }

    const state = this.setState({
      status: 'downloaded',
      version: SIMULATION_VERSION,
      percent: 100,
      transferred: SIMULATION_TOTAL_BYTES,
      total: SIMULATION_TOTAL_BYTES,
      bytesPerSecond: undefined,
      message: '模拟更新已下载'
    })
    return { success: true, state }
  }

  private delay(durationMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, durationMs))
  }
}

export const appUpdateService = new AppUpdateService()
