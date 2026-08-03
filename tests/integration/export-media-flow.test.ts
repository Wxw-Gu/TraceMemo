import { dirname, join } from 'path'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '../../src/shared/types'

const state = vi.hoisted(() => ({
  documents: '',
  videoPath: '',
  messages: [] as Message[],
  imageLookups: [] as { allowThumbnail?: boolean; preferThumbnail?: boolean }[]
}))

vi.mock('electron', () => ({
  app: { getPath: () => state.documents },
  shell: { showItemInFolder: vi.fn() },
  BrowserWindow: class {}
}))
vi.mock('../../src/main/services/chat-service', () => ({
  listMessages: () => structuredClone(state.messages),
  getChatDb: () => ({ getWcdb4Client: () => ({}) }),
  getContactAvatars: () => ({})
}))
vi.mock('../../src/main/services/image-key-config-service', () => ({
  ImageKeyConfigService: class {
    getConfig(): { aesKey: string; xorKey: string } {
      return { aesKey: '0123456789abcdef', xorKey: '0x40' }
    }
  }
}))
vi.mock('../../src/main/voice-service', () => ({
  VoiceService: class {
    async resolveVoice(
      _sessionId: string,
      localId: number
    ): Promise<{ success: boolean; data?: string; error?: string }> {
      return localId === 1
        ? {
            success: true,
            data: 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA='
          }
        : { success: false, error: '本地未找到语音数据' }
    }
  }
}))
vi.mock('../../src/main/image-decrypt-service', () => ({
  ImageDecryptService: class {
    findImageFile(
      _md5: string,
      _datName: string,
      options: { allowThumbnail?: boolean; preferThumbnail?: boolean }
    ): string {
      state.imageLookups.push(options)
      return 'fixture-original.dat'
    }
    decryptImageToBase64WithFallback(): { data: string; filePath: string } {
      return {
        data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=',
        filePath: 'fixture-original.dat'
      }
    }
    isThumbnailFile(): boolean {
      return false
    }
  }
}))
vi.mock('../../src/main/video-asset-service', () => ({
  VideoAssetService: class {
    resolve(): { success: boolean; url: string } {
      return { success: true, url: 'wxe-media://local/fixture-video' }
    }
    pathForUrl(): string {
      return state.videoPath
    }
  }
}))
vi.mock('../../src/main/sticker-service', () => ({
  StickerService: class {}
}))

const message = (overrides: Partial<Message>): Message => ({
  id: 'fixture',
  from: 'fixture',
  type: '普通文本',
  datetime: '2026-08-01 10:00:00',
  content: '',
  isSender: false,
  createTime: 1_785_549_600,
  ...overrides
})

describe('media export flow', () => {
  beforeEach(() => {
    state.documents = mkdtempSync(join(tmpdir(), 'wxe-export-fixture-'))
    state.videoPath = join(state.documents, 'fixture.mp4')
    writeFileSync(
      state.videoPath,
      Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex')
    )
    state.imageLookups = []
    state.messages = [
      message({
        id: 'voice-ok',
        type: '语音',
        sessionId: 'fixture-session',
        localId: 1,
        contentData: { type: 'voice', duration: 1 }
      }),
      message({
        id: 'voice-missing',
        type: '语音',
        sessionId: 'fixture-session',
        localId: 2,
        contentData: { type: 'voice', duration: 1 }
      }),
      message({
        id: 'image',
        type: '图片',
        sessionId: 'fixture-session',
        contentData: { type: 'image', md5: 'a'.repeat(32), datName: 'fixture.dat' }
      }),
      message({
        id: 'video',
        type: '视频',
        contentData: { type: 'video', md5: 'b'.repeat(32) }
      })
    ]
  })

  afterEach(() => rmSync(state.documents, { recursive: true, force: true }))

  it('writes playable relative assets, keeps failures, and requests the original image first', async () => {
    const { runExport } = await import('../../src/main/export-service')
    const progress: unknown[] = []
    const win = {
      isDestroyed: () => false,
      webContents: { send: (...args: unknown[]) => progress.push(args) }
    }
    const result = await runExport(
      {
        jobId: 'fixture-export',
        userMd5: 'fixture-user',
        name: '脱敏会话',
        format: 'html',
        outputName: 'fixture',
        kinds: ['voice', 'image', 'video'],
        includeMedia: true,
        preferOriginal: true,
        fallbackThumbnail: true,
        keepMissing: true
      },
      win as never
    )

    expect(result.success).toBe(true)
    const html = readFileSync(result.outputPath!, 'utf8')
    const outputDir = dirname(result.outputPath!)
    expect(readFileSync(join(outputDir, 'voices/voice_1_1.wav')).subarray(0, 4).toString()).toBe(
      'RIFF'
    )
    expect(readFileSync(join(outputDir, 'media/video_4.mp4')).subarray(4, 8).toString()).toBe(
      'ftyp'
    )
    expect(html).toContain('src="voices/voice_1_1.wav"')
    expect(html).toContain('src="media/video_4.mp4"')
    expect(html).toContain('语音文件缺失：本地未找到语音数据')
    expect(state.imageLookups[0]).toMatchObject({
      allowThumbnail: false,
      preferThumbnail: false
    })
    expect(progress.length).toBeGreaterThan(0)
  })
})
