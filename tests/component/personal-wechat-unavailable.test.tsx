import { render, screen } from '@testing-library/react'
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
        getPersonalWechatSendCapability: vi.fn(async () => ({
          supported: true,
          ready: false,
          status: 'unconfigured',
          capabilities: { text: false, image: false, voice: false },
          senderStatus: unavailableStatus,
          message: '暂无发送能力',
          error: '暂无发送能力'
        })),
        getPersonalWechatSenderStatus: vi.fn(async () => unavailableStatus)
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

  it('shows the disabled binding flow on the settings page', async () => {
    render(<PersonalWechatSendPage onNotice={vi.fn()} />)

    expect(await screen.findByRole('heading', { name: '先准备好微信消息功能' })).toBeVisible()
    expect(screen.getByRole('button', { name: '绑定微信' })).toBeDisabled()
    expect(screen.getByText(/发送能力属授权制，需要联系群主/)).toBeVisible()
    expect(screen.getByRole('link', { name: '这里' })).toHaveAttribute(
      'href',
      'https://github.com/Wxw-Gu/TraceMemo#-交流与反馈'
    )
    expect(screen.queryByText(/manifest|dylib|runtime missing|文件缺失/i)).not.toBeInTheDocument()
  })
})
