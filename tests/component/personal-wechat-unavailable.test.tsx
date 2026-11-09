import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { PersonalWechatSetupGuide } from '../../src/renderer/src/components/chat/PersonalWechatSetupGuide'
import { PersonalWechatSendPage } from '../../src/renderer/src/features/settings/pages/PersonalWechatSendPage'
import type { PersonalWechatSenderStatus } from '../../src/shared/personal-wechat'

vi.mock('../../src/renderer/src/utils/runtime-environment', () => ({
  isMac: true,
  isWindows: false,
  runtimePlatform: 'darwin',
  supportsPersonalWechatSend: true
}))

const unavailableStatus: PersonalWechatSenderStatus = {
  state: 'runtime_missing',
  platform: 'darwin',
  arch: 'arm64',
  sipDisabled: true,
  wechatRunning: false,
  endpoint: 'http://127.0.0.1:4290',
  endpointReady: false,
  runtimeReady: false,
  attachReady: false,
  baseAddressReady: false,
  textHookInstalled: false,
  textHookReady: false,
  imageHookInstalled: false,
  imageHookReady: false,
  messageListenerReady: false,
  canSend: false,
  canSendText: false,
  canSendImage: false,
  canSendVoice: false,
  message: '暂无发送能力',
  error: '暂无发送能力'
}

describe('personal WeChat unavailable product state', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getMacSendRuntimeAvailability: vi.fn(async () => ({
          state: 'available',
          message: '微信发送组件可用'
        })),
        getPersonalWechatSendCapability: vi.fn(async () => ({
          supported: true,
          ready: false,
          status: 'unconfigured',
          capabilities: { text: false, image: false, voice: false },
          senderStatus: unavailableStatus,
          message: '暂无发送能力',
          error: '暂无发送能力'
        })),
        getPersonalWechatSenderStatus: vi.fn(async () => unavailableStatus),
        getMacLicenseStatus: vi.fn(async () => ({
          deviceId: `mac_${'c'.repeat(64)}`,
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

  it('keeps the setup flow visible and disables binding when the runtime is unavailable', () => {
    render(
      <PersonalWechatSetupGuide
        senderStatus={unavailableStatus}
        binding={false}
        detecting={false}
        sessionBound={false}
        onBind={vi.fn()}
        onStartSending={vi.fn()}
      />
    )

    expect(screen.getByRole('heading', { name: '先准备好微信消息功能' })).toBeVisible()
    expect(screen.getByRole('button', { name: '绑定微信' })).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent('发送能力属授权制，需要联系群主')
    expect(screen.getByText(/发送能力属授权制，需要联系群主/)).toBeVisible()
    expect(screen.getByRole('link', { name: '这里' })).toHaveAttribute(
      'href',
      'https://github.com/Wxw-Gu/TraceMemo#-交流与反馈'
    )
    expect(screen.queryByRole('button', { name: '下载运行时' })).not.toBeInTheDocument()
    expect(screen.queryByText('查看支持的微信版本')).not.toBeInTheDocument()
    expect(screen.queryByText('高级诊断')).not.toBeInTheDocument()
    expect(screen.queryByText(/manifest|dylib|runtime missing|文件缺失/i)).not.toBeInTheDocument()
  })

  it('describes a ready runtime separately from pending send capability initialization', () => {
    const boundStatus: PersonalWechatSenderStatus = {
      ...unavailableStatus,
      state: 'hook_not_ready',
      wechatRunning: true,
      wechatPid: 4668,
      boundWechatPid: 4668,
      endpointReady: true,
      runtimeReady: true,
      attachReady: true,
      baseAddressReady: true,
      message: '已绑定，等待发送 hook 就绪'
    }

    render(
      <PersonalWechatSetupGuide
        senderStatus={boundStatus}
        binding={false}
        detecting={false}
        sessionBound
        showBindAction={false}
      />
    )

    expect(screen.getByText('微信已绑定，正在等待发送能力完成初始化…')).toBeVisible()
    expect(screen.queryByText('正在等待发送运行时完成初始化…')).not.toBeInTheDocument()
  })

  it('does not say the runtime is still initializing when it is ready but message capabilities are pending', () => {
    const boundButInitializing: PersonalWechatSenderStatus = {
      ...unavailableStatus,
      state: 'hook_not_ready',
      wechatRunning: true,
      wechatPid: 4668,
      boundWechatPid: 4668,
      endpointReady: true,
      runtimeReady: true,
      attachReady: true,
      baseAddressReady: true,
      message: '已绑定，等待发送 hook 就绪'
    }

    render(
      <PersonalWechatSetupGuide
        senderStatus={boundButInitializing}
        binding={false}
        detecting={false}
        sessionBound
        showBindAction={false}
        showBindingInstructionsInInitialization
      />
    )

    expect(screen.getByText('微信已绑定，正在等待发送能力完成初始化…')).toBeVisible()
    expect(screen.queryByText('正在等待发送运行时完成初始化…')).not.toBeInTheDocument()
  })

  it('shows the disabled binding flow on the settings page', async () => {
    render(<PersonalWechatSendPage onNotice={vi.fn()} />)

    expect(await screen.findByRole('heading', { name: '先准备好微信消息功能' })).toBeVisible()
    expect(screen.getByRole('button', { name: '授权后可绑定微信' })).toBeDisabled()
    expect(screen.getByRole('region', { name: '微信发送环境' })).toBeVisible()
    expect(screen.getByText('运行时正常')).toBeVisible()
    expect(screen.getByText('微信已绑定')).toBeVisible()
    expect(screen.getByText('发送组件正常')).toBeVisible()
    expect(screen.getByRole('button', { name: '首次使用配置' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(await screen.findByRole('region', { name: '发送能力授权' })).toBeVisible()
    expect(screen.queryByText(/发送能力属授权制，需要联系群主/)).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '这里' })).not.toBeInTheDocument()
    expect(screen.queryByText(/manifest|dylib|runtime missing|文件缺失/i)).not.toBeInTheDocument()
  })

  it('shows real environment status and keeps first-use details collapsed when ready', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getMacSendRuntimeAvailability: vi.fn(async () => ({
          state: 'available',
          message: '微信发送组件可用'
        })),
        getPersonalWechatSendCapability: vi.fn(async () => ({
          supported: true,
          ready: true,
          status: 'ready',
          capabilities: { text: true, image: true, voice: true },
          senderStatus: readyStatus,
          message: '已就绪'
        })),
        getPersonalWechatSenderStatus: vi.fn(async () => readyStatus),
        getMacLicenseStatus: vi.fn(async () => ({
          ...licenseStatus,
          state: 'revoked',
          authorized: false
        })),
        refreshMacLicense: vi.fn()
      }
    })

    render(<PersonalWechatSendPage onNotice={vi.fn()} />)

    expect(await screen.findByText('运行环境已就绪')).toBeVisible()
    expect(screen.getAllByText('正常')).toHaveLength(3)
    expect(screen.getByRole('button', { name: '授权后可开始发送' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '首次使用配置' })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    expect(screen.queryByRole('button', { name: '绑定微信' })).not.toBeInTheDocument()
    expect(await screen.findByText('授权已撤销')).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: '首次使用配置' }))
    expect(screen.getByRole('button', { name: '首次使用配置' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(screen.queryByRole('button', { name: '绑定微信' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '开始发送' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByText('每个微信进程只能绑定一次')).toBeVisible()
    expect(screen.getByText(/4\.1\.13以下请保持微信未登录窗口状态/)).toBeVisible()
    expect(screen.getByText('4.1.13以上登录状态微信直接点击“绑定微信”')).toBeVisible()
    expect(screen.queryByText('能力检测')).not.toBeInTheDocument()
    expect(screen.queryByText('文字消息')).not.toBeInTheDocument()
    expect(screen.queryByText('图片消息')).not.toBeInTheDocument()
    expect(screen.queryByText('语音消息')).not.toBeInTheDocument()
  })

  it('copies the full device id and shows refresh loading without disabling copy', async () => {
    const deviceId = `mac_${'a'.repeat(64)}`
    let resolveRefresh: ((value: typeof licenseStatus) => void) | undefined
    const refreshMacLicense = vi.fn(
      () => new Promise<typeof licenseStatus>((resolve) => (resolveRefresh = resolve))
    )
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) }
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getMacSendRuntimeAvailability: vi.fn(async () => ({
          state: 'available',
          message: '微信发送组件可用'
        })),
        getPersonalWechatSendCapability: vi.fn(async () => ({
          supported: true,
          ready: false,
          status: 'unconfigured',
          capabilities: { text: false, image: false, voice: false },
          senderStatus: readyStatus,
          message: '未配置'
        })),
        getPersonalWechatSenderStatus: vi.fn(async () => readyStatus),
        getMacLicenseStatus: vi.fn(async () => ({ ...licenseStatus, deviceId, state: 'expired' })),
        refreshMacLicense
      }
    })

    render(<PersonalWechatSendPage onNotice={vi.fn()} />)
    const copyButton = await screen.findByRole('button', { name: '复制完整设备 ID' })
    fireEvent.click(copyButton)
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(deviceId))
    expect(await screen.findByText('授权状态需刷新')).toBeVisible()
    expect(
      screen.getByText('当前授权状态与到期日不一致，请点击「重新检测授权」更新状态。')
    ).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: '重新检测授权' }))
    expect(await screen.findByRole('button', { name: '检测中…' })).toBeDisabled()
    expect(copyButton).toBeEnabled()
    resolveRefresh?.({ ...licenseStatus, deviceId, state: 'valid', authorized: true })
    expect(await screen.findByText('设备已授权')).toBeVisible()
    expect(screen.queryByText('授权状态需刷新')).not.toBeInTheDocument()
  })

  it('does not query or render License when the send runtime is unavailable', async () => {
    const getMacLicenseStatus = vi.fn()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getMacSendRuntimeAvailability: vi.fn(async () => ({
          state: 'unavailable',
          message: '当前版本没有微信发送能力'
        })),
        getMacLicenseStatus,
        getPersonalWechatSendCapability: vi.fn(),
        getPersonalWechatSenderStatus: vi.fn()
      }
    })

    render(<PersonalWechatSendPage onNotice={vi.fn()} />)

    expect(await screen.findByRole('button', { name: '当前版本没有微信发送能力' })).toBeDisabled()
    expect(screen.getByText(/发送能力属授权制，需要联系群主/)).toBeVisible()
    expect(screen.getByRole('link', { name: '这里' })).toHaveAttribute(
      'href',
      'https://github.com/Wxw-Gu/TraceMemo#-交流与反馈'
    )
    expect(screen.queryByRole('region', { name: '发送能力授权' })).not.toBeInTheDocument()
    expect(getMacLicenseStatus).not.toHaveBeenCalled()
  })

  it('shows component failure without querying License when send runtime files are damaged', async () => {
    const getMacLicenseStatus = vi.fn()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getMacSendRuntimeAvailability: vi.fn(async () => ({
          state: 'component_error',
          message: '发送组件缺失或异常：manifest missing'
        })),
        getMacLicenseStatus,
        getPersonalWechatSendCapability: vi.fn(),
        getPersonalWechatSenderStatus: vi.fn()
      }
    })

    render(<PersonalWechatSendPage onNotice={vi.fn()} />)

    expect(await screen.findByRole('button', { name: '发送组件缺失或异常' })).toBeDisabled()
    expect(screen.getAllByText('发送组件缺失或异常').length).toBeGreaterThan(0)
    expect(screen.queryByText(/发送能力属授权制，需要联系群主/)).not.toBeInTheDocument()
    expect(getMacLicenseStatus).not.toHaveBeenCalled()
    expect(screen.queryByRole('region', { name: '发送能力授权' })).not.toBeInTheDocument()
  })
})

const readyStatus: PersonalWechatSenderStatus = {
  ...unavailableStatus,
  state: 'online',
  wechatRunning: true,
  wechatPid: 1234,
  boundWechatPid: 1234,
  endpointReady: true,
  runtimeReady: true,
  attachReady: true,
  baseAddressReady: true,
  canSend: true,
  canSendText: true,
  canSendImage: true,
  canSendVoice: true
}

const licenseStatus = {
  deviceId: `mac_${'b'.repeat(64)}`,
  state: 'valid' as const,
  authorized: true,
  source: 'online' as const,
  features: ['wechat', 'api'],
  lastCheckedAt: '2026-11-04T09:44:00+08:00',
  licenseExpiresAt: '2027-11-03T00:00:00+08:00',
  tokenExpiresAt: null,
  message: '已授权'
}
