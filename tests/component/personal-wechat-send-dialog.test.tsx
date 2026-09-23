import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PersonalWechatSendDialog } from '../../src/renderer/src/components/chat/PersonalWechatSendDialog'

vi.mock('../../src/renderer/src/utils/runtime-environment', () => ({
  isMac: true,
  isWindows: false,
  runtimePlatform: 'darwin',
  supportsPersonalWechatSend: true
}))

const getStatus = vi.fn()
const rebind = vi.fn()
const sendGeneratedTtsVoice = vi.fn()
const sendPersonalWechatMessage = vi.fn()
const getTextToSpeechSettings = vi.fn()
const listTextToSpeechVoices = vi.fn()
const synthesizeTextToSpeech = vi.fn()
const removeGeneratedTextToSpeechAudio = vi.fn()
const getPersonalWechatVoiceDiagnostic = vi.fn()
const copyText = vi.fn()
const getSettings = vi.fn()
const setSettings = vi.fn()

const contact = {
  m_nsUsrName: 'fixture-room@chatroom',
  m_nsNickName: '技术交流群',
  md5: 'fixture-md5',
  type: 'group' as const
}

const readyStatus = {
  state: 'online' as const,
  platform: 'darwin',
  arch: 'arm64',
  sipDisabled: true,
  wechatRunning: true,
  wechatPid: 4668,
  boundWechatPid: 4668,
  endpoint: '127.0.0.1:4290',
  endpointReady: true,
  wechatVersion: '4.1.11.53',
  runtimeReady: true,
  attachReady: true,
  baseAddress: '0x114ef8000',
  baseAddressReady: true,
  textHookInstalled: true,
  textHookReady: true,
  imageHookInstalled: true,
  imageHookReady: true,
  messageListenerReady: true,
  canSend: true,
  canSendText: true,
  canSendImage: true,
  canSendVoice: true,
  message: '个人微信已绑定'
}

function renderDialog(
  props: Partial<React.ComponentProps<typeof PersonalWechatSendDialog>> = {}
): React.ReactElement {
  return render(
    <PersonalWechatSendDialog contact={contact} isGroupChat onClose={vi.fn()} {...props} />
  )
}

async function startComposer(): Promise<void> {
  await screen.findByRole('textbox', { name: '语音文字' })
}

describe('PersonalWechatSendDialog', () => {
  beforeEach(() => {
    getStatus.mockReset().mockResolvedValue(readyStatus)
    rebind.mockReset().mockResolvedValue(readyStatus)
    sendGeneratedTtsVoice.mockReset().mockResolvedValue({
      action: { status: 'sent' },
      status: readyStatus
    })
    sendPersonalWechatMessage.mockReset().mockResolvedValue({
      success: true,
      status: readyStatus,
      postfixSent: true
    })
    getSettings.mockReset().mockResolvedValue({
      settings: { reportImagePostfixText: '今日日报' },
      settingsPath: '/tmp/settings.json'
    })
    setSettings.mockReset().mockResolvedValue({
      settings: { reportImagePostfixText: '今日日报' },
      settingsPath: '/tmp/settings.json'
    })
    getTextToSpeechSettings.mockReset().mockResolvedValue({
      success: true,
      settings: {
        provider: 'fish-audio',
        hasApiKey: true,
        encryptionAvailable: true,
        selectedVoiceId: 'fish-warm-female',
        outputFormat: 'mp3',
        model: 's2.1-pro-free',
        phase: 'ready'
      },
      voices: []
    })
    listTextToSpeechVoices.mockReset().mockResolvedValue({
      success: true,
      items: [{ id: 'fish-warm-female', name: '暖阳女声' }],
      total: 1,
      pageNumber: 1,
      pageSize: 24,
      hasMore: false
    })
    synthesizeTextToSpeech.mockReset().mockResolvedValue({
      success: true,
      filePath: '/tmp/generated.mp3',
      audioDataUrl: 'data:audio/mpeg;base64,fixture'
    })
    removeGeneratedTextToSpeechAudio.mockReset().mockResolvedValue({ success: true })
    getPersonalWechatVoiceDiagnostic.mockReset().mockResolvedValue(null)
    copyText.mockReset().mockResolvedValue({ success: true })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getPersonalWechatSenderStatus: getStatus,
        rebindPersonalWechatSender: rebind,
        sendGeneratedTtsVoice,
        sendPersonalWechatMessage,
        getTextToSpeechSettings,
        listTextToSpeechVoices,
        synthesizeTextToSpeech,
        removeGeneratedTextToSpeechAudio,
        getPersonalWechatVoiceDiagnostic,
        copyText,
        getSettings,
        setSettings
      }
    })
  })

  it('opens the TTS composer immediately when voice capability is ready', async () => {
    renderDialog()
    await startComposer()
    expect(screen.getByRole('dialog')).toHaveTextContent('文字转语音')
    expect(screen.queryByText('验证消息能力')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '生成语音' })).toBeDisabled()
  })

  it('generates, previews and sends a voice through the semantic TTS IPC', async () => {
    const user = userEvent.setup()
    renderDialog()
    await startComposer()
    await user.type(screen.getByRole('textbox', { name: '语音文字' }), '你好 TraceMemo')
    await user.click(screen.getByRole('button', { name: '生成语音' }))
    expect(await screen.findByText('语音已生成')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '试听' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: '发送到微信' }))
    await waitFor(() =>
      expect(sendGeneratedTtsVoice).toHaveBeenCalledWith({
        to: 'fixture-room@chatroom',
        isGroup: true,
        filePath: '/tmp/generated.mp3'
      })
    )
    expect(screen.getByLabelText('消息列表')).toHaveTextContent('你好 TraceMemo')
  })

  it('shows image send success feedback after the host confirms the send', async () => {
    const user = userEvent.setup()
    renderDialog({ initialImage: { path: '/tmp/report.png', name: '测试群日报.png' } })
    expect(await screen.findByRole('textbox', { name: '发送后置词' })).toHaveValue('今日日报')
    const sendButton = await screen.findByRole('button', { name: '发送日报图片' })
    await user.click(sendButton)

    await waitFor(() =>
      expect(sendPersonalWechatMessage).toHaveBeenCalledWith({
        type: 'image',
        to: 'fixture-room@chatroom',
        isGroup: true,
        filePath: '/tmp/report.png',
        postfixText: '今日日报'
      })
    )
    expect(await screen.findByRole('status')).toHaveTextContent('日报图片和后置词发送成功')
  })

  it('persists a customized report postfix and sends it with the image request', async () => {
    const user = userEvent.setup()
    renderDialog({ initialImage: { path: '/tmp/report.png', name: '测试群日报.png' } })
    const input = await screen.findByRole('textbox', { name: '发送后置词' })
    await user.clear(input)
    await user.type(input, '今日技术日报')
    await user.tab()
    await user.click(screen.getByRole('button', { name: '发送日报图片' }))

    expect(setSettings).toHaveBeenCalledWith({ reportImagePostfixText: '今日技术日报' })
    await waitFor(() =>
      expect(sendPersonalWechatMessage).toHaveBeenCalledWith(
        expect.objectContaining({ postfixText: '今日技术日报' })
      )
    )
  })

  it('shows an error when the report postfix cannot be persisted', async () => {
    setSettings.mockRejectedValueOnce(new Error('设置保存失败'))
    const user = userEvent.setup()
    renderDialog({ initialImage: { path: '/tmp/report.png', name: '测试群日报.png' } })
    const input = await screen.findByRole('textbox', { name: '发送后置词' })

    await user.clear(input)
    await user.type(input, '今日技术日报')
    await user.tab()

    expect(await screen.findByRole('alert')).toHaveTextContent('设置保存失败')
  })

  it('keeps the setup guide voice-only when voice capability is unavailable', async () => {
    getStatus.mockResolvedValue({ ...readyStatus, canSend: false, canSendVoice: false })
    renderDialog({ onOpenPersonalWechatSettings: vi.fn() })
    expect(await screen.findByText('初始化发送能力')).toBeInTheDocument()
    expect(screen.getByText('语音消息')).toBeInTheDocument()
    expect(screen.getByText('文字消息')).toBeInTheDocument()
    expect(screen.getByText('图片消息')).toBeInTheDocument()
  })
})
