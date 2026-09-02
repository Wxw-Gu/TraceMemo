export type PersonalWechatRuntimeState =
  | 'missing'
  | 'downloading'
  | 'ready'
  | 'invalid'
  | 'error'
  | 'unsupported'

export interface PersonalWechatRuntimeStatus {
  version: string
  state: PersonalWechatRuntimeState
  downloadedBytes: number
  totalBytes: number
  progress: number
  platform: NodeJS.Platform
  architecture: string
  supported: boolean
  removable: boolean
  directory?: string
  error?: string
}

export interface PersonalWechatRuntimeDownloadResult {
  success: boolean
  status: PersonalWechatRuntimeStatus
  error?: string
}

export interface PersonalWechatRuntimeProgressEvent extends PersonalWechatRuntimeStatus {}
