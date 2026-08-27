import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PersonalWechatSendDialog } from '../../src/renderer/src/components/chat/PersonalWechatSendDialog'

const getStatus = vi.fn()
const getRuntimeStatus = vi.fn()
const downloadRuntime = vi.fn()
const onRuntimeProgress = vi.fn(() => vi.fn())
const rebind = vi.fn()
const selectImage = vi.fn()
const selectVoice = vi.fn()
const sendMessage = vi.fn()
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
  const bind = await screen.findByRole('button', { name: '绑定微信' })
  fireEvent.click(bind)
  await screen.findByText('✓ 微信已绑定')
  const detect = await screen.findByRole('button', { name: '重新检测' })
  fireEvent.click(detect)
  const start = await screen.findByRole('button', { name: '开始发送' })
  fireEvent.click(start)
}

describe('PersonalWechatSendDialog', () => {
  beforeEach(() => {
    getStatus.mockReset().mockResolvedValue(readyStatus)
    getRuntimeStatus.mockReset().mockResolvedValue(readyRuntime)
    downloadRuntime.mockReset().mockResolvedValue({ success: true, status: readyRuntime })
    onRuntimeProgress.mockReset().mockReturnValue(vi.fn())
    rebind.mockReset().mockResolvedValue(readyStatus)
    selectImage
      .mockReset()
      .mockResolvedValue({ canceled: false, path: '/Users/fixture/test.png', name: 'test.png' })
    selectVoice
      .mockReset()
      .mockResolvedValue({ canceled: false, path: '/Users/fixture/test.silk', name: 'test.silk' })
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
    getPersonalWechatVoiceDiagnostic.mockReset().mockResolvedValue(null)
    copyText.mockReset().mockResolvedValue({ success: true })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getPersonalWechatSenderStatus: getStatus,
        getPersonalWechatRuntimeStatus: getRuntimeStatus,
        downloadPersonalWechatRuntime: downloadRuntime,
        onPersonalWechatRuntimeProgress: onRuntimeProgress,
        rebindPersonalWechatSender: rebind,
        selectPersonalWechatImage: selectImage,
        selectPersonalWechatVoice: selectVoice,
        sendPersonalWechatMessage: sendMessage,
        getTextToSpeechSettings,
        listTextToSpeechVoices,
        synthesizeTextToSpeech,
        removeGeneratedTextToSpeechAudio,
        getPersonalWechatVoiceDiagnostic,
        copyText
      }
    })
  })

  it('shows a user-facing four-step setup and keeps diagnostics collapsed', async () => {
    getRuntimeStatus
      .mockResolvedValueOnce({ ...readyRuntime, state: 'missing', progress: 0 })
      .mockResolvedValue(readyRuntime)
    getStatus.mockResolvedValue({
      ...readyStatus,
      state: 'stopped',
      runtimeReady: false,
      canSend: false,
      canSendText: false,
      canSendImage: false,
      canSendVoice: false,
      message: '尚未绑定当前微信'
    })
    renderDialog()
    expect(await screen.findByText('准备语音模型')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '下载模型' })).toBeEnabled()
    expect(screen.getByText('绑定个人微信')).toBeInTheDocument()
    expect(screen.getByText('验证消息能力')).toBeInTheDocument()
    expect(screen.getByText('能力检测')).toBeInTheDocument()
    expect(screen.getByText('图片和语音消息')).toBeInTheDocument()
    expect(screen.getByRole('note')).toHaveTextContent(
      '绑定微信可能导致当前微信异常闪退，这是正常现象。若微信退出，请重新启动微信后，再回到这里重新检测/绑定。'
    )
    fireEvent.click(screen.getByRole('button', { name: '查看支持的微信版本' }))
    const versionsDialog = screen.getByRole('dialog', { name: '支持的微信版本' })
    expect(versionsDialog).toBeInTheDocument()
    expect(versionsDialog).toHaveTextContent('4.1.11.53')
    expect(screen.queryByLabelText('消息列表')).not.toBeInTheDocument()
    expect(screen.queryByText('TraceMemo 消息发送')).not.toBeInTheDocument()
    expect(screen.queryByText('PID 4668')).not.toBeVisible()
    fireEvent.click(screen.getByText('高级诊断'))
    expect(screen.getByText('PID 4668')).toBeInTheDocument()
  })

  it('sends text through the existing message API and echoes it in the chat', async () => {
    renderDialog()
    await startComposer()
    await userEvent
      .setup()
      .type(screen.getByRole('textbox', { name: '消息内容' }), '你好 TraceMemo')
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith({
        type: 'text',
        to: 'fixture-room@chatroom',
        text: '你好 TraceMemo',
        isGroup: true
      })
    )
    expect(
      screen.getByLabelText('消息列表').querySelector('.personal-wechat-message-bubble')
    ).toHaveTextContent('你好 TraceMemo')
  })

  it('supports local image and voice selection', async () => {
    renderDialog()
    await startComposer()
    fireEvent.click(screen.getByRole('radio', { name: '图片' }))
    fireEvent.click(screen.getByRole('button', { name: '选择图片' }))
    expect(await screen.findByText('test.png')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith({
        type: 'image',
        to: 'fixture-room@chatroom',
        filePath: '/Users/fixture/test.png',
        isGroup: true
      })
    )

    fireEvent.click(screen.getByRole('radio', { name: '语音' }))
    fireEvent.click(screen.getByRole('radio', { name: '选择本地文件' }))
    fireEvent.click(screen.getByRole('button', { name: '选择语音' }))
    expect(await screen.findByText('test.silk')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith({
        type: 'voice',
        to: 'fixture-room@chatroom',
        filePath: '/Users/fixture/test.silk',
        isGroup: true
      })
    )
  })

  it('sends the same generated voice through the comparison path', async () => {
    renderDialog()
    await startComposer()
    fireEvent.click(screen.getByRole('radio', { name: '语音' }))
    fireEvent.change(screen.getByRole('textbox', { name: '语音文字' }), {
      target: { value: '入口2语音测试' }
    })
    fireEvent.click(screen.getByRole('button', { name: '生成语音' }))
    await waitFor(() => expect(screen.getByText('语音已生成')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '发送2' }))
    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith({
        type: 'voice',
        to: 'fixture-room@chatroom',
        filePath: '/tmp/generated.mp3',
        isGroup: true,
        voiceSendMode: 'legacy'
      })
    )
  })

  it('uses the existing runtime, binding and detection IPC actions', async () => {
    getRuntimeStatus
      .mockResolvedValueOnce({ ...readyRuntime, state: 'missing', progress: 0 })
      .mockResolvedValue(readyRuntime)
    getStatus
      .mockResolvedValueOnce({
        ...readyStatus,
        state: 'stopped',
        runtimeReady: false,
        canSend: false,
        canSendText: false,
        canSendImage: false,
        canSendVoice: false
      })
      .mockResolvedValue({
        ...readyStatus,
        state: 'stopped',
        runtimeReady: true,
        canSend: false,
        canSendText: false,
        canSendImage: false,
        canSendVoice: false
      })
    renderDialog()
    await screen.findByRole('button', { name: '下载模型' })
    fireEvent.click(screen.getByRole('button', { name: '下载模型' }))
    await waitFor(() => expect(downloadRuntime).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: '绑定微信' }))
    await waitFor(() => expect(rebind).toHaveBeenCalledOnce())
  })

  it('shows a stable bound state after binding', async () => {
    getRuntimeStatus.mockResolvedValue(readyRuntime)
    getStatus
      .mockResolvedValueOnce({
        ...readyStatus,
        state: 'stopped',
        canSend: false,
        canSendText: false,
        canSendImage: false,
        canSendVoice: false
      })
      .mockResolvedValue(readyStatus)
    renderDialog()
    await screen.findByRole('button', { name: '绑定微信' })
    fireEvent.click(screen.getByRole('button', { name: '绑定微信' }))
    expect(await screen.findByText('✓ 微信已绑定')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '绑定微信' })).not.toBeInTheDocument()
  })

  it('treats image and voice readiness as one media capability', async () => {
    getStatus.mockResolvedValue({
      ...readyStatus,
      canSendImage: false,
      canSendVoice: true
    })
    renderDialog()
    expect(await screen.findByText('图片和语音消息')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '绑定微信' }))
    await screen.findByText('✓ 微信已绑定')
    fireEvent.click(await screen.findByRole('button', { name: '重新检测' }))
    expect(screen.getByText('微信消息发送已配置完成')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '开始发送' })).toBeEnabled()
    expect(screen.queryByText('图片消息')).not.toBeInTheDocument()
    expect(screen.queryByText('语音消息')).not.toBeInTheDocument()
  })

  it('keeps re-detection available and explains when no new messages are found', async () => {
    getRuntimeStatus.mockResolvedValue(readyRuntime)
    getStatus.mockResolvedValue({
      ...readyStatus,
      canSend: false,
      canSendText: false,
      canSendImage: false,
      canSendVoice: false,
      message: '等待消息初始化'
    })
    renderDialog()
    fireEvent.click(await screen.findByRole('button', { name: '绑定微信' }))
    await screen.findByText('✓ 微信已绑定')
    const detect = await screen.findByRole('button', { name: '重新检测' })
    expect(detect).toBeEnabled()
    fireEvent.click(detect)
    expect(
      await screen.findByText(
        '暂未检测到新的消息，请确认已在手机微信中发送文字和图片，然后再次检测。'
      )
    ).toBeInTheDocument()
    expect(screen.getAllByText('未检测').length).toBe(2)
  })

  it('keeps the dialog and controls stable while sending', async () => {
    const user = userEvent.setup()
    sendMessage.mockImplementation(() => new Promise(() => undefined))
    renderDialog()
    await startComposer()
    await screen.findByRole('textbox', { name: '消息内容' })
    await user.type(screen.getByRole('textbox', { name: '消息内容' }), '发送中')
    await user.click(screen.getByRole('button', { name: '发送消息' }))
    expect(screen.getByRole('button', { name: '正在发送…' })).toBeDisabled()
    expect(screen.getByRole('radio', { name: '图片' })).toBeDisabled()
  })

  it('shows and copies the latest redacted voice diagnostic JSON', async () => {
    getPersonalWechatVoiceDiagnostic.mockResolvedValue({
      request_id: 'request-1',
      voice_id: 'request-1',
      phase: 'completed',
      encoder_name: 'go-silk',
      encoder_version: 'wechat_chatter-v0.0.18',
      input_bytes: 35107,
      normalized_input_bytes: 69804,
      pcm_size: 69760,
      sample_rate: 16000,
      channels: 1,
      input_duration_ms: 2180,
      upload_result: '0',
      upload_data_len: 4380,
      silk_duration_ms: 2180,
      send_result: '1'
    })
    renderDialog()
    await startComposer()
    fireEvent.click(screen.getByRole('button', { name: '语音发送诊断' }))
    const diagnosticDialog = await screen.findByRole('dialog', { name: '语音发送诊断' })
    expect(diagnosticDialog).toHaveTextContent('"encoder_name": "go-silk"')
    expect(diagnosticDialog).not.toHaveTextContent('aesKey')
    fireEvent.click(screen.getByRole('button', { name: '复制诊断 JSON' }))
    await waitFor(() => expect(copyText).toHaveBeenCalledWith(expect.stringContaining('request-1')))
    expect(screen.getByRole('button', { name: '已复制' })).toBeInTheDocument()
  })

  it('shows an empty state when no voice diagnostic exists', async () => {
    renderDialog()
    await startComposer()
    fireEvent.click(screen.getByRole('button', { name: '语音发送诊断' }))
    expect(await screen.findByText('暂无诊断信息')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '复制诊断 JSON' })).toBeDisabled()
  })
})
