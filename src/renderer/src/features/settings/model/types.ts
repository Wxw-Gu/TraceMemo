export type SettingsCategoryId =
  | 'account-database'
  | 'database-key'
  | 'image-key'
  | 'voice-recognition'
  | 'wechat-send'
  | 'text-to-speech'
  | 'personal-wechat-send'
  | 'ai-model'
  | 'recall-protection'
  | 'local-api'
  | 'storage-export'
  | 'cache-cleanup'
  | 'appearance'
  | 'advanced'
  | 'about'

export interface SettingsSelfInfo {
  wxid: string
  nickname: string
  avatar?: string
  accountRoot: string
}
