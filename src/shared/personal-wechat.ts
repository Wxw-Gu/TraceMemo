export type PersonalWechatSenderState =
  | 'checking'
  | 'unsupported_platform'
  | 'wechat_not_running'
  | 'sip_enabled'
  | 'unsupported_version'
  | 'runtime_missing'
  | 'hook_not_ready'
  | 'stopped'
  | 'starting'
  | 'rebinding'
  | 'online'
  | 'error'

export interface PersonalWechatSenderStatus {
  state: PersonalWechatSenderState
  platform: string
  arch: string
  sipDisabled: boolean
  wechatRunning: boolean
  wechatPid?: number
  boundWechatPid?: number
  oneBotPid?: number
  endpoint: string
  endpointReady: boolean
  wechatVersion?: string
  runtimeReady: boolean
  executablePath?: string
  configPath?: string
  imagePath?: string
  attachReady: boolean
  baseAddress?: string
  baseAddressReady: boolean
  textHookInstalled: boolean
  textHookReady: boolean
  imageHookInstalled: boolean
  imageHookReady: boolean
  messageListenerReady: boolean
  canSend: boolean
  canSendText: boolean
  canSendImage: boolean
  canSendVoice: boolean
  message: string
  error?: string
}

/** Stable, feature-facing send capability derived from the low-level sender status. */
export type PersonalWechatSendCapabilityState =
  | 'unsupported'
  | 'unconfigured'
  | 'needs_binding'
  | 'needs_verification'
  | 'ready'
  | 'error'

export interface PersonalWechatSendCapability {
  supported: boolean
  ready: boolean
  status: PersonalWechatSendCapabilityState
  capabilities: {
    text: boolean
    image: boolean
    voice: boolean
  }
  senderStatus: PersonalWechatSenderStatus
  message: string
  error?: string
}

interface PersonalWechatSendBaseRequest {
  to: string
  isGroup: boolean
}

export interface PersonalWechatSendTextRequest extends PersonalWechatSendBaseRequest {
  type: 'text'
  text: string
}

export interface PersonalWechatSendImageRequest extends PersonalWechatSendBaseRequest {
  type: 'image'
  filePath: string
}

export interface PersonalWechatSendVoiceRequest extends PersonalWechatSendBaseRequest {
  type: 'voice'
  filePath: string
  /** Internal comparison switch for the temporary voice regression test. */
  voiceSendMode?: 'normalized' | 'legacy'
  fromId?: string
  durationMs?: number
}

export type PersonalWechatSendRequest =
  | PersonalWechatSendTextRequest
  | PersonalWechatSendImageRequest
  | PersonalWechatSendVoiceRequest

export interface PersonalWechatSendResult {
  success: boolean
  status: PersonalWechatSenderStatus
  error?: string
}

/** Safe, user-copyable metadata for the most recent voice send attempt. */
export interface PersonalWechatVoiceDiagnostic {
  request_id: string
  voice_id: string
  phase: 'prepared' | 'completed' | 'failed'
  encoder_name: string
  encoder_version: string
  input_bytes?: number
  normalized_input_bytes?: number
  pcm_size?: number
  sample_rate?: number
  channels?: number
  input_duration_ms?: number
  upload_result?: string
  upload_data_len?: number
  silk_duration_ms?: number
  send_result?: string
  voice_send_mode?: 'normalized' | 'legacy'
  failure_phase?: string
  error?: string
}

export interface PersonalWechatImageSelectionResult {
  canceled: boolean
  path?: string
  name?: string
}

export type PersonalWechatVoiceSelectionResult = PersonalWechatImageSelectionResult
