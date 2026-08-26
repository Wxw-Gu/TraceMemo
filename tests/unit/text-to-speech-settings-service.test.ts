import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  keyGet: vi.fn(),
  keySave: vi.fn(),
  keyClear: vi.fn(),
  loadSettings: vi.fn(),
  updateSettings: vi.fn()
}))

const electronNetFetch = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/tracememo-test')
  },
  net: {
    fetch: electronNetFetch
  }
}))

vi.mock('../../src/main/ai-provider-key-store', () => ({
  AIProviderKeyStore: class {
    get = mocks.keyGet
    save = mocks.keySave
    clear = mocks.keyClear
  }
}))

vi.mock('../../src/main/services/settings-store', () => ({
  loadSettings: mocks.loadSettings,
  updateSettings: mocks.updateSettings
}))

import { TextToSpeechSettingsService } from '../../src/main/services/text-to-speech-settings-service'

describe('TextToSpeechSettingsService', () => {
  beforeEach(() => {
    mocks.keyGet.mockReset().mockReturnValue({
      success: true,
      available: true,
      key: undefined
    })
    mocks.keySave.mockReset().mockReturnValue({ success: true })
    mocks.keyClear.mockReset().mockReturnValue({ success: true })
    mocks.loadSettings.mockReset().mockReturnValue({ ttsSelectedVoiceId: 'demo-warm-female' })
    mocks.updateSettings.mockReset()
  })

  it('returns an empty dynamic voice list without exposing a missing key', () => {
    const result = new TextToSpeechSettingsService().get()
    expect(result.success).toBe(true)
    expect(result.settings.hasApiKey).toBe(false)
    expect(result.settings.selectedVoiceId).toBe('')
    expect(result.voices).toEqual([])
  })

  it('stores the key securely and persists the selected voice', () => {
    mocks.keyGet.mockReturnValue({ success: true, available: true, key: 'stored' })
    const result = new TextToSpeechSettingsService().save({
      apiKey: ' fish-key ',
      selectedVoiceId: 'demo-calm-male'
    })
    expect(mocks.keySave).toHaveBeenCalledWith('fish-audio-tts', 'fish-key')
    expect(mocks.updateSettings).toHaveBeenCalledWith({
      ttsSelectedVoiceId: 'demo-calm-male'
    })
    expect(result.settings.hasApiKey).toBe(true)
  })

  it('persists a remotely loaded voice id without local demo validation', () => {
    const result = new TextToSpeechSettingsService().save({
      selectedVoiceId: 'fish-model-id'
    })
    expect(result.success).toBe(true)
    expect(mocks.updateSettings).toHaveBeenCalledWith({
      ttsSelectedVoiceId: 'fish-model-id'
    })
  })

  it('uses Electron net.fetch for Fish Audio requests', async () => {
    mocks.keyGet.mockReturnValue({ success: true, available: true, key: 'stored' })
    electronNetFetch.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ total: 0, items: [], has_more: false })
    })

    const result = await new TextToSpeechSettingsService().listVoices({ pageSize: 1 })

    expect(result.success).toBe(true)
    expect(electronNetFetch).toHaveBeenCalledWith(
      expect.stringContaining('https://api.fish.audio/model'),
      expect.objectContaining({
        headers: { Authorization: 'Bearer stored' }
      })
    )
  })

  it('falls back to Node fetch when Electron transport is unavailable', async () => {
    mocks.keyGet.mockReturnValue({ success: true, available: true, key: 'stored' })
    electronNetFetch.mockRejectedValue(new TypeError('Electron transport unavailable'))
    const nodeFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ total: 0, items: [], has_more: false })
    })
    vi.stubGlobal('fetch', nodeFetch)

    const result = await new TextToSpeechSettingsService().listVoices({ pageSize: 1 })

    expect(result.success).toBe(true)
    expect(nodeFetch).toHaveBeenCalledWith(
      expect.stringContaining('https://api.fish.audio/model'),
      expect.objectContaining({ headers: { Authorization: 'Bearer stored' } })
    )
    vi.unstubAllGlobals()
  })
})
