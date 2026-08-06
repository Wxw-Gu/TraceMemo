export const DEFAULT_VOICE_MODEL_ID = 'sensevoice-small-int8'

export interface VoiceMessageReference {
  sessionId: string
  localId: number
  createTime: number
  svrId?: string | number
}

export type VoiceRecognitionPriority = 'interactive' | 'background'

export type VoiceTranscriptState = 'pending' | 'transcribed' | 'failed'

export interface VoiceTranscriptUpdate {
  accountIdentity: string
  reference: VoiceMessageReference
  messageIdentity: string
  state: Exclude<VoiceTranscriptState, 'pending'>
  transcript?: string
  error?: string
  cached: boolean
}

export interface VoiceTranscriptSnapshot {
  state: VoiceTranscriptState
  transcript?: string
  error?: string
  updatedAt?: number
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

export type VoiceBatchRange = 'recent_30_days' | 'current_year' | 'selected_history'

export interface VoiceBatchRequest {
  conversationIds: string[]
  range: VoiceBatchRange
}

export interface VoiceBatchPreflight {
  accountIdentity: string
  conversationCount: number
  voiceMessageCount: number
  cachedCount: number
  pendingCount: number
  failedCount: number
  estimatedDurationMs: number | null
  modelReady: boolean
}

/**
 * Lightweight per-conversation counts for the batch-selection UI. Unlike a
 * preflight this deliberately does not enumerate every voice message.
 */
export interface VoiceBatchConversationSummary {
  conversationId: string
  voiceMessageCount: number | null
}

export type VoiceBatchState =
  | 'idle'
  | 'pending'
  | 'processing'
  | 'completed'
  | 'partially_failed'
  | 'cancelled'

export interface VoiceBatchProgress {
  accountIdentity: string
  state: VoiceBatchState
  total: number
  processed: number
  cached: number
  succeeded: number
  failed: number
  currentConversationId?: string
  currentMessageIdentity?: string
  elapsedMs: number
  estimatedRemainingMs: number | null
}

export interface VoiceModelProgressEvent extends VoiceModelStatus {}
