import { describe, expect, it } from 'vitest'
import {
  SETTINGS_CATEGORY_LABELS,
  SETTINGS_NAVIGATION
} from '../../src/renderer/src/features/settings/model/settingsNavigation'

describe('settings navigation', () => {
  it('places text-to-speech under intelligent capabilities', () => {
    const intelligent = SETTINGS_NAVIGATION.find((group) => group.label === '智能能力')
    expect(intelligent?.items.map((item) => item.id)).toEqual([
      'wechat-send',
      'voice-recognition',
      'text-to-speech',
      'ai-model'
    ])
  })

  it('temporarily hides storage and export from visible navigation', () => {
    expect(SETTINGS_NAVIGATION.flatMap((group) => group.items)).not.toEqual(
      expect.arrayContaining([{ id: 'storage-export', label: '存储与导出' }])
    )
    expect(SETTINGS_CATEGORY_LABELS['storage-export']).toBe('存储与导出')
  })
})
