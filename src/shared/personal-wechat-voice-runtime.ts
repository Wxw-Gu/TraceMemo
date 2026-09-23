export const PERSONAL_WECHAT_PILK_VERSION = '0.2.4'

export type PersonalWechatVoiceEncodingEnvironmentState =
  | 'unknown'
  | 'ready'
  | 'incomplete'
  | 'unsupported'
  | 'error'

export interface PersonalWechatVoiceRuntimeComponent {
  ready: boolean
  version?: string
  executable?: string
  path?: string
  error?: string
}

export interface PersonalWechatVoiceEncodingEnvironment {
  state: PersonalWechatVoiceEncodingEnvironmentState
  ready: boolean
  checkedAt?: string
  runtimeReady: boolean
  python: PersonalWechatVoiceRuntimeComponent
  pilk: PersonalWechatVoiceRuntimeComponent
  ffmpeg: PersonalWechatVoiceRuntimeComponent
  encoder: 'pilk' | 'silk' | 'unavailable'
  message: string
}

export interface PersonalWechatVoiceEncodingEnvironmentResult {
  success: boolean
  environment: PersonalWechatVoiceEncodingEnvironment
  error?: string
}
