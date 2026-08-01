import crypto from 'crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const root = mkdtempSync(join(tmpdir(), 'wxe-image-test-'))

vi.mock('electron', () => ({ app: { getPath: () => root } }))
vi.mock('../../src/main/services/settings-store', () => ({
  loadSettings: () => ({ ffmpegPath: '' })
}))
vi.mock('../../src/main/wcdb4-client', () => ({ Wcdb4Client: class {} }))

import { ImageDecryptService } from '../../src/main/image-decrypt-service'

const aesKey = '0123456789abcdef'
const xorKey = 0x40

function writeV2Dat(file: string): Buffer {
  const aesPlain = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  const padded = Buffer.concat([aesPlain, Buffer.alloc(16, 16)])
  const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from(aesKey, 'ascii'), null)
  cipher.setAutoPadding(false)
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final()])
  const raw = Buffer.from([13, 14])
  const tailPlain = Buffer.from([15, 16])
  const tailCipher = Buffer.from(tailPlain.map((value) => value ^ xorKey))
  const header = Buffer.alloc(15)
  Buffer.from([0x07, 0x08, 0x56, 0x32, 0x08, 0x07]).copy(header)
  header.writeInt32LE(aesPlain.length, 6)
  header.writeInt32LE(tailPlain.length, 10)
  writeFileSync(file, Buffer.concat([header, encrypted, raw, tailCipher]))
  return Buffer.concat([aesPlain, raw, tailPlain])
}

describe('DAT image decryption', () => {
  beforeAll(() => mkdirSync(root, { recursive: true }))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('decrypts a synthetic V2 AES/raw/XOR fixture', () => {
    const file = join(root, 'fixture.dat')
    const expected = writeV2Dat(file)
    expect(new ImageDecryptService('0x40', aesKey).decryptImage(file)).toEqual(expected)
  })

  it('rejects the wrong AES key and unsupported legacy signatures accurately', () => {
    const file = join(root, 'fixture.dat')
    writeV2Dat(file)
    expect(new ImageDecryptService('0x40', 'fedcba9876543210').decryptImage(file)).toBeNull()

    const legacy = join(root, 'legacy.dat')
    writeFileSync(legacy, Buffer.from([0xff, 0xd8, 0xff, 0x00]))
    expect(new ImageDecryptService('0x40', aesKey).decryptImage(legacy)).toBeNull()
  })
})
