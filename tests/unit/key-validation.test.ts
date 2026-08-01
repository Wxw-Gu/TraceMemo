import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => 'fixture-settings' },
  safeStorage: { isEncryptionAvailable: () => false }
}))
import {
  isDatabaseKeyFormatValid,
  mapAutoDetectPhase,
  normalizeDatabaseKey
} from '../../src/renderer/src/features/settings/database-key/utils'
import {
  normalizeImageXorKey,
  validateImageKeyRequest
} from '../../src/main/services/image-key-config-service'

describe('database key validation', () => {
  it('normalizes a prefixed key without accepting the wrong length', () => {
    const key = `0x${'a'.repeat(64)}`
    expect(normalizeDatabaseKey(key)).toBe('a'.repeat(64))
    expect(isDatabaseKeyFormatValid(key)).toBe(true)
    expect(isDatabaseKeyFormatValid('a'.repeat(63))).toBe(false)
    expect(isDatabaseKeyFormatValid('z'.repeat(64))).toBe(false)
  })

  it('maps automatic detection progress into stable phases', () => {
    expect(mapAutoDetectPhase('正在查找微信进程')).toBeGreaterThan(0)
    expect(mapAutoDetectPhase('已获取数据库密钥')).toBe(5)
  })
})

describe('image key validation', () => {
  it.each([
    [64, '0x40'],
    ['64', '0x40'],
    ['0xff', '0xFF'],
    ['', '0x40']
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeImageXorKey(input)).toBe(expected)
  })

  it('keeps database and image key validation independent', () => {
    const result = validateImageKeyRequest({
      resourceRoot: ' fixture-root ',
      xorKey: '64',
      aesKey: '0123456789abcdef'
    })
    expect(result).toEqual({
      success: true,
      resourceRoot: 'fixture-root',
      xorKey: '0x40',
      aesKey: '0123456789abcdef'
    })
    expect(
      validateImageKeyRequest({ resourceRoot: 'fixture-root', xorKey: '999', aesKey: 'short' })
        .success
    ).toBe(false)
  })
})
