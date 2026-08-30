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
  endpoint: '127.0.0.1:58080',
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
  it.each([
    ['unsupported', status({ platform: 'linux' })],
    ['unconfigured', status({ runtimeReady: false, boundWechatPid: undefined })],
    ['needs_binding', status({ runtimeReady: true, boundWechatPid: undefined })],
    ['needs_verification', status({ boundWechatPid: 123 })],
    ['ready', status({ state: 'online', boundWechatPid: 123, canSendImage: true, canSend: true })],
    ['error', status({ state: 'error', boundWechatPid: 123, error: 'hook failed' })],
    ['needs_verification', status({ platform: 'win32', endpoint: '127.0.0.1:4567' })],
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
    const service = new PersonalWechatCapabilityService({ getStatus: async () => senderStatus })
    return expect(service.getPersonalWechatSendCapability()).resolves.toMatchObject({
      status: expected,
      ready: expected === 'ready',
      supported: expected !== 'unsupported'
    })
  })
})
