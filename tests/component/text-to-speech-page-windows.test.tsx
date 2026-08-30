import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PersonalWechatSendDialog } from '../../src/renderer/src/components/chat/PersonalWechatSendDialog'
import { PersonalWechatSendPage } from '../../src/renderer/src/features/settings/pages/PersonalWechatSendPage'
import { TextToSpeechPage } from '../../src/renderer/src/features/settings/pages/TextToSpeechPage'

vi.mock('../../src/renderer/src/utils/runtime-environment', () => ({
  isMac: false,
  isWindows: true,
  runtimePlatform: 'win32',
  supportsPersonalWechatSend: true
}))

const getTextToSpeechSettings = vi.fn()
const listTextToSpeechVoices = vi.fn()
const openFishAudioApiKeys = vi.fn()
const getSettings = vi.fn()
const setSettings = vi.fn()
const getPersonalWechatSenderStatus = vi.fn()
const getPersonalWechatRuntimeStatus = vi.fn()
const checkPersonalWechatSenderStatus = vi.fn()

const textToSpeechSettings = {
  success: true,
  settings: {
    provider: 'fish-audio' as const,
    hasApiKey: false,
    hasStoredApiKey: false,
    hasEnvironmentApiKey: false,
    keySource: 'none' as const,
    encryptionAvailable: true,
    selectedVoiceId: '',
    outputFormat: 'mp3' as const,
    model: 's2.1-pro-free' as const,
    phase: 'idle' as const
  },
  voices: []
}

const windowsStatus = {
  state: 'online' as const,
  platform: 'win32',
  arch: 'x64',
  sipDisabled: true,
  wechatRunning: true,
  runtimeReady: true,
  endpoint: '127.0.0.1:4567',
  endpointReady: true,
  attachReady: true,
  baseAddressReady: true,
  textHookInstalled: false,
  textHookReady: false,
  imageHookInstalled: false,
  imageHookReady: false,
  messageListenerReady: false,
  canSend: true,
  canSendText: true,
  canSendImage: true,
  canSendVoice: true,
  message: 'Windows 微信发送能力已连接，可以发送消息'
}

describe('PersonalWechatSendPage on Windows', () => {
  beforeEach(() => {
    getTextToSpeechSettings.mockReset().mockResolvedValue(textToSpeechSettings)
    listTextToSpeechVoices.mockReset()
    openFishAudioApiKeys.mockReset().mockResolvedValue({ success: true })
    getSettings.mockReset().mockResolvedValue({ settings: { windowsWechatPort: '' } })
    setSettings.mockReset().mockResolvedValue({
      settings: { windowsWechatPort: '4567' }
    })
    getPersonalWechatSenderStatus.mockReset()
    getPersonalWechatRuntimeStatus.mockReset().mockResolvedValue(null)
    checkPersonalWechatSenderStatus.mockReset().mockResolvedValue(windowsStatus)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getTextToSpeechSettings,
        listTextToSpeechVoices,
        openFishAudioApiKeys,
        getSettings,
        setSettings,
        getPersonalWechatSenderStatus,
        getPersonalWechatRuntimeStatus,
        checkPersonalWechatSenderStatus
      }
    })
  })

  it('keeps an unconfigured port empty and saves it only after a successful check', async () => {
    const onNotice = vi.fn()
    render(<PersonalWechatSendPage onNotice={onNotice} />)

    const portInput = await screen.findByRole('spinbutton', { name: '微信发送能力端口' })
    expect(portInput).toHaveValue(null)
    expect(screen.getByRole('button', { name: '检测' })).toBeEnabled()
    expect(getPersonalWechatSenderStatus).not.toHaveBeenCalled()

    fireEvent.change(portInput, { target: { value: '4567' } })
    fireEvent.click(screen.getByRole('button', { name: '检测' }))

    await waitFor(() => expect(checkPersonalWechatSenderStatus).toHaveBeenCalledWith('4567'))
    expect(screen.getByRole('button', { name: '保存' })).toBeEnabled()
    expect(portInput).toHaveValue(4567)

    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(setSettings).toHaveBeenCalledWith({ windowsWechatPort: '4567' }))
    expect(screen.getByRole('button', { name: '检测' })).toBeEnabled()
    expect(onNotice).toHaveBeenCalledWith('微信发送能力端口已保存')
  })

  it('clears a saved port and resets the connection state', async () => {
    getSettings.mockResolvedValue({ settings: { windowsWechatPort: '4567' } })
    getPersonalWechatSenderStatus.mockResolvedValue(windowsStatus)
    const onNotice = vi.fn()
    render(<PersonalWechatSendPage onNotice={onNotice} />)

    const portInput = await screen.findByRole('spinbutton', { name: '微信发送能力端口' })
    expect(portInput).toHaveValue(4567)
    expect(screen.getByRole('button', { name: '清除端口' })).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: '清除端口' }))

    await waitFor(() => expect(setSettings).toHaveBeenCalledWith({ windowsWechatPort: '' }))
    expect(portInput).toHaveValue(null)
    expect(screen.getByRole('button', { name: '清除端口' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '检测' })).toBeEnabled()
    expect(onNotice).toHaveBeenCalledWith('微信发送能力端口已清除')
  })

  it('keeps the Windows send dialog free of macOS OneBot controls', async () => {
    getPersonalWechatSenderStatus.mockResolvedValue({
      ...windowsStatus,
      state: 'error',
      canSend: false,
      canSendText: false,
      canSendImage: false,
      canSendVoice: false,
      message: '未检测到 Windows 微信发送能力，请先启动并登录微信'
    })

    render(
      <PersonalWechatSendDialog
        contact={{
          m_nsUsrName: 'fixture-user',
          m_nsNickName: '文件传输助手',
          md5: 'fixture-md5',
          type: 'user'
        }}
        isGroupChat={false}
        onClose={vi.fn()}
        onOpenPersonalWechatSettings={vi.fn()}
      />
    )

    expect(
      await screen.findByText('未检测到 Windows 微信发送能力，请先启动并登录微信')
    ).toBeVisible()
    expect(getPersonalWechatRuntimeStatus).not.toHaveBeenCalled()
    expect(screen.queryByText(/OneBot/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: '保留 OneBot 进程' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '语音发送诊断' })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '个人微信发送' })).toBeVisible()
    expect(screen.getByRole('region', { name: '发送消息' })).toBeVisible()
  })

  it('opens the Windows send dialog in text mode by default', async () => {
    getPersonalWechatSenderStatus.mockResolvedValue(windowsStatus)

    render(
      <PersonalWechatSendDialog
        contact={{
          m_nsUsrName: 'fixture-user',
          m_nsNickName: '文件传输助手',
          md5: 'fixture-md5',
          type: 'user'
        }}
        isGroupChat={false}
        onClose={vi.fn()}
      />
    )

    expect(await screen.findByRole('radio', { name: '文字' })).toHaveAttribute(
      'data-state',
      'checked'
    )
    expect(screen.getByRole('textbox', { name: '消息内容' })).toBeVisible()
  })

  it('keeps the Windows voice page focused on speech settings', async () => {
    render(<TextToSpeechPage onNotice={vi.fn()} />)

    expect(await screen.findByText('API 设置')).toBeVisible()
    expect(screen.queryByText(/OneBot/i)).not.toBeInTheDocument()
    expect(screen.queryByText('微信发送组件')).not.toBeInTheDocument()
  })
})
