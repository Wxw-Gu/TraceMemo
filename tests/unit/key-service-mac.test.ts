import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd()
  },
  safeStorage: { isEncryptionAvailable: () => false }
}))

import {
  KeyServiceMac,
  MAC_INTEL_HELPER_RESOURCE_PATH,
  parseMacKeyHelperOutput
} from '../../src/main/key-service-mac'

const originalResourcesPath = process.env.TRACEMEMO_RESOURCES_PATH

afterEach(() => {
  if (originalResourcesPath === undefined) delete process.env.TRACEMEMO_RESOURCES_PATH
  else process.env.TRACEMEMO_RESOURCES_PATH = originalResourcesPath
})

describe('mac key helper JSONL contract', () => {
  it('uses the packaged macOS resource path', () => {
    expect(MAC_INTEL_HELPER_RESOURCE_PATH).toBe('macos/mac-key-helper/mac_key_helper')
  })

  it('accepts a valid result after progress messages', () => {
    const output = [
      JSON.stringify({ type: 'status', code: 'CONNECTING' }),
      JSON.stringify({ type: 'result', success: true, key: `0x${'a'.repeat(64)}` })
    ].join('\n')

    expect(parseMacKeyHelperOutput(output)).toEqual({
      success: true,
      key: 'a'.repeat(64)
    })
  })

  it('runs an independently packaged helper through the public contract', async () => {
    const resourcesRoot = mkdtempSync(join(tmpdir(), 'tracememo-helper-contract-'))
    const helperPath = join(resourcesRoot, MAC_INTEL_HELPER_RESOURCE_PATH)
    mkdirSync(dirname(helperPath), { recursive: true })
    writeFileSync(
      helperPath,
      `#!/bin/sh\nprintf '%s\\n' '{"type":"status","code":"CONNECTING"}' '{"type":"result","success":true,"key":"${'b'.repeat(64)}"}'\n`
    )
    chmodSync(helperPath, 0o755)
    process.env.TRACEMEMO_RESOURCES_PATH = resourcesRoot

    try {
      const statuses: string[] = []
      const result = await new KeyServiceMac().autoGetDbKey(
        (message) => statuses.push(message),
        30_000,
        '/fixture/account'
      )

      expect(result).toEqual({ success: true, key: 'b'.repeat(64) })
      expect(statuses).toEqual(['正在准备连接组件...', '密钥获取成功'])
    } finally {
      rmSync(resourcesRoot, { recursive: true, force: true })
    }
  })

  it('maps a structured error without leaking unrelated output', () => {
    const output = [
      'diagnostic text',
      JSON.stringify({ type: 'error', code: 'WECHAT_NOT_RUNNING' }),
      'more diagnostic text'
    ].join('\n')

    expect(parseMacKeyHelperOutput(output)).toEqual({
      success: false,
      code: 'WECHAT_NOT_RUNNING',
      error: '请先启动并登录微信，然后重试'
    })
  })

  it('rejects a result with the wrong shape or length', () => {
    expect(
      parseMacKeyHelperOutput(JSON.stringify({ type: 'result', success: true, key: 'short' }))
    ).toEqual({ success: false, error: '连接组件未返回有效结果' })
  })
})
