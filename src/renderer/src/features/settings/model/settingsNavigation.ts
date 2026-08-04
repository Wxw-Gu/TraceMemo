import type { SettingsCategoryId } from './types'

export interface SettingsNavigationGroup {
  label: string
  items: { id: SettingsCategoryId; label: string }[]
}

export const SETTINGS_NAVIGATION: SettingsNavigationGroup[] = [
  {
    label: '连接',
    items: [
      { id: 'account-database', label: '账号与数据库' },
      { id: 'database-key', label: '数据库密钥' },
      { id: 'image-key', label: '图片解密' }
    ]
  },
  {
    label: '智能能力',
    items: [
      { id: 'voice-recognition', label: '语音转文字' },
      { id: 'ai-model', label: 'AI 模型' }
    ]
  },
  {
    label: '数据管理',
    items: [
      { id: 'storage-export', label: '存储与导出' },
      { id: 'cache-cleanup', label: '缓存与清理' }
    ]
  },
  {
    label: '应用',
    items: [
      { id: 'recall-protection', label: '防撤回' },
      { id: 'appearance', label: '外观与行为' },
      { id: 'advanced', label: '高级' },
      { id: 'about', label: '关于' }
    ]
  }
]

export const SETTINGS_CATEGORY_LABELS = Object.fromEntries(
  SETTINGS_NAVIGATION.flatMap((group) => group.items.map((item) => [item.id, item.label]))
) as Record<SettingsCategoryId, string>
