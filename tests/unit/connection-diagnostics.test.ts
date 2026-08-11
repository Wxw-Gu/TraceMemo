import { describe, expect, it } from 'vitest'
import { buildSafeDiagnosticSummary } from '../../src/shared/connection-diagnostics'

describe('connection diagnostics', () => {
  it('contains useful versions and readiness without secrets or full account paths', () => {
    const summary = buildSafeDiagnosticSummary({
      platform: 'win32',
      osVersion: 'Windows 11 fixture',
      appVersion: 'v2.1.6',
      wechatVersion: '4.1.9.57',
      dataStructureVersion: '微信 4.x（WCDB）',
      dataDirectoryDetected: true,
      autoDetectSupported: true,
      wechatRunning: true,
      accountIdentified: true,
      dbConnected: false,
      encryptionAvailable: true
    })

    expect(summary).toContain('TraceMemo: v2.1.6')
    expect(summary).toContain('微信客户端: 4.1.9.57')
    expect(summary).not.toContain('0123456789abcdef')
    expect(summary).not.toContain('C:\\Users\\fixture\\xwechat_files\\wxid_secret')
    expect(summary).not.toContain('wxid_')
  })
})
