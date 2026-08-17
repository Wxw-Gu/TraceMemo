import { describe, expect, it } from 'vitest'
import { SETTINGS_NAVIGATION } from '../../src/renderer/src/features/settings/model/settingsNavigation'

describe('settings navigation', () => {
  it('places text-to-speech under intelligent capabilities', () => {
    const intelligent = SETTINGS_NAVIGATION.find((group) => group.label === '智能能力')
    expect(intelligent?.items.map((item) => item.id)).toEqual([
      'voice-recognition',
      'text-to-speech',
      'ai-model'
    ])
  })
})
