import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TextToSpeechPage } from '../../src/renderer/src/features/settings/pages/TextToSpeechPage'

const getSettings = vi.fn()
const saveSettings = vi.fn()
const listVoices = vi.fn()
const openApiKeys = vi.fn()
const getRuntimeStatus = vi.fn()
const onRuntimeProgress = vi.fn(() => vi.fn())

const response = {
  success: true,
  settings: {
    provider: 'fish-audio' as const,
    hasApiKey: true,
    hasStoredApiKey: true,
    hasEnvironmentApiKey: false,
    keySource: 'secure-storage' as const,
    encryptionAvailable: true,
    selectedVoiceId: 'fish-warm-female',
    outputFormat: 'mp3' as const,
    model: 's2.1-pro-free' as const,
    phase: 'ready' as const
  },
  voices: [
    {
      id: 'fish-warm-female',
      name: '暖阳女声',
      description: '自然温和，适合日常对话',
      tags: ['女声', '自然', '普通话'],
      languages: ['中文'],
      source: 'fish-audio' as const
    },
    {
      id: 'fish-calm-male',
      name: '沉稳男声',
      description: '低沉清晰，适合知识说明',
      tags: ['男声', '沉稳', '普通话'],
      languages: ['中文'],
      source: 'fish-audio' as const
    }
  ]
}

describe('TextToSpeechPage', () => {
  beforeEach(() => {
    getSettings.mockReset().mockResolvedValue(response)
    listVoices.mockReset().mockResolvedValue({
      success: true,
      items: response.voices,
      total: response.voices.length,
      pageNumber: 1,
      pageSize: 24,
      hasMore: false
    })
    saveSettings.mockReset().mockImplementation(async (request) => ({
      ...response,
      settings: {
        ...response.settings,
        hasApiKey: Boolean(request.apiKey),
        selectedVoiceId: request.selectedVoiceId || response.settings.selectedVoiceId,
        model: request.model || response.settings.model
      }
    }))
    openApiKeys.mockReset().mockResolvedValue({ success: true })
    getRuntimeStatus.mockReset().mockResolvedValue({
      version: 'v0.0.18',
      state: 'ready',
      downloadedBytes: 100,
      totalBytes: 100,
      progress: 1,
      platform: 'darwin',
      architecture: 'arm64',
      supported: true,
      removable: true
    })
    onRuntimeProgress.mockReset().mockReturnValue(vi.fn())
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getTextToSpeechSettings: getSettings,
        saveTextToSpeechSettings: saveSettings,
        listTextToSpeechVoices: listVoices,
        openFishAudioApiKeys: openApiKeys,
        getPersonalWechatRuntimeStatus: getRuntimeStatus,
        onPersonalWechatRuntimeProgress: onRuntimeProgress
      }
    })
  })

  it('searches, selects and securely saves an API key with a voice', async () => {
    const onNotice = vi.fn()
    render(<TextToSpeechPage onNotice={onNotice} />)

    expect(await screen.findAllByText('暖阳女声')).not.toHaveLength(0)
    fireEvent.change(screen.getByPlaceholderText('按音色名称搜索'), {
      target: { value: '沉稳' }
    })
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    await waitFor(() =>
      expect(listVoices).toHaveBeenCalledWith({
        pageNumber: 1,
        pageSize: 24,
        title: '沉稳',
        tags: []
      })
    )
    fireEvent.click(screen.getByRole('radio', { name: /沉稳男声/ }))
    fireEvent.change(screen.getByPlaceholderText('已安全保存；输入新 Key 可替换'), {
      target: { value: 'fish-fixture-key' }
    })
    fireEvent.click(screen.getByRole('button', { name: '保存 Key' }))

    await waitFor(() =>
      expect(saveSettings).toHaveBeenCalledWith({
        apiKey: 'fish-fixture-key'
      })
    )
    expect(onNotice).toHaveBeenCalledWith('API Key 已安全保存')
  })

  it('opens the official Fish Audio API key page through the main process', async () => {
    render(<TextToSpeechPage onNotice={vi.fn()} />)
    await screen.findByText('微信发送组件')
    fireEvent.click(screen.getByRole('button', { name: '前往 api.fish.audio 获取 Key' }))
    await waitFor(() => expect(openApiKeys).toHaveBeenCalledTimes(1))
  })
})
