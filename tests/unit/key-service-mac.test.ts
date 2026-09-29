import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/tracememo-key-service-test')
  }
}))

import {
  SIP_ENABLED_ERROR,
  buildAppleSiliconXkeyInvocation,
  buildXkeyHelperArguments,
  mapXkeyHelperFailure,
  parseSipEnabled,
  parseXkeyHelperOutput,
  resolveXkeyHelperMode
} from '../../src/main/key-service-mac'

describe('parseXkeyHelperOutput', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns a valid helper key without exposing progress output', () => {
    const key = 'ab'.repeat(32)
    expect(
      parseXkeyHelperOutput(`progress line\n${JSON.stringify({ success: true, key })}`)
    ).toEqual({ success: true, key })
  })

  it('maps a login-time capture timeout to an actionable message', () => {
    const result = parseXkeyHelperOutput(
      JSON.stringify({
        success: false,
        result:
          'sink found at 0x1234\nsoftware breakpoint unavailable\nhardware breakpoint armed\ntimeout waiting for breakpoint hit'
      })
    )

    expect(result).toEqual({
      success: false,
      code: 'CAPTURE_TIMEOUT',
      error:
        '已完成管理员授权，但监听期间微信没有触发账号密钥派生。请先停留在微信登录界面，在 TraceMemo 点击“自动获取密钥”，授权后点击微信“登录”；已有登录凭据时通常不需要扫码。'
    })
  })

  it('does not expose raw helper diagnostics for an unknown failure', () => {
    const result = parseXkeyHelperOutput(
      JSON.stringify({
        success: false,
        result: 'private diagnostic /Users/example/source/xkey.mm:123'
      })
    )

    expect(result).toEqual({
      success: false,
      code: 'HELPER_RESULT_INVALID',
      error: '密钥工具未返回有效密钥，请确认微信仍在运行后重试。'
    })
    expect(result.error).not.toContain('/Users/example')
  })

  it('sanitizes diagnostics returned through an AppleScript command error', () => {
    const result = mapXkeyHelperFailure(
      'sink found at 0x1234\nhardware breakpoint armed on 81/81 threads\nWAIT_FAILED:no_breakpoint_hit',
      'OSASCRIPT_1'
    )

    expect(result).toEqual({
      success: false,
      code: 'CAPTURE_TIMEOUT',
      error:
        '已完成管理员授权，但监听期间微信没有触发账号密钥派生。请先停留在微信登录界面，在 TraceMemo 点击“自动获取密钥”，授权后点击微信“登录”；已有登录凭据时通常不需要扫码。'
    })
  })

  it.each([
    ['4.1.8', 'legacy'],
    ['4.1.9.57', 'legacy'],
    ['4.1.10', 'legacy'],
    ['4.1.13', 'wechat-4.1.13'],
    ['4.1.13.91', 'wechat-4.1.13'],
    ['4.1.130', 'legacy'],
    ['未检测到', 'legacy']
  ])('selects the helper mode for WeChat %s', (version, mode) => {
    expect(resolveXkeyHelperMode(version)).toBe(mode)
  })

  it('builds the verified 4.1.13 account-key capture contract', () => {
    expect(buildXkeyHelperArguments(60037, 120_000)).toEqual([
      '60037',
      '120000',
      '--profile',
      'wechat-4.1.13',
      '--account'
    ])
  })

  it('uses the new helper only for WeChat 4.1.13', () => {
    expect(buildAppleSiliconXkeyInvocation('4.1.13.91', 60037, 60_000)).toEqual({
      mode: 'wechat-4.1.13',
      resourceName: 'xkey_helper_4_1_13',
      args: ['60037', '120000', '--profile', 'wechat-4.1.13', '--account'],
      waitMs: 120_000,
      timeoutSeconds: 130,
      execTimeoutMs: 135_000
    })
  })

  it.each(['4.1.8', '4.1.9.57', '4.1.10', '未检测到'])(
    'preserves the legacy helper invocation for WeChat %s',
    (version) => {
      expect(buildAppleSiliconXkeyInvocation(version, 60037, 60_000)).toEqual({
        mode: 'legacy',
        resourceName: 'xkey_helper',
        args: ['60037', '60000'],
        waitMs: 60_000,
        timeoutSeconds: 90,
        execTimeoutMs: 80_000
      })
    }
  )

  it('extracts a helper error embedded in AppleScript diagnostics', () => {
    expect(
      mapXkeyHelperFailure(
        'hardware breakpoint armed\n{"success":false,"result":"ERROR:HOOK_FAILED:ptrace"}',
        'OSASCRIPT_1'
      )
    ).toEqual({
      success: false,
      code: 'HOOK_FAILED',
      error: '密钥工具执行未完成（HOOK_FAILED），请确认微信仍在运行后重试。'
    })
  })
})

describe('parseSipEnabled', () => {
  it.each<[string, boolean]>([
    ['System Integrity Protection status: enabled.', true],
    ['System Integrity Protection status: disabled.', false],
    ['System Integrity Protection status: unknown (Custom Configuration).', false],
    ['System Integrity Protection status: enabled (Apple Internal).', true],
    ['System Integrity Protection status: disabled (Apple Internal).', false]
  ])('reads "%s" as %s', (statusOutput, expected) => {
    expect(parseSipEnabled(statusOutput)).toBe(expected)
  })

  it('only reads the status field, not the word enabled elsewhere in the output', () => {
    expect(
      parseSipEnabled('System Integrity Protection status: disabled.\nKernel Extensions: enabled')
    ).toBe(false)
  })
})

describe('SIP blocking message', () => {
  it('names the prerequisite and the next action', () => {
    expect(SIP_ENABLED_ERROR).toContain('SIP')
    expect(SIP_ENABLED_ERROR).toMatch(/关闭 SIP|手动粘贴/)
  })
})
