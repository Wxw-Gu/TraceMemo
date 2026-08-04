import { dirname, join } from 'path'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExportTarget } from '../../src/shared/export'
import type { Message } from '../../src/shared/types'

const state = vi.hoisted(() => ({
  documents: '',
  accountRoot: '',
  videoPath: '',
  messages: [] as Message[],
  messagesByUser: {} as Record<string, Message[]>,
  imageLookups: [] as {
    allowThumbnail?: boolean
    preferThumbnail?: boolean
    sessionId?: string
    sessionMd5?: string
    createTime?: number
  }[]
}))

vi.mock('electron', () => ({
  app: { getPath: () => state.documents },
  shell: { showItemInFolder: vi.fn() },
  BrowserWindow: class {}
}))
vi.mock('../../src/main/services/chat-service', () => ({
  listMessages: () => structuredClone(state.messages),
  listMessagesAsync: async (userMd5: string) =>
    structuredClone(state.messagesByUser[userMd5] || state.messages),
  getChatDb: () => ({
    getWcdb4Client: () => ({ getAccountRoot: () => state.accountRoot })
  }),
  getContactAvatars: () => ({}),
  getSelfAccountInfoAsync: async () => ({
    wxid: 'fixture_account',
    nickname: '示例昵称',
    accountRoot: state.accountRoot
  })
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
      options: {
        allowThumbnail?: boolean
        preferThumbnail?: boolean
        sessionId?: string
        sessionMd5?: string
        createTime?: number
      }
    ): string {
      state.imageLookups.push(options)
      return 'fixture-original.dat'
    }
    async findImageFileAsync(
      md5: string,
      datName: string,
      options: {
        allowThumbnail?: boolean
        preferThumbnail?: boolean
        sessionId?: string
        sessionMd5?: string
        createTime?: number
      }
    ): Promise<string> {
      return this.findImageFile(md5, datName, options)
    }
    decryptImageToBase64WithFallback(): { data: string; filePath: string } {
      return {
        data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=',
        filePath: 'fixture-original.dat'
      }
    }
    async decryptImageToBase64WithFallbackAsync(): Promise<{
      data: string
      filePath: string
    }> {
      return this.decryptImageToBase64WithFallback()
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

const target = (userMd5 = 'fixture-user', name = '脱敏会话'): ExportTarget => ({
  userMd5,
  name,
  type: 'user'
})

const readArchive = (
  outputPath: string
): {
  version: 2
  conversations: { id: string; name: string; avatarUrl?: string; messageCount: number }[]
  messages: Message[]
} => {
  const source = readFileSync(join(dirname(outputPath), 'data', 'messages.js'), 'utf8')
  return JSON.parse(
    source
      .slice(source.indexOf('=') + 1)
      .trim()
      .replace(/;\s*$/, '')
  )
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
    state.messagesByUser = {}
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
        targets: [target()],
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
      preferThumbnail: false,
      sessionId: 'fixture-session',
      sessionMd5: 'fixture-user',
      createTime: 1_785_549_600
    })
    expect(progress.length).toBeGreaterThan(0)
  })

  it('incrementally merges the same HTML archive, deduplicates messages, and keeps old media', async () => {
    const { runExport } = await import('../../src/main/export-service')
    const win = { isDestroyed: () => true, webContents: { send: vi.fn() } }
    const request = {
      jobId: 'incremental-first',
      targets: [target('fixture-user', '增量会话')],
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

  it('keeps copied videos writable and can replace a legacy read-only video incrementally', async () => {
    const { runExport } = await import('../../src/main/export-service')
    const win = { isDestroyed: () => true, webContents: { send: vi.fn() } }
    chmodSync(state.videoPath, 0o444)
    state.messages = [
      message({
        id: 'read-only-video',
        type: '视频',
        contentData: { type: 'video', md5: 'b'.repeat(32) }
      })
    ]
    const request = {
      targets: [target('fixture-user', '只读视频会话')],
      format: 'html' as const,
      outputName: 'read-only-video-fixture',
      kinds: ['video'] as const,
      includeMedia: true
    }

    const first = await runExport(
      { ...request, jobId: 'read-only-video-first', kinds: [...request.kinds] },
      win as never
    )
    expect(first.success, first.error).toBe(true)
    const firstArchive = readArchive(first.outputPath!)
    const videoPath = join(
      dirname(first.outputPath!),
      firstArchive.messages[0].exportMediaUrl as string
    )
    expect(statSync(videoPath).mode & 0o777).toBe(0o644)

    chmodSync(videoPath, 0o444)
    const second = await runExport(
      { ...request, jobId: 'read-only-video-second', kinds: [...request.kinds] },
      win as never
    )

    expect(second.success, second.error).toBe(true)
    expect(second.outputPath).toBe(first.outputPath)
    expect(statSync(videoPath).mode & 0o777).toBe(0o644)
  })

  it('merges two conversations in stable order without colliding identical message ids or media', async () => {
    const { runExport } = await import('../../src/main/export-service')
    const win = { isDestroyed: () => true, webContents: { send: vi.fn() } }
    state.messagesByUser = {
      alpha: [
        message({
          id: 'same-id',
          type: '图片',
          createTime: 100,
          contentData: { type: 'image', md5: 'a'.repeat(32), datName: 'same.dat' }
        }),
        message({ id: 'alpha-later', content: 'A2', createTime: 200 })
      ],
      beta: [
        message({
          id: 'same-id',
          type: '图片',
          createTime: 100,
          contentData: { type: 'image', md5: 'a'.repeat(32), datName: 'same.dat' }
        }),
        message({ id: 'beta-later', content: 'B2', createTime: 150 })
      ]
    }

    const result = await runExport(
      {
        jobId: 'multi-conversation',
        targets: [target('alpha', '聊天 A'), target('beta', '聊天 B')],
        format: 'html',
        outputName: 'multi-conversation',
        kinds: ['text', 'image'],
        includeMedia: true
      },
      win as never
    )

    expect(result.success).toBe(true)
    const archive = readArchive(result.outputPath!)
    expect(archive.version).toBe(2)
    expect(archive.conversations.map(({ id, messageCount }) => ({ id, messageCount }))).toEqual([
      { id: 'alpha', messageCount: 2 },
      { id: 'beta', messageCount: 2 }
    ])
    expect(
      archive.messages.map((item) => [item.exportConversationId, item.id, item.createTime])
    ).toEqual([
      ['alpha', 'same-id', 100],
      ['beta', 'same-id', 100],
      ['beta', 'beta-later', 150],
      ['alpha', 'alpha-later', 200]
    ])
    const imagePaths = archive.messages
      .filter((item) => item.id === 'same-id')
      .map((item) => item.exportMediaUrl)
    expect(new Set(imagePaths).size).toBe(2)
    for (const imagePath of imagePaths) {
      expect(existsSync(join(dirname(result.outputPath!), imagePath!))).toBe(true)
    }
  })

  it('creates a replaceable ZIP containing the complete top-level archive folder', async () => {
    const { runExport } = await import('../../src/main/export-service')
    const progress: unknown[][] = []
    const win = {
      isDestroyed: () => false,
      webContents: { send: (...args: unknown[]) => progress.push(args) }
    }
    state.messages = [
      message({
        id: 'zip-image',
        type: '图片',
        contentData: { type: 'image', md5: 'a'.repeat(32), datName: 'fixture.dat' }
      })
    ]
    const request = {
      targets: [
        {
          ...target('fixture-user', 'ZIP 会话'),
          avatarUrl:
            'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII='
        }
      ],
      format: 'html' as const,
      outputName: 'zip-fixture',
      kinds: ['image'] as const,
      includeMedia: true,
      includeAvatars: true,
      zip: true
    }
    const first = await runExport(
      { ...request, jobId: 'zip-first', kinds: [...request.kinds] },
      win as never
    )
    expect(first.success, first.error).toBe(true)
    const firstSize = readFileSync(first.outputPath!).length
    const second = await runExport(
      { ...request, jobId: 'zip-second', kinds: [...request.kinds] },
      win as never
    )

    expect(first.success).toBe(true)
    expect(second.success).toBe(true)
    expect(second.outputPath).toBe(first.outputPath)
    expect(firstSize).toBeGreaterThan(0)
    expect(readFileSync(second.outputPath!).subarray(0, 2).toString()).toBe('PK')
    const entries = execFileSync('unzip', ['-Z1', second.outputPath!], { encoding: 'utf8' })
    expect(entries).toContain('zip-fixture/index.html')
    expect(entries).toContain('zip-fixture/data/messages.js')
    expect(entries).toMatch(/zip-fixture\/avatars\/conversation_[0-9a-f]{16}\.png/)
    expect(entries).toMatch(/zip-fixture\/media\/image_[0-9a-f]{16}\.png/)
    expect(progress.some((args) => (args[1] as { phase?: string })?.phase === 'compressing')).toBe(
      true
    )
    expect(
      readdirSync(join(state.documents, 'WechatExplorer', '导出')).some((name) =>
        name.startsWith('zip-fixture.zip.tmp-')
      )
    ).toBe(false)
  })

  it('keeps the last complete ZIP when a replacement is cancelled during compression', async () => {
    const { cancelExport, runExport } = await import('../../src/main/export-service')
    state.messages = [message({ id: 'zip-cancel', content: '保留完整压缩包' })]
    const request = {
      targets: [target('fixture-user', '取消压缩会话')],
      format: 'html' as const,
      outputName: 'zip-cancel-fixture',
      kinds: ['text'] as const,
      includeMedia: false,
      zip: true
    }
    const silentWindow = { isDestroyed: () => true, webContents: { send: vi.fn() } }
    const first = await runExport(
      { ...request, jobId: 'zip-cancel-first', kinds: [...request.kinds] },
      silentWindow as never
    )
    expect(first.success, first.error).toBe(true)
    const completeZip = readFileSync(first.outputPath!)
    const cancellingWindow = {
      isDestroyed: () => false,
      webContents: {
        send: (_channel: string, progress: { phase: string }): void => {
          if (progress.phase === 'compressing') cancelExport('zip-cancel-second')
        }
      }
    }

    const cancelled = await runExport(
      { ...request, jobId: 'zip-cancel-second', kinds: [...request.kinds] },
      cancellingWindow as never
    )

    expect(cancelled).toEqual({ success: false, error: '已取消' })
    expect(readFileSync(first.outputPath!)).toEqual(completeZip)
    expect(
      readdirSync(join(state.documents, 'WechatExplorer', '导出')).some((name) =>
        name.startsWith('zip-cancel-fixture.zip.tmp-')
      )
    ).toBe(false)
  })

  it('normalizes a legacy v1 single-chat archive into v2', async () => {
    const { readHtmlArchive } = await import('../../src/main/export-service')
    const outputDir = join(state.documents, 'legacy-archive')
    mkdirSync(join(outputDir, 'data'), { recursive: true })
    writeFileSync(
      join(outputDir, 'data', 'messages.js'),
      `window.__WECHAT_EXPORT__ = ${JSON.stringify({
        version: 1,
        sourceId: 'legacy-user',
        name: '旧档案',
        exportedAt: '2026-08-01T00:00:00.000Z',
        messages: [message({ id: 'legacy-message', content: '旧消息' })]
      })};\n`,
      'utf8'
    )

    const archive = await readHtmlArchive(outputDir, [target('legacy-user', '旧档案')], '旧档案')

    expect(archive.version).toBe(2)
    expect(archive.conversations).toEqual([
      expect.objectContaining({ id: 'legacy-user', name: '旧档案', messageCount: 1 })
    ])
    expect(archive.messages[0]).toMatchObject({
      id: 'legacy-message',
      exportConversationId: 'legacy-user',
      exportConversationName: '旧档案'
    })
  })

  it('refuses to merge a different conversation into an existing named archive', async () => {
    const { runExport } = await import('../../src/main/export-service')
    const win = { isDestroyed: () => true, webContents: { send: vi.fn() } }
    state.messages = [message({ id: 'text', content: 'fixture' })]
    const baseRequest = {
      jobId: 'source-first',
      targets: [target('first-user', '第一个会话')],
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
        targets: [target('second-user', '第二个会话')],
        kinds: [...baseRequest.kinds]
      },
      win as never
    )

    expect(first.success).toBe(true)
    expect(second.success).toBe(false)
    expect(second.error).toContain('聊天集合不同')
    expect(readArchive(first.outputPath!).conversations.map((item) => item.id)).toEqual([
      'first-user'
    ])
  })

  it('uses message content as the stable fallback when the database supplies a random id', async () => {
    const { exportMessageKey } = await import('../../src/main/export-service')
    const first = message({ id: '0.123456', content: '同一条无本地 ID 消息' })
    const second = message({ id: '0.987654', content: '同一条无本地 ID 消息' })

    expect(exportMessageKey(first, 'fixture-user')).toBe(exportMessageKey(second, 'fixture-user'))
  })

  it('replaces a raw sender account with the hydrated self nickname', async () => {
    const { runExport } = await import('../../src/main/export-service')
    const win = { isDestroyed: () => true, webContents: { send: vi.fn() } }
    state.messages = [
      message({
        id: 'self-message',
        isSender: true,
        senderId: 'fixture_account',
        name: 'fixture_account',
        content: '本人消息'
      })
    ]

    const result = await runExport(
      {
        jobId: 'self-name',
        targets: [
          {
            ...target('fixture-user', '本人昵称'),
            nameMap: { fixture_account: 'fixture_account' }
          }
        ],
        format: 'html',
        outputName: 'self-name',
        kinds: ['text'],
        includeMedia: false
      },
      win as never
    )

    expect(result.success).toBe(true)
    expect(readArchive(result.outputPath!).messages[0]?.name).toBe('示例昵称')
  })

  it('migrates raw self names already stored in an incremental HTML archive', async () => {
    const { runExport } = await import('../../src/main/export-service')
    const win = { isDestroyed: () => true, webContents: { send: vi.fn() } }
    const request = {
      targets: [target('fixture-user', '增量昵称')],
      format: 'html' as const,
      outputName: 'incremental-self-name',
      kinds: ['text'] as const,
      includeMedia: false
    }
    state.messages = [
      message({
        id: 'old-self',
        isSender: true,
        senderId: 'fixture_account',
        name: 'fixture_account',
        content: '旧消息',
        createTime: 1_785_549_600
      })
    ]
    const first = await runExport(
      { ...request, jobId: 'incremental-self-first', kinds: [...request.kinds] },
      win as never
    )
    expect(first.success).toBe(true)

    const firstData = readArchive(first.outputPath!)
    firstData.messages[0].name = 'fixture_account'
    writeFileSync(
      join(dirname(first.outputPath!), 'data', 'messages.js'),
      `window.__WECHAT_EXPORT__ = ${JSON.stringify(firstData)};\n`,
      'utf8'
    )
    state.messages = [
      message({
        id: 'new-self',
        isSender: true,
        senderId: 'fixture_account',
        name: '示例昵称',
        content: '新消息',
        createTime: 1_785_549_700
      })
    ]
    const second = await runExport(
      { ...request, jobId: 'incremental-self-second', kinds: [...request.kinds] },
      win as never
    )

    expect(second.success).toBe(true)
    expect(readArchive(second.outputPath!).messages.map((item) => item.name)).toEqual([
      '示例昵称',
      '示例昵称'
    ])
  })
})
