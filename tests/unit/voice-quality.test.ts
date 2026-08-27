import { describe, expect, it } from 'vitest'
import {
  VOICE_MIN_PCM_BYTES,
  validateVoicePcm,
  validateVoiceSilk,
  validateVoiceSilkMetadata
} from '../../src/main/voice-pipeline/voice-quality'

describe('voice quality gates', () => {
  it('accepts a complete 20ms PCM frame', () => {
    expect(validateVoicePcm(new Uint8Array(VOICE_MIN_PCM_BYTES))).toMatchObject({
      pcmSize: VOICE_MIN_PCM_BYTES,
      sampleRate: 16_000,
      channels: 1,
      durationMs: 20
    })
  })

  it('rejects empty, odd-sized and sub-frame PCM', () => {
    expect(() => validateVoicePcm(new Uint8Array())).toThrow('PCM 为空')
    expect(() => validateVoicePcm(new Uint8Array(3))).toThrow('长度无效')
    expect(() => validateVoicePcm(new Uint8Array(VOICE_MIN_PCM_BYTES - 2))).toThrow('过短')
  })

  it('rejects a header-only Silk payload', () => {
    expect(() => validateVoiceSilkMetadata(10, 20)).toThrow('只有文件头')
    expect(() => validateVoiceSilk(new TextEncoder().encode('\x02#!SILK_V3'), 20)).toThrow(
      '只有文件头'
    )
  })

  it('accepts valid Silk metadata', () => {
    expect(validateVoiceSilkMetadata(128, 240)).toEqual({ silkSize: 128, durationMs: 240 })
    const silk = new Uint8Array(128)
    silk.set(new TextEncoder().encode('\x02#!SILK_V3'))
    expect(validateVoiceSilk(silk, 240)).toEqual({ silkSize: 128, durationMs: 240 })
  })
})
