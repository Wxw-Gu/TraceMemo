import { app, BrowserWindow } from 'electron'
import { autoUpdater, type ProgressInfo } from 'electron-updater'
import type { AppUpdateCheckResult, AppUpdateState } from '../../shared/app-update'
import { isPackagedRuntime } from '../runtime-mode'

export class AppUpdateService {
  private state: AppUpdateState = {
    status: 'idle',
    currentVersion: app.getVersion()
  }

  constructor() {
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('checking-for-update', () => this.setState({ status: 'checking' }))
    autoUpdater.on('update-available', (info) =>
      this.setState({ status: 'available', version: info.version, message: '发现新版本' })
    )
    autoUpdater.on('update-not-available', () =>
      this.setState({ status: 'not-available', message: '当前已是最新版本' })
    )
    autoUpdater.on('download-progress', (progress: ProgressInfo) =>
      this.setState({
        status: 'downloading',
        percent: progress.percent,
        transferred: progress.transferred,
        total: progress.total,
        bytesPerSecond: progress.bytesPerSecond
      })
    )
    autoUpdater.on('update-downloaded', (info) =>
      this.setState({
        status: 'downloaded',
        version: info.version,
        percent: 100,
        message: '更新已下载'
      })
    )
    autoUpdater.on('error', (error) =>
      this.setState({ status: 'error', message: error.message || '更新失败' })
    )
  }

  getState(): AppUpdateState {
    return { ...this.state, currentVersion: app.getVersion() }
  }

  async check(): Promise<AppUpdateCheckResult> {
    if (!isPackagedRuntime()) {
      const state = this.setState({
        status: 'unsupported',
        message: '开发模式不执行安装包更新，请在正式安装包中检查更新'
      })
      return { success: false, state }
    }
    try {
      const result = await autoUpdater.checkForUpdates()
      if (result?.updateInfo.version) {
        this.setState({
          status: 'available',
          version: result.updateInfo.version,
          message: '发现新版本'
        })
      }
      return { success: true, state: this.getState() }
    } catch (error) {
      const state = this.setState({
        status: 'error',
        message: error instanceof Error ? error.message : String(error)
      })
      return { success: false, state }
    }
  }

  async download(): Promise<AppUpdateCheckResult> {
    if (!isPackagedRuntime()) {
      const state = this.setState({ status: 'unsupported', message: '开发模式不能下载更新' })
      return { success: false, state }
    }
    try {
      this.setState({ status: 'downloading', percent: 0 })
      await autoUpdater.downloadUpdate()
      return { success: true, state: this.getState() }
    } catch (error) {
      const state = this.setState({
        status: 'error',
        message: error instanceof Error ? error.message : String(error)
      })
      return { success: false, state }
    }
  }

  install(): { success: boolean; error?: string } {
    if (this.state.status !== 'downloaded') {
      return { success: false, error: '更新包尚未下载完成' }
    }
    autoUpdater.quitAndInstall()
    return { success: true }
  }

  handleState(callback: (state: AppUpdateState) => void): () => void {
    this.listeners.add(callback)
    callback(this.getState())
    return () => this.listeners.delete(callback)
  }

  private listeners = new Set<(state: AppUpdateState) => void>()

  private setState(patch: Partial<AppUpdateState>): AppUpdateState {
    this.state = { ...this.state, ...patch, currentVersion: app.getVersion() }
    const state = this.getState()
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('app-update:state', state)
    }
    for (const listener of this.listeners) listener(state)
    return state
  }
}

export const appUpdateService = new AppUpdateService()
