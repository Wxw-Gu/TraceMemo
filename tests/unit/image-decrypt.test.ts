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
const originalResourcesPath = process.resourcesPath

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
  beforeAll(() => {
    mkdirSync(root, { recursive: true })
    Object.defineProperty(process, 'resourcesPath', { configurable: true, value: root })
  })
  afterAll(() => {
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: originalResourcesPath
    })
    rmSync(root, { recursive: true, force: true })
  })

  it('decrypts a synthetic V2 AES/raw/XOR fixture', () => {
    const file = join(root, 'fixture.dat')
    const expected = writeV2Dat(file)
    const service = new ImageDecryptService('0x40', aesKey)
    expect(service.decryptImage(file)).toEqual(expected)
    expect(service.decryptImageToBase64(file)).toMatch(/^data:image\/png;base64,/)
    expect(service.getLastDecodeDiagnostic()).toMatchObject({
      code: 'SUCCESS',
      datVersion: 2,
      imageFormat: 'PNG'
    })
  })

  it('rejects the wrong AES key and unsupported legacy signatures accurately', () => {
    const file = join(root, 'fixture.dat')
    writeV2Dat(file)
    const wrongKeyService = new ImageDecryptService('0x40', 'fedcba9876543210')
    expect(wrongKeyService.decryptImage(file)).toBeNull()
    expect(wrongKeyService.getLastDecodeDiagnostic()).toMatchObject({
      code: 'AES_DECRYPT_FAILED',
      datVersion: 2
    })

    const legacy = join(root, 'legacy.dat')
    writeFileSync(legacy, Buffer.from([0x12, 0x34, 0x56, 0x78]))
    const legacyService = new ImageDecryptService('0x40', aesKey)
    expect(legacyService.decryptImage(legacy)).toBeNull()
    expect(legacyService.getLastDecodeDiagnostic()).toMatchObject({
      code: 'UNSUPPORTED_DAT_VERSION',
      datVersion: 0
    })
  })

  it('finds modern _M variants and reads plain images stored with a DAT extension', async () => {
    const accountRoot = join(root, 'modern-account')
    const sessionId = '77705c31c50e8a4242a9d527fe9433de'
    const imageDirectory = join(accountRoot, 'msg', 'attach', sessionId, '2025-10', 'Img')
    mkdirSync(imageDirectory, { recursive: true })

    const imageBase = '9718e38ad90f57f9e833d17ff2373abd'
    const mediumFile = join(imageDirectory, `${imageBase}_M.dat`)
    writeFileSync(mediumFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]))

    const service = new ImageDecryptService('0x40', aesKey)
    await expect(
      service.findImageFileAsync(undefined, imageBase, {
        allowThumbnail: false,
        accountDir: accountRoot,
        sessionId
      })
    ).resolves.toBe(mediumFile)
    expect(service.decryptImageToBase64(mediumFile)).toMatch(/^data:image\/png;base64,/)
    expect(service.getLastDecodeDiagnostic()).toMatchObject({
      code: 'DIRECT_IMAGE',
      imageFormat: 'PNG'
    })
    await expect(service.decryptImageToBase64WithFallbackAsync(mediumFile, true)).resolves.toEqual(
      expect.objectContaining({ filePath: mediumFile })
    )

    const thumbnailBase = '37a9000000000000000000000000ceaa'
    const thumbnailFile = join(imageDirectory, `${thumbnailBase}_t_M.dat`)
    writeFileSync(thumbnailFile, Buffer.from([0xff, 0xd8, 0xff, 0x00]))
    expect(service.isThumbnailFile(thumbnailFile)).toBe(true)
    await expect(
      service.findImageFileAsync(undefined, `${thumbnailBase}_t_M.dat`, {
        allowThumbnail: false,
        accountDir: accountRoot,
        sessionId
      })
    ).resolves.toBeNull()
    await expect(
      service.findImageFileAsync(undefined, `${thumbnailBase}_t_M.dat`, {
        allowThumbnail: true,
        accountDir: accountRoot,
        sessionId
      })
    ).resolves.toBe(thumbnailFile)
  })
})
