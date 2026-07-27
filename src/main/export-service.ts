import { app, BrowserWindow, shell } from 'electron'
import { promises as fs } from 'fs'
import { extname, join } from 'path'
import { fileURLToPath } from 'url'
import * as chat from './services/chat-service'
import type {
  ExportJobProgress,
  ExportMessageKind,
  ExportRequest,
  ExportResult
} from '../shared/export'
import type { Message } from '../shared/types'
import { VoiceService } from './voice-service'
import { renderExportPage } from './export-html-template'
import { ImageDecryptService } from './image-decrypt-service'
import { ImageKeyConfigService } from './services/image-key-config-service'
import { VideoAssetService } from './video-asset-service'
import { StickerService } from './sticker-service'

const jobs = new Set<string>()
const safeFilePart = (value: string): string =>
  value.replace(/[\\/:*?"<>|]/g, '_').trim() || '聊天档案'
const exportStamp = (): string => {
  const date = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}
const imageKeys = new ImageKeyConfigService()
function decodeDataUrl(data: string): { extension: string; buffer: Buffer } | null {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(data)
  if (!match) return null
  return {
    extension: match[1].split('/')[1] === 'jpeg' ? 'jpg' : match[1].split('/')[1],
    buffer: Buffer.from(match[2], 'base64')
  }
}
const normalizeAssetExtension = (value: string): string => {
  const extension = value.toLowerCase().replace(/^\./, '')
  return /^(png|jpg|jpeg|webp|gif)$/.test(extension)
    ? extension === 'jpeg'
      ? 'jpg'
      : extension
    : 'jpg'
}
const detectAssetExtension = (buffer: Buffer): string | null => {
  if (buffer.subarray(0, 3).toString('ascii') === 'GIF') return 'gif'
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'png'
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg'
  if (
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return 'webp'
  return null
}
async function readAvatarAsset(
  source: string
): Promise<{ extension: string; buffer: Buffer } | null> {
  const decoded = decodeDataUrl(source)
  if (decoded) return { ...decoded, extension: normalizeAssetExtension(decoded.extension) }

  try {
    if (/^https?:\/\//i.test(source)) {
      const response = await fetch(source)
      if (!response.ok) return null
      const contentType = response.headers.get('content-type')?.split(';')[0].split('/')[1]
      const extension = normalizeAssetExtension(contentType || extname(new URL(source).pathname))
      const buffer = Buffer.from(await response.arrayBuffer())
      return { extension: detectAssetExtension(buffer) || extension, buffer }
    }
    const path = source.startsWith('file://') ? fileURLToPath(source) : source
    const buffer = await fs.readFile(path)
    return {
      extension: detectAssetExtension(buffer) || normalizeAssetExtension(extname(path)),
      buffer
    }
  } catch {
    return null
  }
}
const kindOf = (message: Message): ExportMessageKind => {
  const type = message.contentData?.type
  if (type === 'system' && message.contentData?.pat) return 'text'
  if (
    type === 'image' ||
    type === 'video' ||
    type === 'voice' ||
    type === 'sticker' ||
    type === 'share' ||
    type === 'location' ||
    type === 'system'
  )
    return type
  if (message.type === '图片') return 'image'
  if (message.type === '视频') return 'video'
  if (message.type === '语音') return 'voice'
  if (message.type === '表情包') return 'sticker'
  return 'text'
}
const csv = (value: unknown): string => `"${String(value ?? '').replace(/"/g, '""')}"`

function render(format: ExportRequest['format'], messages: Message[], name: string): string {
  if (format === 'html') return renderExportPage(name, messages)
  if (format === 'json')
    return JSON.stringify({ name, exportedAt: new Date().toISOString(), messages }, null, 2)
  if (format === 'markdown')
    return `# ${name}\n\n${messages.map((m) => `**${m.name || (m.isSender ? '我' : '联系人')}** · ${m.datetime}\n\n${m.content || `[${m.type}]`}\n`).join('\n')}`
  return [
    '时间,发送者,类型,内容',
    ...messages.map((m) =>
      [m.datetime, m.name || (m.isSender ? '我' : '联系人'), m.type, m.content].map(csv).join(',')
    )
  ].join('\n')
}

export async function runExport(request: ExportRequest, win: BrowserWindow): Promise<ExportResult> {
  jobs.add(request.jobId)
  const send = (p: ExportJobProgress): void => {
    if (!win.isDestroyed()) win.webContents.send('export:progress', p)
  }
  try {
    send({ jobId: request.jobId, phase: 'reading', processed: 0, total: 100, percent: 0 })
    await new Promise<void>((resolve) => setImmediate(resolve))
    const messages = chat
      .listMessages(request.userMd5, request.startTime, request.endTime)
      .filter((m) => request.kinds.includes(kindOf(m)))
    for (const message of messages) {
      message.exportShowAvatar = request.includeAvatars !== false
      const mappedName = message.senderId ? request.nameMap?.[message.senderId] : undefined
      if (mappedName) message.name = mappedName
    }
    send({ jobId: request.jobId, phase: 'reading', processed: 10, total: 100, percent: 10 })
    if (!jobs.has(request.jobId)) {
      send({ jobId: request.jobId, phase: 'cancelled', processed: 0, percent: 10 })
      return { success: false, error: '已取消' }
    }
    send({
      jobId: request.jobId,
      phase: 'writing',
      processed: 0,
      total: messages.length,
      percent: 15
    })
    const root = join(app.getPath('documents'), 'WechatExplorer', '导出')
    await fs.mkdir(root, { recursive: true })
    const ext = request.format === 'markdown' ? 'md' : request.format
    const outputFolder = `${safeFilePart(request.outputName)}_${exportStamp()}`
    const outputDir = join(root, outputFolder)
    const outputPath =
      request.format === 'html'
        ? join(outputDir, 'index.html')
        : join(root, `${outputFolder}.${ext}`)
    if (request.format === 'html') {
      await fs.mkdir(join(outputDir, 'voices'), { recursive: true })
      await fs.mkdir(join(outputDir, 'media'), { recursive: true })
      await fs.mkdir(join(outputDir, 'avatars'), { recursive: true })
      const client = chat.getChatDb()?.getWcdb4Client()
      const avatarUsernames = Array.from(
        new Set(
          messages
            .map((message) => message.senderId)
            .filter((value): value is string => Boolean(value))
        )
      )
      const avatarMap =
        request.includeAvatars === false
          ? {}
          : { ...chat.getContactAvatars(avatarUsernames), ...(request.avatarUrls || {}) }
      const imageConfig = imageKeys.getConfig()
      const imageService =
        client && imageConfig.aesKey
          ? new ImageDecryptService(imageConfig.xorKey || '0x40', imageConfig.aesKey, client)
          : null
      const videoService = client ? new VideoAssetService(client) : null
      const stickerService = client ? new StickerService(client) : null
      const exportedAvatars = new Map<string, string>()
      const voiceService =
        request.includeMedia && chat.getChatDb()
          ? new VoiceService(chat.getChatDb()!.getWcdb4Client())
          : null
      if (voiceService) {
        for (const [index, message] of messages.entries()) {
          if (
            kindOf(message) !== 'voice' ||
            !message.sessionId ||
            !message.localId ||
            !message.createTime
          )
            continue
          const voice = await voiceService.resolveVoice(
            message.sessionId,
            message.localId,
            message.createTime,
            message.serverId
          )
          if (!voice.success || !voice.data) continue
          const voiceName = `voice_${index + 1}_${message.localId}.wav`
          const audioBuffer = Buffer.from(voice.data, 'base64')
          await fs.writeFile(join(outputDir, 'voices', voiceName), audioBuffer)
          message.voiceDataUrl = `voices/${voiceName}`
          message.voiceDuration = Math.max(1, Math.round(audioBuffer.length / (24000 * 2)))
        }
      }
      for (const [index, message] of messages.entries()) {
        message.exportShowAvatar = request.includeAvatars !== false
        const avatar = (message.senderId ? avatarMap[message.senderId] : undefined) || message.img
        const resolvedAvatar = avatar ? await readAvatarAsset(avatar) : null
        const avatarBuffer = resolvedAvatar?.buffer || null
        const avatarExtension = resolvedAvatar?.extension || 'jpg'
        if (avatarBuffer) {
          const avatarKey = message.senderId || `message_${index + 1}`
          let avatarName = exportedAvatars.get(avatarKey)
          if (!avatarName) {
            avatarName = `avatar_${exportedAvatars.size + 1}.${avatarExtension}`
            await fs.writeFile(join(outputDir, 'avatars', avatarName), avatarBuffer)
            exportedAvatars.set(avatarKey, avatarName)
          }
          message.exportAvatarUrl = `avatars/${avatarName}`
        }
        if (!request.includeMedia || !message.contentData) {
          send({
            jobId: request.jobId,
            phase: 'writing',
            processed: index + 1,
            total: messages.length,
            percent: 15 + Math.round(((index + 1) / Math.max(messages.length, 1)) * 75)
          })
          continue
        }
        if (message.contentData.type === 'image' && imageService) {
          const file = imageService.findImageFile(
            message.contentData.md5,
            message.contentData.datName,
            { allowThumbnail: true }
          )
          const decrypted = file ? imageService.decryptImageToBase64WithFallback(file, true) : null
          const decoded = decrypted ? decodeDataUrl(decrypted.data) : null
          if (decoded) {
            const name = `image_${index + 1}.${decoded.extension}`
            await fs.writeFile(join(outputDir, 'media', name), decoded.buffer)
            message.exportMediaUrl = `media/${name}`
            message.exportMediaType = 'image'
          }
        } else if (message.contentData.type === 'video' && videoService) {
          const hashes = [
            message.contentData.md5,
            message.contentData.newMd5,
            message.contentData.rawMd5
          ].filter((value): value is string => Boolean(value))
          const resolved = videoService.resolve(hashes)
          const token = resolved.url?.split('/').pop()
          const source = token ? videoService.pathForToken(token) : undefined
          if (source) {
            const name = `video_${index + 1}.mp4`
            await fs.copyFile(source, join(outputDir, 'media', name))
            message.exportMediaUrl = `media/${name}`
            message.exportMediaType = 'video'
          }
        } else if (message.contentData.type === 'sticker' && stickerService) {
          const stickerSource = message.contentData.url || message.contentData.thumbUrl
          const result = await stickerService.resolveSticker(stickerSource, message.contentData.md5)
          const decoded = result.data
            ? decodeDataUrl(result.data)
            : stickerSource
              ? await readAvatarAsset(stickerSource)
              : null
          if (decoded) {
            const name = `sticker_${index + 1}.${decoded.extension}`
            await fs.writeFile(join(outputDir, 'media', name), decoded.buffer)
            message.exportMediaUrl = `media/${name}`
            message.exportMediaType = 'sticker'
          }
        }
        send({
          jobId: request.jobId,
          phase: 'writing',
          processed: index + 1,
          total: messages.length,
          percent: 15 + Math.round(((index + 1) / Math.max(messages.length, 1)) * 75)
        })
      }
    } else {
      send({
        jobId: request.jobId,
        phase: 'writing',
        processed: messages.length,
        total: messages.length,
        percent: 90
      })
    }
    await fs.writeFile(outputPath, render(request.format, messages, request.name), 'utf8')
    send({
      jobId: request.jobId,
      phase: 'completed',
      processed: messages.length,
      total: messages.length,
      percent: 100,
      outputPath
    })
    return { success: true, outputPath, messageCount: messages.length }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    send({ jobId: request.jobId, phase: 'failed', processed: 0, error: message })
    return { success: false, error: message }
  } finally {
    jobs.delete(request.jobId)
  }
}
export function cancelExport(jobId: string): void {
  jobs.delete(jobId)
}
export async function revealExport(path: string): Promise<void> {
  shell.showItemInFolder(path)
}
