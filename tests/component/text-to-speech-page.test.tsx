import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TextToSpeechPage } from '../../src/renderer/src/features/settings/pages/TextToSpeechPage'

vi.mock('../../src/renderer/src/utils/runtime-environment', () => ({
  isMac: true,
  isWindows: false,
  runtimePlatform: 'darwin',
  supportsPersonalWechatSend: true
}))

const getSettings = vi.fn()
const saveSettings = vi.fn()
const listVoices = vi.fn()
const openApiKeys = vi.fn()

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
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getTextToSpeechSettings: getSettings,
        saveTextToSpeechSettings: saveSettings,
        listTextToSpeechVoices: listVoices,
        openFishAudioApiKeys: openApiKeys
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
    await screen.findByText('API 设置')
    fireEvent.click(screen.getByRole('button', { name: '前往 api.fish.audio 获取 Key' }))
    await waitFor(() => expect(openApiKeys).toHaveBeenCalledTimes(1))
  })

  it('keeps model selection and API key actions on their existing settings callbacks', async () => {
    const user = userEvent.setup()
    render(<TextToSpeechPage onNotice={vi.fn()} />)

    const apiKeyInput = await screen.findByPlaceholderText('已安全保存；输入新 Key 可替换')
    expect(apiKeyInput).toHaveAttribute('type', 'password')
    await user.click(screen.getByRole('button', { name: '显示' }))
    expect(apiKeyInput).toHaveAttribute('type', 'text')

    await user.click(screen.getByRole('combobox', { name: '合成模型' }))
    await user.click(screen.getByRole('option', { name: 's2.1-pro', exact: true }))
    await waitFor(() => expect(saveSettings).toHaveBeenCalledWith({ model: 's2.1-pro' }))

    await user.click(screen.getByRole('button', { name: '清除应用内 Key' }))
    await waitFor(() => expect(saveSettings).toHaveBeenCalledWith({ clearApiKey: true }))
  })

  it('keeps the speech page free of personal WeChat runtime controls', async () => {
    render(<TextToSpeechPage onNotice={vi.fn()} />)

    expect(await screen.findByText('API 设置')).toBeVisible()
    expect(screen.queryByText(/微信|OneBot/i)).not.toBeInTheDocument()
    expect(screen.queryByText('支持的微信版本')).not.toBeInTheDocument()
  })
})
