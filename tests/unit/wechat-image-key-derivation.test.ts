import { describe, expect, it } from 'vitest'
import {
  deriveV4ImageKeys,
  extractKvcommCode,
  normalizeV4AccountId
} from '../../src/shared/wechat-image-key-derivation'

describe('WeChat 4 image key derivation', () => {
  it('normalizes account directories without leaking the per-install suffix', () => {
    expect(normalizeV4AccountId('C:\\data\\wxid_fixture_ab12')).toBe('wxid_fixture')
    expect(normalizeV4AccountId('/data/custom-account_ab12')).toBe('custom-account')
  })

  it('extracts only valid uint32 kvcomm codes', () => {
    expect(extractKvcommCode('key_123456789_network.statistic')).toBe(123456789)
    expect(extractKvcommCode('key_0_network.statistic')).toBeNull()
    expect(extractKvcommCode('other_123_network.statistic')).toBeNull()
  })

  it('derives the documented XOR byte and 16-character AES key', () => {
    expect(deriveV4ImageKeys(123456789, 'wxid_fixture_ab12')).toEqual({
      xorKey: 0x15,
      aesKey: '3bc2c5cbb10dfeda'
    })
  })
})
