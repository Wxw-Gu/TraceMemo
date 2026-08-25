export const APP_UPDATE_RELEASES_URL = 'https://github.com/Wxw-Gu/TraceMemo/releases/latest'

export type AppUpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'up-to-date'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error'
  | 'unsupported'

export type AppUpdateCheckSource = 'startup' | 'manual'
export type AppUpdateDelivery = 'automatic' | 'release-page'

export interface AppUpdateState {
  status: AppUpdateStatus
  currentVersion: string
  delivery: AppUpdateDelivery
  version?: string
  percent?: number
  transferred?: number
  total?: number
  bytesPerSecond?: number
  message?: string
  error?: string
  source?: AppUpdateCheckSource
  isSimulation?: boolean
}

export interface AppUpdateCheckResult {
  success: boolean
  state: AppUpdateState
}

export interface AppUpdateInstallResult {
  success: boolean
  simulated?: boolean
  message?: string
  error?: string
}

export interface AppUpdateOpenDownloadPageResult {
  success: boolean
  error?: string
}
