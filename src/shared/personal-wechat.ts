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

export interface PersonalWechatImageSelectionResult {
  canceled: boolean
  path?: string
  name?: string
}

export type PersonalWechatVoiceSelectionResult = PersonalWechatImageSelectionResult
