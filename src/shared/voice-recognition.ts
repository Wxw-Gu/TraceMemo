export const DEFAULT_VOICE_MODEL_ID = 'sensevoice-small-int8'

export interface VoiceMessageReference {
  sessionId: string
  localId: number
  createTime: number
  svrId?: string | number
}

export type VoiceModelState =
  | 'missing'
  | 'downloading'
  | 'ready'
  | 'invalid'
  | 'error'
  | 'unsupported'

export interface VoiceModelStatus {
  modelId: string
  version: string
  state: VoiceModelState
  downloadedBytes: number
  totalBytes: number
  progress: number
  platform: NodeJS.Platform
  architecture: string
  supported: boolean
  error?: string
}

export interface VoiceModelDownloadResult {
  success: boolean
  status: VoiceModelStatus
  error?: string
}

export type VoiceRecognitionErrorCode =
  | 'NOT_CONNECTED'
  | 'MODEL_NOT_READY'
  | 'VOICE_NOT_FOUND'
  | 'DECODE_FAILED'
  | 'EMPTY_AUDIO'
  | 'CANCELLED'
  | 'TIMEOUT'
  | 'WORKER_FAILED'
  | 'RECOGNITION_FAILED'

export interface VoiceRecognitionResult {
  success: boolean
  transcript?: string
  language?: string
  durationMs?: number
  cached?: boolean
  error?: string
  code?: VoiceRecognitionErrorCode
}

export interface VoiceModelProgressEvent extends VoiceModelStatus {}
