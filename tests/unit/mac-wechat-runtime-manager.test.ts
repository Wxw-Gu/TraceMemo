import { describe, expect, it } from 'vitest'

import {
  deriveMacWechatSenderStatus,
  formatMacWechatHostStartupFailure,
  MacWechatRuntimeManager,
  resolveMacWechatSendMechanism
} from '../../src/main/services/mac-wechat-runtime-manager'
import type {
  MacWechatBindingStatus,
  MacWechatRuntimeManifest,
  MacWechatRuntimeSnapshot
} from '../../src/shared/personal-wechat-mac-runtime'

const AGENT_HASH = 'a'.repeat(64)
const PROFILE_HASH = 'b'.repeat(64)
const MESSAGE_SOURCE_WECHAT_VERSION = 'fixture-message-source-version'
const NATIVE_OBJECT_WECHAT_VERSION = 'fixture-native-object-version'
const LEGACY_WECHAT_VERSION = 'fixture-legacy-version'

function manifest(wechatVersion: string, textMechanism: string): MacWechatRuntimeManifest {
  return {
    runtime: 'tm-wechat-native',
    version: '0.3.0',
    platform: 'darwin-arm64',
    architecture: 'arm64',
    protocolVersion: 1,
    buildCommit: 'fixture-build',
    tmSendSourceSha256: AGENT_HASH,
    addressProfileSha256: PROFILE_HASH,
    supportedWechatVersions: [wechatVersion],
    capabilities: ['text', 'image', 'voice'],
    capabilitiesByVersion: {
      [wechatVersion]: {
        text: 'verified',
        image: 'verified',
        voice: 'verified',
        textMechanism
      }
    }
  }
}

function snapshot(overrides: Partial<MacWechatRuntimeSnapshot> = {}): MacWechatRuntimeSnapshot {
  return {
    lifecycle: 'online',
    wechatRestartRequired: false,
    endpoint: 'http://127.0.0.1:4290',
    port: 4290,
    ...overrides
  }
}

function binding(
  wechatVersion: string,
  overrides: Partial<MacWechatBindingStatus> = {}
): MacWechatBindingStatus {
  return {
    runtime: true,
    hostPid: 800,
    runtimeState: 'ready',
    runtimeVersion: 'tm-wechat-runtime/0.3.0',
    embeddedAgentSha256: AGENT_HASH,
    embeddedAddressProfileSha256: PROFILE_HASH,
    wechatRunning: true,
    wechatPid: 900,
    wechatVersion,
    supported: true,
    bindingState: 'bound',
    bound: true,
    boundWechatPid: 900,
    sessionAttached: true,
    scriptLoaded: true,
    sendContextReady: false,
    canSendText: true,
    canSendImage: true,
    canSendVoice: true,
    attachCount: 1,
    ...overrides
  }
}

class ConcurrentStartManager extends MacWechatRuntimeManager {
  startCalls = 0
  private resolveStart: ((snapshot: MacWechatRuntimeSnapshot) => void) | null = null

  protected override ensureStartedOnce(): Promise<MacWechatRuntimeSnapshot> {
    this.startCalls += 1
    return new Promise((resolve) => {
      this.resolveStart = resolve
    })
  }

  finishStart(result: MacWechatRuntimeSnapshot): void {
    this.resolveStart?.(result)
  }
}

describe('deriveMacWechatSenderStatus', () => {
  it('shows the Native Host startup diagnostic instead of only exit code 1', () => {
    expect(formatMacWechatHostStartupFailure(1, 'bind 127.0.0.1:4290 failed: Address already in use\n'))
      .toBe('发送运行时启动失败（进程退出码 1）：bind 127.0.0.1:4290 failed: Address already in use')
  })

  it('shares one in-flight start promise with concurrent status reads', async () => {
    const manager = new ConcurrentStartManager()

    const first = manager.ensureStarted()
    const second = manager.ensureStarted()

    expect(manager.startCalls).toBe(1)
    manager.finishStart(snapshot())
    await expect(Promise.all([first, second])).resolves.toEqual([snapshot(), snapshot()])
  })

  it('resolves the send mechanism only for a binding that matches the runtime manifest', () => {
    const currentBinding = binding(MESSAGE_SOURCE_WECHAT_VERSION)
    const currentManifest = manifest(MESSAGE_SOURCE_WECHAT_VERSION, 'tm-message-source-send')

    expect(resolveMacWechatSendMechanism(currentBinding, currentManifest)).toBe(
      'tm-message-source-send'
    )
    expect(
      resolveMacWechatSendMechanism(
        { ...currentBinding, embeddedAgentSha256: 'c'.repeat(64) },
        currentManifest
      )
    ).toBeUndefined()
    expect(resolveMacWechatSendMechanism(null, currentManifest)).toBeUndefined()
  })

  it('marks message-source sending ready without a captured send context', () => {
    const result = deriveMacWechatSenderStatus({
      snapshot: snapshot(),
      binding: binding(MESSAGE_SOURCE_WECHAT_VERSION),
      manifest: manifest(MESSAGE_SOURCE_WECHAT_VERSION, 'tm-message-source-send'),
      arch: 'arm64'
    })

    expect(result).toMatchObject({
      state: 'online',
      runtimeReady: true,
      attachReady: true,
      messageListenerReady: true,
      canSend: true,
      canSendText: true,
      canSendImage: true,
      canSendVoice: true
    })
  })

  it('keeps native message-object readiness unchanged', () => {
    const result = deriveMacWechatSenderStatus({
      snapshot: snapshot(),
      binding: binding(NATIVE_OBJECT_WECHAT_VERSION),
      manifest: manifest(NATIVE_OBJECT_WECHAT_VERSION, 'native-msg-object'),
      arch: 'arm64'
    })

    expect(result.state).toBe('online')
    expect(result.canSend).toBe(true)
  })

  it('continues waiting for the captured context on the legacy mechanism', () => {
    const result = deriveMacWechatSenderStatus({
      snapshot: snapshot(),
      binding: binding(LEGACY_WECHAT_VERSION),
      manifest: manifest(LEGACY_WECHAT_VERSION, 'legacy-req2buf'),
      arch: 'arm64'
    })

    expect(result.state).toBe('hook_not_ready')
    expect(result.canSend).toBe(false)
  })

  it('surfaces a crashed host as an error instead of an unbound runtime check', () => {
    const result = deriveMacWechatSenderStatus({
      snapshot: snapshot({
        lifecycle: 'crashed_unbound',
        error: '发送运行时启动失败（进程退出码 1）'
      }),
      binding: null,
      manifest: manifest(MESSAGE_SOURCE_WECHAT_VERSION, 'tm-message-source-send'),
      arch: 'arm64'
    })

    expect(result).toMatchObject({
      state: 'error',
      runtimeReady: false,
      endpointReady: false,
      message: '发送运行时启动失败（进程退出码 1）'
    })
  })

  it('surfaces stopped startup failures instead of an unbound runtime check', () => {
    const result = deriveMacWechatSenderStatus({
      snapshot: snapshot({ lifecycle: 'stopped', error: 'runtime host missing' }),
      binding: null,
      manifest: manifest(MESSAGE_SOURCE_WECHAT_VERSION, 'tm-message-source-send'),
      arch: 'arm64'
    })

    expect(result).toMatchObject({
      state: 'error',
      runtimeReady: false,
      endpointReady: false,
      message: 'runtime host missing'
    })
  })

  it.each([
    ['session is not attached', { sessionAttached: false }],
    ['agent script is not loaded', { scriptLoaded: false }],
    ['runtime is still initializing', { runtimeState: 'initializing' as const }]
  ])('does not mark the message-source mechanism ready when %s', (_reason, overrides) => {
    const result = deriveMacWechatSenderStatus({
      snapshot: snapshot(),
      binding: binding(MESSAGE_SOURCE_WECHAT_VERSION, overrides),
      manifest: manifest(MESSAGE_SOURCE_WECHAT_VERSION, 'tm-message-source-send'),
      arch: 'arm64'
    })

    expect(result.state).toBe('hook_not_ready')
    expect(result.canSend).toBe(false)
  })
})
