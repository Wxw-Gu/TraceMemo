import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/fixture/app',
    isPackaged: false
  }
}))

import {
  deriveMacWechatSenderStatus,
  shouldClearWechatRestartRequired
} from '../../src/main/services/mac-wechat-runtime-manager'
import type {
  MacWechatBindingStatus,
  MacWechatRuntimeManifest,
  MacWechatRuntimeSnapshot
} from '../../src/shared/personal-wechat-mac-runtime'

const AGENT_HASH = 'a'.repeat(64)
const ADDRESS_PROFILE_HASH = 'b'.repeat(64)

const manifest: MacWechatRuntimeManifest = {
  runtime: 'tm-wechat-native',
  version: '0.1.0',
  platform: 'darwin-arm64',
  architecture: 'arm64',
  protocolVersion: 1,
  buildCommit: 'test',
  tmSendSourceSha256: AGENT_HASH,
  addressProfileSha256: ADDRESS_PROFILE_HASH,
  supportedWechatVersions: ['4.1.11.53'],
  capabilities: ['text', 'image', 'voice']
}

function snapshot(overrides: Partial<MacWechatRuntimeSnapshot> = {}): MacWechatRuntimeSnapshot {
  return {
    lifecycle: 'online',
    wechatRestartRequired: false,
    endpoint: 'http://127.0.0.1:4290',
    port: 4290,
    manifest,
    ...overrides
  }
}

function binding(overrides: Partial<MacWechatBindingStatus> = {}): MacWechatBindingStatus {
  return {
    runtime: true,
    hostPid: 123,
    runtimeState: 'ready',
    runtimeVersion: 'tm-wechat-runtime/0.1.0',
    embeddedAgentSha256: AGENT_HASH,
    embeddedAddressProfileSha256: ADDRESS_PROFILE_HASH,
    wechatRunning: true,
    wechatPid: 456,
    wechatVersion: '4.1.11.53',
    supported: true,
    bindingState: 'ready',
    bound: true,
    boundWechatPid: 456,
    sessionAttached: true,
    scriptLoaded: true,
    sendContextReady: true,
    canSendText: true,
    canSendImage: true,
    canSendVoice: true,
    attachCount: 1,
    ...overrides
  }
}

describe('macOS native runtime sender status mapping', () => {
  it('exposes capabilities only for a ready binding with matching runtime identity', () => {
    expect(
      deriveMacWechatSenderStatus({ snapshot: snapshot(), binding: binding(), manifest })
    ).toMatchObject({
      state: 'online',
      runtimeReady: true,
      attachReady: true,
      baseAddressReady: true,
      messageListenerReady: true,
      canSend: true,
      canSendText: true,
      canSendImage: true,
      canSendVoice: true
    })
  })

  it('rejects a live host whose embedded runtime identity does not match the manifest', () => {
    const status = deriveMacWechatSenderStatus({
      snapshot: snapshot(),
      binding: binding({ embeddedAgentSha256: 'b'.repeat(64) }),
      manifest
    })

    expect(status).toMatchObject({
      state: 'error',
      runtimeReady: false,
      canSend: false,
      canSendText: false,
      canSendImage: false,
      canSendVoice: false
    })
    expect(status.error).toContain('Native Runtime 不一致')
  })

  it('maps a stale binding to a rebind-required stopped state', () => {
    expect(
      deriveMacWechatSenderStatus({
        snapshot: snapshot(),
        binding: binding({ bindingState: 'stale', sendContextReady: false }),
        manifest
      })
    ).toMatchObject({
      state: 'stopped',
      message: '检测到微信已重启，请重新绑定',
      canSend: false
    })
  })

  it('keeps restart-required errors above otherwise ready binding state', () => {
    expect(
      deriveMacWechatSenderStatus({
        snapshot: snapshot({ wechatRestartRequired: true }),
        binding: binding(),
        manifest
      })
    ).toMatchObject({ state: 'error', canSend: false })
  })

  it('clears restart-required only after WeChat has a different positive pid', () => {
    expect(shouldClearWechatRestartRequired(100, 200)).toBe(true)
    expect(shouldClearWechatRestartRequired(100, 100)).toBe(false)
    expect(shouldClearWechatRestartRequired(0, 200)).toBe(false)
    expect(shouldClearWechatRestartRequired(100, 0)).toBe(false)
  })
})
