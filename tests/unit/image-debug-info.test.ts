import { describe, expect, it } from 'vitest'
import { IMAGE_DEBUG_KIND, type ImageDebugPayload } from '../../src/shared/image-debug-info'
import { imageFileQuality } from '../../src/shared/image-quality'

/** 复刻主进程的质量映射，确保导出档位与调试档位命名不会互串。 */
function toDebugQuality(quality: 'original' | 'medium' | 'thumbnail'): string {
  if (quality === 'original') return 'original'
  if (quality === 'thumbnail') return 'thumbnail'
  return 'normal'
}

function buildPayload(overrides: Partial<ImageDebugPayload> = {}): ImageDebugPayload {
  return {
    kind: IMAGE_DEBUG_KIND,
    message: {
      accountId: 'wxid_placeholder0001',
      conversationId: '12345678901@chatroom',
      localId: '421',
      serverId: '1371592385505492339',
      createTimeSeconds: 1792372885
    },
    image: { md5: 'deadbeefdeadbeefdeadbeefdeadbeef', datName: 'cafebabecafebabecafebabecafebabe' },
    display: {
      quality: 'thumbnail',
      evidence: 'cafebabecafebabecafebabecafebabe_t.dat',
      path: 'msg/attach/xxx/2026-10/Img/xxx_t.dat'
    },
    ...overrides
  }
}

describe('image debug info schema', () => {
  it('keeps 64-bit serverId as an exact string', () => {
    const payload = buildPayload()
    // 超过 2^53 的 serverId 一旦走 Number 就会变成 1371592385505492300。
    expect(payload.message.serverId).toBe('1371592385505492339')
    expect(BigInt(payload.message.serverId as string)).toBe(BigInt('1371592385505492339'))
  })

  it('serialises without losing precision through JSON', () => {
    const payload = buildPayload()
    const restored = JSON.parse(JSON.stringify(payload)) as ImageDebugPayload
    expect(restored.message.serverId).toBe('1371592385505492339')
    expect(restored.message.createTimeSeconds).toBe(1792372885)
  })

  it('carries the schema marker', () => {
    const payload = buildPayload()
    expect(payload.kind).toBe('tracememo.image-debug')
  })

  it('contains only locator/verification fields — no filler', () => {
    const payload = buildPayload()
    const keys = Object.keys(payload)
    expect(keys).toEqual(['kind', 'message', 'image', 'display'])
    expect(Object.keys(payload.message)).toEqual([
      'accountId',
      'conversationId',
      'localId',
      'serverId',
      'createTimeSeconds'
    ])
    expect(Object.keys(payload.display)).toEqual(['quality', 'evidence', 'path'])
    const serialised = JSON.stringify(payload)
    expect(serialised).not.toMatch(/schemaVersion|incomplete|missingFields|sourceRelativePath/)
  })

  it('never carries key material or raw payload fields', () => {
    const serialised = JSON.stringify(buildPayload())
    expect(serialised).not.toMatch(/aeskey/i)
    expect(serialised).not.toMatch(/<msg>/i)
    expect(serialised).not.toMatch(/cdnmidimgurl/i)
    expect(serialised).not.toMatch(/https?:/i)
  })
})

describe('debug quality naming', () => {
  it('maps medium to normal so it cannot be mistaken for original', () => {
    expect(toDebugQuality('medium')).toBe('normal')
    expect(toDebugQuality('original')).toBe('original')
    expect(toDebugQuality('thumbnail')).toBe('thumbnail')
  })

  it('derives quality from the real file name, not from a claimed value', () => {
    expect(imageFileQuality('/a/b/xxx_t.dat')).toBe('thumbnail')
    expect(imageFileQuality('/a/b/xxx_h.dat')).toBe('original')
    expect(imageFileQuality('/a/b/xxx_hd.dat')).toBe('original')
    expect(imageFileQuality('/a/b/xxx.dat')).toBe('medium')
    expect(imageFileQuality('/a/b/xxx.jpg')).toBe('original')
  })
})
