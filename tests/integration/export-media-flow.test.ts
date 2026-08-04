import { dirname, join } from 'path'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '../../src/shared/types'

const state = vi.hoisted(() => ({
  documents: '',
  accountRoot: '',
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
  listMessagesAsync: async () => structuredClone(state.messages),
  getChatDb: () => ({
    getWcdb4Client: () => ({ getAccountRoot: () => state.accountRoot })
  }),
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

const readArchive = (outputPath: string): { sourceId: string; messages: Message[] } => {
  const source = readFileSync(join(dirname(outputPath), 'data', 'messages.js'), 'utf8')
  return JSON.parse(
    source
      .slice(source.indexOf('=') + 1)
      .trim()
      .replace(/;\s*$/, '')
  ) as {
    sourceId: string
    messages: Message[]
  }
}

describe('media export flow', () => {
  beforeEach(() => {
    state.documents = mkdtempSync(join(tmpdir(), 'wxe-export-fixture-'))
    state.accountRoot = join(state.documents, 'fixture-account')
    state.videoPath = join(state.documents, 'fixture.mp4')
    writeFileSync(
      state.videoPath,
      Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex')
    )
    state.imageLookups = []
    const fileMonth = join(state.accountRoot, 'msg', 'file', '2026-08')
    mkdirSync(fileMonth, { recursive: true })
    writeFileSync(join(fileMonth, '测试附件.txt'), '附件内容')
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
      }),
      message({
        id: 'file',
        type: '文件',
        contentData: { type: 'share', typeVal: '6', title: '测试附件.txt', url: '' }
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
        kinds: ['voice', 'image', 'video', 'file'],
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
    const archive = readArchive(result.outputPath!)
    const voice = archive.messages.find((item) => item.id === 'voice-ok')!
    const video = archive.messages.find((item) => item.id === 'video')!
    const file = archive.messages.find((item) => item.id === 'file')!
    const missingVoice = archive.messages.find((item) => item.id === 'voice-missing')!
    expect(readFileSync(join(outputDir, voice.voiceDataUrl!)).subarray(0, 4).toString()).toBe(
      'RIFF'
    )
    expect(readFileSync(join(outputDir, video.exportMediaUrl!)).subarray(4, 8).toString()).toBe(
      'ftyp'
    )
    expect(readFileSync(join(outputDir, file.exportMediaUrl!), 'utf8')).toBe('附件内容')
    expect(html).toContain('<script src="data/messages.js"></script>')
    expect(voice.voiceDataUrl).toMatch(/^voices\/voice_[0-9a-f]{16}\.wav$/)
    expect(video.exportMediaUrl).toMatch(/^media\/video_[0-9a-f]{16}\.mp4$/)
    expect(file.exportMediaUrl).toMatch(/^media\/file_[0-9a-f]{16}_测试附件\.txt$/)
    expect(missingVoice.exportMediaError).toBe('语音文件缺失：本地未找到语音数据')
    expect(state.imageLookups[0]).toMatchObject({
      allowThumbnail: false,
      preferThumbnail: false
    })
    expect(progress.length).toBeGreaterThan(0)
  })

  it('incrementally merges the same HTML archive, deduplicates messages, and keeps old media', async () => {
    const { runExport } = await import('../../src/main/export-service')
    const win = { isDestroyed: () => true, webContents: { send: vi.fn() } }
    const request = {
      jobId: 'incremental-first',
      userMd5: 'fixture-user',
      name: '增量会话',
      format: 'html' as const,
      outputName: 'incremental-fixture',
      kinds: ['voice', 'text'] as const,
      includeMedia: true,
      keepMissing: true
    }
    state.messages = [
      message({
        id: 'voice-old',
        type: '语音',
        sessionId: 'fixture-session',
        localId: 1,
        contentData: { type: 'voice', duration: 1 }
      }),
      message({ id: 'text-old', content: '第一次导出', createTime: 1_785_549_660 })
    ]
    const first = await runExport({ ...request, kinds: [...request.kinds] }, win as never)
    expect(first.success).toBe(true)
    const firstArchive = readArchive(first.outputPath!)
    const oldVoiceUrl = firstArchive.messages.find((item) => item.id === 'voice-old')!.voiceDataUrl

    state.messages = [
      message({ id: 'text-old', content: '同一条消息已更新', createTime: 1_785_549_660 }),
      message({ id: 'text-new', content: '第二次新增', createTime: 1_785_549_720 })
    ]
    const second = await runExport(
      {
        ...request,
        jobId: 'incremental-second',
        kinds: [...request.kinds],
        includeMedia: false
      },
      win as never
    )
    expect(second.success).toBe(true)
    expect(second.outputPath).toBe(first.outputPath)
    const secondArchive = readArchive(second.outputPath!)
    expect(secondArchive.messages.map((item) => item.id)).toEqual([
      'voice-old',
      'text-old',
      'text-new'
    ])
    expect(secondArchive.messages.find((item) => item.id === 'text-old')?.content).toBe(
      '同一条消息已更新'
    )
    expect(secondArchive.messages.find((item) => item.id === 'voice-old')?.voiceDataUrl).toBe(
      oldVoiceUrl
    )
    expect(existsSync(join(dirname(second.outputPath!), 'data', 'messages.js.bak'))).toBe(true)
  })

  it('refuses to merge a different conversation into an existing named archive', async () => {
    const { runExport } = await import('../../src/main/export-service')
    const win = { isDestroyed: () => true, webContents: { send: vi.fn() } }
    state.messages = [message({ id: 'text', content: 'fixture' })]
    const baseRequest = {
      jobId: 'source-first',
      userMd5: 'first-user',
      name: '第一个会话',
      format: 'html' as const,
      outputName: 'same-name',
      kinds: ['text'] as const,
      includeMedia: false
    }
    const first = await runExport({ ...baseRequest, kinds: [...baseRequest.kinds] }, win as never)
    const second = await runExport(
      {
        ...baseRequest,
        jobId: 'source-second',
        userMd5: 'second-user',
        name: '第二个会话',
        kinds: [...baseRequest.kinds]
      },
      win as never
    )

    expect(first.success).toBe(true)
    expect(second.success).toBe(false)
    expect(second.error).toContain('另一个会话')
    expect(readArchive(first.outputPath!).sourceId).toBe('first-user')
  })

  it('uses message content as the stable fallback when the database supplies a random id', async () => {
    const { exportMessageKey } = await import('../../src/main/export-service')
    const first = message({ id: '0.123456', content: '同一条无本地 ID 消息' })
    const second = message({ id: '0.987654', content: '同一条无本地 ID 消息' })

    expect(exportMessageKey(first, 'fixture-user')).toBe(exportMessageKey(second, 'fixture-user'))
  })
})
