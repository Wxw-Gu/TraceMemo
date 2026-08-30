import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PersonalWechatSendPage } from '../../src/renderer/src/features/settings/pages/PersonalWechatSendPage'

vi.mock('../../src/renderer/src/utils/runtime-environment', () => ({
  isMac: true,
  isWindows: false,
  runtimePlatform: 'darwin',
  supportsPersonalWechatSend: true
}))

const getCapability = vi.fn()
const getSenderStatus = vi.fn()
const getRuntimeStatus = vi.fn()
const onRuntimeProgress = vi.fn(() => vi.fn())
const downloadRuntime = vi.fn()
const cancelRuntimeDownload = vi.fn()
const removeRuntime = vi.fn()
const openRuntimeDirectory = vi.fn()
const rebindSender = vi.fn()

const senderStatus = {
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
  downloadedBytes: 66_599_785,
  totalBytes: 66_599_785,
  progress: 1,
  platform: 'darwin' as NodeJS.Platform,
  architecture: 'arm64',
  supported: true,
  removable: true,
  directory: '/tmp/personal-wechat-runtime'
}

const capability = {
  supported: true,
  ready: true,
  status: 'ready' as const,
  capabilities: { text: true, image: true, voice: true },
  senderStatus,
  message: '个人微信发送能力已就绪'
}

describe('PersonalWechatSendPage on macOS', () => {
  beforeEach(() => {
    getCapability.mockReset().mockResolvedValue(capability)
    getSenderStatus.mockReset().mockResolvedValue(senderStatus)
    getRuntimeStatus.mockReset().mockResolvedValue(readyRuntime)
    onRuntimeProgress.mockReset().mockReturnValue(vi.fn())
    downloadRuntime.mockReset().mockResolvedValue({ success: true, status: readyRuntime })
    cancelRuntimeDownload.mockReset().mockResolvedValue({ success: true })
    removeRuntime.mockReset().mockResolvedValue({
      ...readyRuntime,
      state: 'missing',
      downloadedBytes: 0,
      progress: 0,
      removable: false,
      directory: undefined
    })
    openRuntimeDirectory.mockReset().mockResolvedValue({ success: true })
    rebindSender.mockReset().mockResolvedValue(senderStatus)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getPersonalWechatSendCapability: getCapability,
        getPersonalWechatSenderStatus: getSenderStatus,
        getPersonalWechatRuntimeStatus: getRuntimeStatus,
        onPersonalWechatRuntimeProgress: onRuntimeProgress,
        downloadPersonalWechatRuntime: downloadRuntime,
        cancelPersonalWechatRuntimeDownload: cancelRuntimeDownload,
        removePersonalWechatRuntime: removeRuntime,
        openPersonalWechatRuntimeDirectory: openRuntimeDirectory,
        rebindPersonalWechatSender: rebindSender
      }
    })
  })

  it('keeps OneBot runtime management on the WeChat send page', async () => {
    const user = userEvent.setup()
    render(<PersonalWechatSendPage onNotice={vi.fn()} />)

    expect(await screen.findByText('OneBot v0.0.18')).toBeVisible()
    expect(screen.getAllByText('已就绪')).not.toHaveLength(0)
    await user.click(screen.getByRole('button', { name: '打开目录' }))
    expect(openRuntimeDirectory).toHaveBeenCalledOnce()

    await user.click(screen.getByRole('button', { name: '卸载组件' }))
    await waitFor(() => expect(removeRuntime).toHaveBeenCalledOnce())

    await user.click(screen.getByRole('button', { name: '支持版本' }))
    const versionsDialog = screen.getByRole('dialog', { name: '支持的微信版本' })
    expect(versionsDialog).toBeVisible()
    expect(versionsDialog).toHaveTextContent('4.1.11.53')
  })

  it('downloads a missing macOS runtime from the send page', async () => {
    getRuntimeStatus.mockResolvedValue({
      ...readyRuntime,
      state: 'missing',
      downloadedBytes: 0,
      progress: 0,
      removable: false,
      directory: undefined
    })
    const onNotice = vi.fn()
    render(<PersonalWechatSendPage onNotice={onNotice} />)

    await userEvent.setup().click(await screen.findByRole('button', { name: '下载组件' }))
    await waitFor(() => expect(downloadRuntime).toHaveBeenCalledOnce())
    expect(onNotice).toHaveBeenCalledWith('微信发送组件已准备好')
  })
})
