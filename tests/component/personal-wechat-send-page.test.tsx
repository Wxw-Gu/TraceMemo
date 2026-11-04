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
        rebindPersonalWechatSender: rebindSender,
        // 发送能力授权卡所需的两个入口。页面在 Native 档位会调用它们，
        // 缺 mock 会让 refresh 抛错、整页停在错误态。
        getMacSendRuntimeAvailability: vi.fn(async () => ({
          state: 'available',
          message: '微信发送组件可用'
        })),
        getMacLicenseStatus: vi.fn(async () => ({
          deviceId: null,
          state: 'unlicensed',
          authorized: false,
          source: 'none',
          features: [],
          lastCheckedAt: null,
          licenseExpiresAt: null,
          tokenExpiresAt: null,
          message: '当前设备暂无发送能力授权'
        })),
        refreshMacLicense: vi.fn()
      }
    })
  })

  it('shows the native runtime readiness', async () => {
    render(<PersonalWechatSendPage onNotice={vi.fn()} />)

    // 页面重构后「就绪」的落点从 SetupGuide 尾部文案变成了「微信发送环境」卡片的状态标签；
    // 断言改到新位置，语义仍是“运行时准备好了”。
    expect(await screen.findByText('运行环境已就绪')).toBeVisible()
    expect(screen.getAllByText('已就绪')).not.toHaveLength(0)
    expect(screen.queryByText('查看支持的微信版本')).not.toBeInTheDocument()
    expect(screen.queryByText('高级诊断')).not.toBeInTheDocument()
  })
})
