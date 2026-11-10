import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
const listResidualProcesses = vi.fn()
const cleanupResidualProcesses = vi.fn()
const startMacRuntime = vi.fn()
const getMacLicenseStatus = vi.fn()

const senderStatus = {
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
    listResidualProcesses.mockReset().mockResolvedValue([
      {
        pid: 202,
        name: 'tm-wechat-host',
        targets: ['port_4290'],
        confirmationToken: 'process-identity-202'
      }
    ])
    cleanupResidualProcesses.mockReset().mockResolvedValue({
      stopped: [
        {
          pid: 202,
          name: 'tm-wechat-host',
          targets: ['port_4290'],
          confirmationToken: 'process-identity-202'
        }
      ],
      remaining: [],
      runtimeStopped: true
    })
    startMacRuntime.mockReset().mockResolvedValue({ lifecycle: 'online' })
    getMacLicenseStatus.mockReset().mockResolvedValue({
      deviceId: null,
      state: 'unlicensed',
      authorized: false,
      source: 'none',
      features: [],
      lastCheckedAt: null,
      licenseExpiresAt: null,
      tokenExpiresAt: null,
      message: '当前设备暂无发送能力授权'
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getPersonalWechatSendCapability: getCapability,
        getPersonalWechatSenderStatus: getSenderStatus,
        rebindPersonalWechatSender: rebindSender,
        listMacWechatResidualProcesses: listResidualProcesses,
        cleanupMacWechatResidualProcesses: cleanupResidualProcesses,
        startMacSendRuntime: startMacRuntime,
        // 发送能力授权卡所需的两个入口。页面在 Native 档位会调用它们，
        // 缺 mock 会让 refresh 抛错、整页停在错误态。
        getMacSendRuntimeAvailability: vi.fn(async () => ({
          state: 'available',
          message: '微信发送组件可用'
        })),
        getMacLicenseStatus,
        refreshMacLicense: vi.fn()
      }
    })
  })

  it('shows the native runtime readiness', async () => {
    render(<PersonalWechatSendPage onNotice={vi.fn()} />)

    // 页面重构后「就绪」的落点从 SetupGuide 尾部文案变成了「微信发送环境」卡片的状态标签；
    // 断言改到新位置，语义仍是“运行时准备好了”。
    expect(await screen.findByText('运行环境已就绪')).toBeVisible()
    expect(
      screen.getByText('当前发送能力占用端口为 4290（TM_WECHAT_HOST_PORT）。')
    ).toBeVisible()
    expect(await screen.findByText('已被占用：tm-wechat-host（PID 202）')).toBeVisible()
    expect(screen.getAllByText('已就绪')).not.toHaveLength(0)
    expect(screen.queryByText('查看支持的微信版本')).not.toBeInTheDocument()
    expect(screen.queryByText('高级诊断')).not.toBeInTheDocument()
  })

  it('shows the actual runtime port when it uses a configured fallback instead of 4290', async () => {
    const fallbackPortStatus = { ...senderStatus, endpoint: 'http://127.0.0.1:4291' }
    getCapability.mockResolvedValueOnce({ ...capability, senderStatus: fallbackPortStatus })
    getSenderStatus.mockResolvedValueOnce(fallbackPortStatus)
    listResidualProcesses.mockResolvedValueOnce([])

    render(<PersonalWechatSendPage onNotice={vi.fn()} />)

    expect(
      await screen.findByText(
        '当前发送能力占用端口为 4291（TM_WECHAT_HOST_PORT）。'
      )
    ).toBeVisible()
    expect(screen.getByText('未被占用')).toBeVisible()
  })

  it('shows confirmed cleanup targets before ending processes', async () => {
    const onNotice = vi.fn()
    render(<PersonalWechatSendPage onNotice={onNotice} />)

    await screen.findByText('运行环境已就绪')
    fireEvent.click(screen.getByRole('button', { name: '清理残留以及微信进程' }))

    expect(await screen.findByRole('heading', { name: '清理微信残留进程？' })).toBeVisible()
    expect(screen.getByText('tm-wechat-host')).toBeVisible()
    expect(screen.getByText(/PID 202.*4290 端口/)).toBeVisible()
    expect(cleanupResidualProcesses).not.toHaveBeenCalled()
  })

  it('cleans only the process the user confirmed and refreshes the runtime state', async () => {
    const onNotice = vi.fn()
    render(<PersonalWechatSendPage onNotice={onNotice} />)

    await screen.findByText('运行环境已就绪')
    fireEvent.click(screen.getByRole('button', { name: '清理残留以及微信进程' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认结束进程' }))

    await waitFor(() => {
      expect(cleanupResidualProcesses).toHaveBeenCalledWith([
        { pid: 202, confirmationToken: 'process-identity-202' }
      ])
    })
    expect(onNotice).toHaveBeenCalledWith('已结束 1 个残留进程；发送环境状态已刷新。')
    expect(await screen.findByRole('button', { name: '重新启动发送组件' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '重新启动发送组件' }))
    await waitFor(() => expect(startMacRuntime).toHaveBeenCalledOnce())
  })

  it('shows that WeChat must be reopened and rebound after its process is cleaned', async () => {
    listResidualProcesses.mockResolvedValueOnce([
      {
        pid: 4668,
        name: 'WeChat',
        targets: ['wechat'],
        confirmationToken: 'wechat-process-4668'
      }
    ])
    cleanupResidualProcesses.mockResolvedValueOnce({
      stopped: [
        {
          pid: 4668,
          name: 'WeChat',
          targets: ['wechat'],
          confirmationToken: 'wechat-process-4668'
        }
      ],
      remaining: [],
      runtimeStopped: false
    })
    rebindSender.mockResolvedValueOnce({
      ...senderStatus,
      state: 'stopped',
      wechatRunning: true,
      wechatPid: undefined,
      boundWechatPid: undefined,
      canSend: false
    })
    const stoppedStatus = {
      ...senderStatus,
      state: 'stopped',
      wechatRunning: false,
      wechatPid: undefined,
      boundWechatPid: undefined,
      attachReady: false,
      baseAddressReady: false,
      canSend: false,
      canSendText: false,
      canSendImage: false,
      canSendVoice: false
    }
    getSenderStatus.mockReset().mockResolvedValueOnce(senderStatus).mockResolvedValue(stoppedStatus)
    getMacLicenseStatus.mockResolvedValue({
      deviceId: 'mac_test',
      state: 'valid',
      authorized: true,
      source: 'online',
      features: ['wechat'],
      lastCheckedAt: new Date().toISOString(),
      licenseExpiresAt: null,
      tokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      message: '设备已授权'
    })
    const onNotice = vi.fn()
    render(<PersonalWechatSendPage onNotice={onNotice} />)

    await screen.findByText('运行环境已就绪')
    fireEvent.click(screen.getByRole('button', { name: '清理残留以及微信进程' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认结束进程' }))

    expect(
      await screen.findByText(
        '微信进程已清理。请重新打开微信，然后点击“绑定微信”；绑定完成后此提示会自动消失。'
      )
    ).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '绑定微信' }))
    await waitFor(() => expect(rebindSender).toHaveBeenCalledOnce())
    expect(
      screen.getByText(
        '微信进程已清理。请重新打开微信，然后点击“绑定微信”；绑定完成后此提示会自动消失。'
      )
    ).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '绑定微信' }))
    await waitFor(() => expect(rebindSender).toHaveBeenCalledTimes(2))
    expect(
      screen.queryByText(
        '微信进程已清理。请重新打开微信，然后点击“绑定微信”；绑定完成后此提示会自动消失。'
      )
    ).not.toBeInTheDocument()
  })
})
