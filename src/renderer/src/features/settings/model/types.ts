export type SettingsCategoryId =
  | 'account-database'
  | 'database-key'
  | 'image-key'
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
