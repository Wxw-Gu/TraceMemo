import { useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PersonalWechatSendDialog } from '../../src/renderer/src/components/chat/PersonalWechatSendDialog'

const getStatus = vi.fn()
const rebind = vi.fn()
const selectImage = vi.fn()
const selectVoice = vi.fn()
const sendMessage = vi.fn()
const getTextToSpeechSettings = vi.fn()
const listTextToSpeechVoices = vi.fn()
const synthesizeTextToSpeech = vi.fn()
const removeGeneratedTextToSpeechAudio = vi.fn()

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

function Harness({ onClose = vi.fn() }: { onClose?: () => void }): React.ReactElement {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        打开测试发送
      </button>
      {open && (
        <PersonalWechatSendDialog
          contact={contact}
          isGroupChat
          onClose={() => {
            onClose()
            setOpen(false)
          }}
        />
      )}
    </>
  )
}

describe('PersonalWechatSendDialog', () => {
  beforeEach(() => {
    getStatus.mockReset().mockResolvedValue(readyStatus)
    rebind.mockReset().mockResolvedValue(readyStatus)
    selectImage.mockReset().mockResolvedValue({
      canceled: false,
      path: '/Users/fixture/test.png',
      name: 'test.png'
    })
    selectVoice.mockReset().mockResolvedValue({
      canceled: false,
      path: '/Users/fixture/test.silk',
      name: 'test.silk'
    })
    sendMessage.mockReset().mockResolvedValue({ success: true, status: readyStatus })
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
      items: [
        {
          id: 'fish-warm-female',
          name: '暖阳女声',
          description: '自然温和',
          tags: ['女声'],
          languages: ['中文'],
          source: 'fish-audio'
        }
      ],
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
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getPersonalWechatSenderStatus: getStatus,
        rebindPersonalWechatSender: rebind,
        selectPersonalWechatImage: selectImage,
        selectPersonalWechatVoice: selectVoice,
        sendPersonalWechatMessage: sendMessage,
        getTextToSpeechSettings,
        listTextToSpeechVoices,
        synthesizeTextToSpeech,
        removeGeneratedTextToSpeechAudio
      }
    })
  })

  it('switches to voice mode and sends only the selected audio file', async () => {
    render(<PersonalWechatSendDialog contact={contact} isGroupChat onClose={vi.fn()} />)
    await screen.findByText('技术交流群')
    fireEvent.click(screen.getByRole('radio', { name: '语音' }))
    fireEvent.click(screen.getByRole('radio', { name: '选择本地文件' }))
    fireEvent.click(screen.getByRole('button', { name: '选择语音' }))
    expect(await screen.findByText('test.silk')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '测试发送语音到群聊' }))
    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith({
        type: 'voice',
        to: 'fixture-room@chatroom',
        filePath: '/Users/fixture/test.silk',
        isGroup: true
      })
    )
  })

  it('shows the selected TTS voice and keeps generation separate from sending', async () => {
    const openSettings = vi.fn()
    render(
      <PersonalWechatSendDialog
        contact={contact}
        isGroupChat
        onClose={vi.fn()}
        onOpenTextToSpeechSettings={openSettings}
      />
    )
    await screen.findByText('技术交流群')
    fireEvent.click(screen.getByRole('radio', { name: '语音' }))
    expect(await screen.findByText('暖阳女声')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '要生成的文字' })).toHaveValue('1')
    expect(screen.getByRole('button', { name: '生成语音' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: '前往文字转语音设置' }))
    expect(openSettings).toHaveBeenCalledTimes(1)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('shows binding diagnostics and only offers image and voice modes', async () => {
    render(<PersonalWechatSendDialog contact={contact} isGroupChat onClose={vi.fn()} />)

    expect(await screen.findByText('PID 4668')).toBeInTheDocument()
    expect(screen.getByText('PID 5401 · 绑定 4668')).toBeInTheDocument()
    expect(screen.getByText('0x114ef8000')).toBeInTheDocument()
    expect(screen.getByText('已捕获，可发送')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '图片' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: '语音' })).toBeVisible()
    expect(screen.queryByRole('radio', { name: '文字' })).not.toBeInTheDocument()
  })

  it('supports segmented keyboard navigation for the message type', async () => {
    const user = userEvent.setup()
    render(<PersonalWechatSendDialog contact={contact} isGroupChat onClose={vi.fn()} />)

    await screen.findByText('技术交流群')
    const imageMode = screen.getByRole('radio', { name: '图片' })
    const voiceMode = screen.getByRole('radio', { name: '语音' })
    imageMode.focus()
    await user.keyboard('{ArrowRight}')
    expect(voiceMode).toHaveFocus()
    await user.keyboard(' ')
    expect(voiceMode).toBeChecked()
    expect(screen.getByRole('textbox', { name: '要生成的文字' })).toBeVisible()
  })

  it('switches to image mode and sends only the selected image', async () => {
    render(<PersonalWechatSendDialog contact={contact} isGroupChat onClose={vi.fn()} />)
    await screen.findByText('技术交流群')
    fireEvent.click(screen.getByRole('radio', { name: '图片' }))
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(
      screen.getByText(
        '如果想测试图片，请先在微信中给任意好友手动发送一张普通图片，再点击重新检测。',
        { exact: false }
      )
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '选择图片' }))
    expect(await screen.findByText('test.png')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '测试发送图片到群聊' }))

    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith({
        type: 'image',
        to: 'fixture-room@chatroom',
        filePath: '/Users/fixture/test.png',
        isGroup: true
      })
    )
  })

  it('offers a safe explicit rebind action', async () => {
    render(<PersonalWechatSendDialog contact={contact} isGroupChat onClose={vi.fn()} />)
    await screen.findByText('技术交流群')
    fireEvent.click(screen.getByRole('button', { name: '尝试重新绑定' }))
    await waitFor(() => expect(rebind).toHaveBeenCalledTimes(1))
  })

  it('blocks image sending until the media Hook and image directory are initialized', async () => {
    getStatus.mockResolvedValue({
      ...readyStatus,
      state: 'hook_not_ready',
      imageHookReady: false,
      canSendImage: false,
      message: '请先手动发送图片'
    })
    render(<PersonalWechatSendDialog contact={contact} isGroupChat onClose={vi.fn()} />)
    expect(await screen.findByText('已绑定，等待消息初始化')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '测试发送图片到群聊' })).toBeDisabled()
  })

  it('closes with Escape or the overlay and restores focus to the opener', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)
    const opener = screen.getByRole('button', { name: '打开测试发送' })

    await user.click(opener)
    await screen.findByText('技术交流群')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: '个人微信测试发送' })).not.toBeInTheDocument()
    await waitFor(() => expect(opener).toHaveFocus())

    await user.click(opener)
    const dialog = await screen.findByRole('dialog', { name: '个人微信测试发送' })
    await user.click(dialog.previousElementSibling as HTMLElement)
    expect(screen.queryByRole('dialog', { name: '个人微信测试发送' })).not.toBeInTheDocument()
    await waitFor(() => expect(opener).toHaveFocus())
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('keeps the dialog open while a message is being sent', async () => {
    const user = userEvent.setup()
    sendMessage.mockImplementation(() => new Promise(() => undefined))
    render(<Harness />)

    await user.click(screen.getByRole('button', { name: '打开测试发送' }))
    await screen.findByText('技术交流群')
    await user.click(screen.getByRole('button', { name: '选择图片' }))
    await user.click(screen.getByRole('button', { name: '测试发送图片到群聊' }))
    expect(screen.getByRole('button', { name: '正在发送…' })).toBeDisabled()
    expect(screen.getByRole('radio', { name: '图片' })).toBeDisabled()
    expect(screen.getByRole('radio', { name: '语音' })).toBeDisabled()

    await user.keyboard('{Escape}')
    expect(screen.getByRole('dialog', { name: '个人微信测试发送' })).toBeVisible()
    await user.click(
      screen.getByRole('dialog', { name: '个人微信测试发送' }).previousElementSibling as HTMLElement
    )
    expect(screen.getByRole('dialog', { name: '个人微信测试发送' })).toBeVisible()
  })
})
