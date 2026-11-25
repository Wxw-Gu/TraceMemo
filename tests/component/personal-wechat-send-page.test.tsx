// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PersonalWechatSendPage } from '../../src/renderer/src/features/settings/pages/PersonalWechatSendPage'

vi.mock('../../src/renderer/src/utils/runtime-environment', () => ({
  isMac: true,
  isWindows: false,
  runtimePlatform: 'darwin',
  supportsPersonalWechatSend: true
}))

const getSettings = vi.fn()
const setSettings = vi.fn()
const getSenderStatus = vi.fn()
const checkSenderStatus = vi.fn()
const getMacLicenseStatus = vi.fn()
// 合成占位 ID，仅匹配 mac_ + 64hex 格式；不要放真实设备 ID。
const TEST_DEVICE_ID = 'mac_9d204eef37960efc91277713c5441b6ab27c4e46c739c70d6c7fcd55187aa943'

const readySenderStatus = {
  state: 'online' as const,
  platform: 'darwin',
  arch: 'arm64',
  sipDisabled: true,
  wechatRunning: true,
  wechatPid: 4668,
  boundWechatPid: 4668,
  endpoint: 'http://127.0.0.1:4290',
  endpointReady: true,
  runtimeReady: true,
  attachReady: true,
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
  message: '微信发送能力已连接，可以发送消息'
}

describe('PersonalWechatSendPage on macOS (port 4290 mode)', () => {
  beforeEach(() => {
    getSettings.mockReset().mockResolvedValue({
      settings: { windowsWechatPort: '' }
    })
    setSettings.mockReset().mockResolvedValue({
      settings: { windowsWechatPort: '4290' }
    })
    getSenderStatus.mockReset().mockResolvedValue(readySenderStatus)
    checkSenderStatus.mockReset().mockResolvedValue(readySenderStatus)
    getMacLicenseStatus.mockReset().mockResolvedValue({
      state: 'unlicensed',
      authorized: false,
      deviceId: TEST_DEVICE_ID,
      features: [],
      licenseExpiresAt: null,
      lastCheckedAt: null,
      message: ''
    })

    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getSettings,
        setSettings,
        getPersonalWechatSenderStatus: getSenderStatus,
        checkPersonalWechatSenderStatus: checkSenderStatus,
        getMacLicenseStatus
      }
    })
  })

  it('starts unconfigured when no port is saved', async () => {
    render(<PersonalWechatSendPage onNotice={vi.fn()} />)

    expect(await screen.findByText('尚未配置')).toBeVisible()
    expect(screen.getByText('macOS 接口配置')).toBeVisible()
    expect(screen.getByText('未配置')).toBeVisible()
    expect(screen.getByText('本机设备 ID')).toBeVisible()
    expect(await screen.findByText('mac_9d204eef…7aa943')).toBeVisible()
    expect(screen.getByRole('button', { name: '复制完整设备 ID' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: '绑定微信' })).not.toBeInTheDocument()
  })

  it('detects port 4290 and saves it to unlock sending capability', async () => {
    const onNotice = vi.fn()
    render(<PersonalWechatSendPage onNotice={onNotice} />)

    const input = await screen.findByLabelText('微信发送能力端口')
    fireEvent.change(input, { target: { value: '4290' } })
    fireEvent.click(screen.getByRole('button', { name: '检测' }))

    await waitFor(() => {
      expect(checkSenderStatus).toHaveBeenCalledWith('4290')
    })
    expect(onNotice).toHaveBeenCalledWith('已检测到微信发送能力，请点击保存')
    expect(await screen.findByText('微信发送能力已就绪')).toBeVisible()
    expect(screen.getAllByText('可发送')).toHaveLength(3)

    getSettings.mockResolvedValue({
      settings: { windowsWechatPort: '4290' }
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(setSettings).toHaveBeenCalledWith({ windowsWechatPort: '4290' })
    })
    expect(onNotice).toHaveBeenCalledWith('微信发送能力端口已保存')
  })

  it('loads saved port 4290 on startup and allows clearing the port', async () => {
    getSettings.mockResolvedValue({
      settings: { windowsWechatPort: '4290' }
    })
    const onNotice = vi.fn()
    render(<PersonalWechatSendPage onNotice={onNotice} />)

    expect(await screen.findByText('微信发送能力已就绪')).toBeVisible()
    expect(screen.getByText('已就绪')).toBeVisible()

    getSettings.mockResolvedValue({
      settings: { windowsWechatPort: '' }
    })
    fireEvent.click(screen.getByRole('button', { name: '清除端口' }))

    await waitFor(() => {
      expect(setSettings).toHaveBeenCalledWith({ windowsWechatPort: '' })
    })
    expect(onNotice).toHaveBeenCalledWith('微信发送能力端口已清除')
  })
})
