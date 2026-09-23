import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/tracememo-test-user-data' } }))
import { PersonalWechatCapabilityService } from '../../src/main/services/personal-wechat-capability-service'
import type { PersonalWechatSenderStatus } from '../../src/shared/personal-wechat'

const status = (
  overrides: Partial<PersonalWechatSenderStatus> = {}
): PersonalWechatSenderStatus => ({
  state: 'hook_not_ready',
  platform: 'darwin',
  arch: 'arm64',
  sipDisabled: true,
  wechatRunning: true,
  wechatPid: 123,
  endpoint: '127.0.0.1:4290',
  endpointReady: true,
  runtimeReady: true,
  attachReady: true,
  baseAddressReady: true,
  textHookInstalled: true,
  textHookReady: false,
  imageHookInstalled: true,
  imageHookReady: false,
  messageListenerReady: true,
  canSend: false,
  canSendText: false,
  canSendImage: false,
  canSendVoice: false,
  message: 'pending',
  ...overrides
})

describe('PersonalWechatCapabilityService', () => {
  it('uses only the native runtime status on macOS', async () => {
    const legacyGetStatus = vi.fn(async () => status({ state: 'error' }))
    const nativeStatus = status({
      state: 'online',
      boundWechatPid: 123,
      canSend: true,
      canSendText: true
    })
    const service = new PersonalWechatCapabilityService(
      { getStatus: legacyGetStatus },
      'darwin',
      async () => nativeStatus
    )

    await expect(service.getPersonalWechatSendCapability()).resolves.toMatchObject({
      status: 'ready',
      capabilities: { text: true }
    })
    expect(legacyGetStatus).not.toHaveBeenCalled()
  })

  it.each([
    ['unsupported', status({ platform: 'linux' })],
    ['unconfigured', status({ runtimeReady: false, boundWechatPid: undefined })],
    ['needs_binding', status({ runtimeReady: true, boundWechatPid: undefined })],
    ['needs_binding', status({ runtimeReady: true, boundWechatPid: 999 })],
    ['initializing', status({ boundWechatPid: 123 })],
    ['ready', status({ state: 'online', boundWechatPid: 123, canSendImage: true, canSend: true })],
    [
      'ready',
      status({
        state: 'online',
        boundWechatPid: 123,
        canSend: true,
        canSendText: true,
        canSendImage: false,
        canSendVoice: true
      })
    ],
    ['error', status({ state: 'error', boundWechatPid: 123, error: 'hook failed' })],
    ['initializing', status({ platform: 'win32', endpoint: '127.0.0.1:4567' })],
    [
      'ready',
      status({
        platform: 'win32',
        state: 'online',
        endpoint: '127.0.0.1:4567',
        canSend: true,
        canSendText: true,
        canSendImage: true,
        canSendVoice: true
      })
    ]
  ])('maps %s', (expected, senderStatus) => {
    const service = new PersonalWechatCapabilityService(
      { getStatus: async () => senderStatus },
      senderStatus.platform as NodeJS.Platform,
      async () => senderStatus
    )
    return expect(service.getPersonalWechatSendCapability()).resolves.toMatchObject({
      status: expected,
      ready: expected === 'ready',
      supported: expected !== 'unsupported'
    })
  })
})
