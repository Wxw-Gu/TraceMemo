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
const getRuntimeStatus = vi.fn()
const onRuntimeProgress = vi.fn(() => vi.fn())
const rebind = vi.fn()
const sendGeneratedTtsVoice = vi.fn()
const getTextToSpeechSettings = vi.fn()
const listTextToSpeechVoices = vi.fn()
const synthesizeTextToSpeech = vi.fn()
const removeGeneratedTextToSpeechAudio = vi.fn()
const getPersonalWechatVoiceDiagnostic = vi.fn()
const copyText = vi.fn()

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
  oneBotPid: 5401,
  endpoint: '127.0.0.1:58080',
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

const readyRuntime = {
  version: 'v0.0.18',
  state: 'ready' as const,
  downloadedBytes: 1,
  totalBytes: 1,
  progress: 1,
  platform: 'darwin' as NodeJS.Platform,
  architecture: 'arm64',
  supported: true,
  removable: true
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
    getRuntimeStatus.mockReset().mockResolvedValue(readyRuntime)
    onRuntimeProgress.mockReset().mockReturnValue(vi.fn())
    rebind.mockReset().mockResolvedValue(readyStatus)
    sendGeneratedTtsVoice.mockReset().mockResolvedValue({
      action: { status: 'sent' },
      status: readyStatus
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
        getPersonalWechatRuntimeStatus: getRuntimeStatus,
        onPersonalWechatRuntimeProgress: onRuntimeProgress,
        rebindPersonalWechatSender: rebind,
        sendGeneratedTtsVoice,
        getTextToSpeechSettings,
        listTextToSpeechVoices,
        synthesizeTextToSpeech,
        removeGeneratedTextToSpeechAudio,
        getPersonalWechatVoiceDiagnostic,
        copyText
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

  it('keeps the setup guide voice-only when voice capability is unavailable', async () => {
    getStatus.mockResolvedValue({ ...readyStatus, canSend: false, canSendVoice: false })
    renderDialog({ onOpenPersonalWechatSettings: vi.fn() })
    expect(await screen.findByText('验证消息能力')).toBeInTheDocument()
    expect(screen.getByText('语音消息')).toBeInTheDocument()
    expect(screen.queryByText('文字消息')).not.toBeInTheDocument()
    expect(screen.queryByText('图片和语音消息')).not.toBeInTheDocument()
  })
})
