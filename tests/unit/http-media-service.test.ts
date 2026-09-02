import { describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  ready: true,
  reference: {
    messageId: 'message-1',
    sessionId: 'wxid_fixture',
    imageMd5: '0123456789abcdef0123456789abcdef',
    createTime: 1_756_000_000
  },
  findImageFileAsync: vi.fn(async () => '/private/fixture/image.dat'),
  decryptImageToBase64WithFallbackAsync: vi.fn(async () => ({
    data: 'data:image/png;base64,iVBORw0KGgo=',
    filePath: '/private/fixture/image.dat'
  }))
}))

vi.mock('../../src/main/services/chat-service', () => ({
  isReady: () => fixture.ready,
  getChatDb: () => ({ getWcdb4Client: () => ({}) }),
  getImageMessageReference: (messageId: string) =>
    messageId === fixture.reference.messageId ? fixture.reference : null
}))

vi.mock('../../src/main/services/settings-store', () => ({
  loadSettings: () => ({ dbRoot: '/private/fixture' })
}))

vi.mock('../../src/main/services/image-key-config-service', () => ({
  ImageKeyConfigService: class {
    getConfig(): { xorKey: string; aesKey: string } {
      return { xorKey: '0x40', aesKey: 'fixture-aes-key' }
    }
  }
}))

vi.mock('../../src/main/image-decrypt-service', () => ({
  ImageDecryptService: class {
    findImageFileAsync = fixture.findImageFileAsync
    decryptImageToBase64WithFallbackAsync = fixture.decryptImageToBase64WithFallbackAsync
  }
}))

import { HttpMediaError, readImageMedia } from '../../src/main/http-media-service'

describe('HTTP media service', () => {
  it('resolves a registered image message through the existing decrypt service', async () => {
    await expect(readImageMedia('message-1')).resolves.toEqual({
      mimeType: 'image/png',
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    })
    expect(fixture.findImageFileAsync).toHaveBeenCalledWith(
      fixture.reference.imageMd5,
      undefined,
      expect.objectContaining({
        allowThumbnail: false,
        sessionId: fixture.reference.sessionId,
        createTime: fixture.reference.createTime
      })
    )
  })

  it('does not resolve an unregistered message id', async () => {
    await expect(readImageMedia('unknown')).rejects.toMatchObject<HttpMediaError>({
      code: 'NOT_FOUND'
    })
  })

  it('reports database readiness separately', async () => {
    fixture.ready = false
    await expect(readImageMedia('message-1')).rejects.toMatchObject<HttpMediaError>({
      code: 'NOT_READY'
    })
    fixture.ready = true
  })
})
