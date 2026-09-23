import { render, screen } from '@testing-library/react'
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
const rebindSender = vi.fn()

const senderStatus = {
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
    rebindSender.mockReset().mockResolvedValue(senderStatus)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getPersonalWechatSendCapability: getCapability,
        getPersonalWechatSenderStatus: getSenderStatus,
        rebindPersonalWechatSender: rebindSender
      }
    })
  })

  it('shows the native runtime readiness', async () => {
    render(<PersonalWechatSendPage onNotice={vi.fn()} />)

    expect(await screen.findByText('微信消息发送已配置完成')).toBeVisible()
    expect(screen.getAllByText('已就绪')).not.toHaveLength(0)
    expect(screen.queryByText('查看支持的微信版本')).not.toBeInTheDocument()
    expect(screen.queryByText('高级诊断')).not.toBeInTheDocument()
  })
})
