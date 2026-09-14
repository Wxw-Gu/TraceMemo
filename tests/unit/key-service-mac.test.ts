import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/tracememo-key-service-test')
  }
}))

import { parseXkeyHelperOutput } from '../../src/main/key-service-mac'

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
        '已完成管理员授权，但监听期间微信没有触发数据库密钥写入。请先停留在微信登录界面，在 TraceMemo 点击“自动获取密钥”，授权后立即登录微信。'
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
})
