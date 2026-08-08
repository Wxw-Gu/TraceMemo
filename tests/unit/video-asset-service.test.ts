import { createHash } from 'crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { VideoAssetService } from '../../src/main/video-asset-service'

const temporaryDirectories: string[] = []

const box = (type: string, payload: Buffer): Buffer => {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(header.length + payload.length, 0)
  header.write(type, 4, 4, 'ascii')
  return Buffer.concat([header, payload])
}

const mp4Fixture = (durationSeconds: number, marker: string): Buffer => {
  const movieHeader = Buffer.alloc(20)
  movieHeader.writeUInt32BE(1000, 12)
  movieHeader.writeUInt32BE(Math.round(durationSeconds * 1000), 16)
  return Buffer.concat([
    box('ftyp', Buffer.from('isom0000', 'ascii')),
    box('moov', box('mvhd', movieHeader)),
    box('mdat', Buffer.from(marker, 'utf8'))
  ])
}

const jpegFixture = (width: number, height: number): Buffer =>
  Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x00,
    0x03,
    0x11,
    0x00,
    0xff,
    0xd9
  ])

const createService = (): {
  accountRoot: string
  service: VideoAssetService
} => {
  const accountRoot = mkdtempSync(join(tmpdir(), 'wxe-video-assets-'))
  temporaryDirectories.push(accountRoot)
  return {
    accountRoot,
    service: new VideoAssetService({
      getAccountRoot: () => accountRoot,
      resolveVideoHardlink: () => null
    } as never)
  }
}

const monthTimestamp = (year: number, month: number): number =>
  Math.floor(new Date(year, month - 1, 15, 12).getTime() / 1000)

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('VideoAssetService local fallback', () => {
  it('finds a video by its content MD5 when the hardlink mapping is absent', async () => {
    const { accountRoot, service } = createService()
    const month = join(accountRoot, 'msg', 'video', '2026-07')
    mkdirSync(month, { recursive: true })
    const content = mp4Fixture(22, 'content-md5-match')
    const filePath = join(month, `${'2'.repeat(32)}.mp4`)
    writeFileSync(filePath, content)
    const contentHash = createHash('md5').update(content).digest('hex')

    const result = await service.resolve([contentHash], {
      createTime: monthTimestamp(2026, 7)
    })

    expect(result.success).toBe(true)
    expect(service.pathForUrl(result.url!)).toBe(filePath)
  })

  it('finds a uniquely matching video by month, thumbnail size, and duration', async () => {
    const { accountRoot, service } = createService()
    const month = join(accountRoot, 'msg', 'video', '2025-11')
    mkdirSync(month, { recursive: true })
    const stem = '66cecd68e095d87175fb5ed138de3cef'
    const filePath = join(month, `${stem}.mp4`)
    const posterPath = join(month, `${stem}_thumb.jpg`)
    writeFileSync(filePath, mp4Fixture(68.441, 'metadata-match'))
    writeFileSync(posterPath, jpegFixture(279, 630))

    const result = await service.resolve(
      ['c92c54c8eae4471be9cc18396daf8015', '021e8a18a765ce14f4c54f40065db98e'],
      {
        createTime: monthTimestamp(2025, 11),
        duration: 68,
        width: 279,
        height: 630
      }
    )

    expect(result.success).toBe(true)
    expect(service.pathForUrl(result.url!)).toBe(filePath)
    expect(service.pathForUrl(result.poster!)).toBe(posterPath)
  })

  it('finds an MD5-less video by byte length, thumbnail size, and duration', async () => {
    const { accountRoot, service } = createService()
    const month = join(accountRoot, 'msg', 'video', '2026-08')
    mkdirSync(month, { recursive: true })
    const targetStem = '9a3b17272822a65ce6e396ecded9ccdc'
    const otherStem = '47e890579eacf48c46187ae998332202'
    const target = mp4Fixture(30, 'target-video-with-distinct-byte-length')
    writeFileSync(join(month, `${targetStem}.mp4`), target)
    writeFileSync(join(month, `${targetStem}_thumb.jpg`), jpegFixture(224, 398))
    writeFileSync(join(month, `${otherStem}.mp4`), mp4Fixture(30, 'other'))
    writeFileSync(join(month, `${otherStem}_thumb.jpg`), jpegFixture(224, 398))

    const result = await service.resolve([], {
      createTime: monthTimestamp(2026, 8),
      byteLength: target.length,
      duration: 30,
      width: 224,
      height: 398
    })

    expect(result.success).toBe(true)
    expect(service.pathForUrl(result.url!)).toBe(join(month, `${targetStem}.mp4`))
  })

  it('does not guess when multiple files match the same metadata', async () => {
    const { accountRoot, service } = createService()
    const month = join(accountRoot, 'msg', 'video', '2026-02')
    mkdirSync(month, { recursive: true })
    for (const stem of ['a'.repeat(32), 'b'.repeat(32)]) {
      writeFileSync(join(month, `${stem}.mp4`), mp4Fixture(12, stem))
      writeFileSync(join(month, `${stem}_thumb.jpg`), jpegFixture(224, 398))
    }

    const result = await service.resolve(['c'.repeat(32)], {
      createTime: monthTimestamp(2026, 2),
      duration: 12,
      width: 224,
      height: 398
    })

    expect(result).toEqual({ success: false, error: '本地未找到该视频文件' })
  })
})
