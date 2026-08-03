import { app, BrowserWindow, shell } from 'electron'
import { createHash } from 'crypto'
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
import { FileAssetService } from './file-asset-service'

const jobs = new Set<string>()
const safeFilePart = (value: string): string =>
  value.replace(/[\\/:*?"<>|]/g, '_').trim() || '聊天档案'
const exportStamp = (): string => {
  const date = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}
const imageKeys = new ImageKeyConfigService()
type MediaExportKind = '图片' | '视频' | '语音' | '表情包' | '文件'

type HtmlExportArchive = {
  version: 1
  sourceId: string
  name: string
  updatedAt: string
  messages: Message[]
}

const archiveAssignment = 'window.__WECHAT_EXPORT__ = '

const messageKey = (message: Message): string => {
  if (message.localId != null)
    return `${message.sessionId || ''}:local:${message.localId}:${message.createTime || 0}`
  const serverId = String(message.serverId || '').trim()
  if (serverId && serverId !== '0') return `${message.sessionId || ''}:server:${serverId}`
  return `${message.sessionId || ''}:fallback:${message.id}:${message.createTime || 0}`
}

const assetToken = (message: Message): string =>
  createHash('sha1').update(messageKey(message)).digest('hex').slice(0, 16)

const safeAttachmentName = (value: string): string => {
  const normalized = safeFilePart(value).replace(/^\.+/, '') || '附件'
  return normalized.length > 120 ? normalized.slice(-120) : normalized
}

const assetCopyFailureReason = (error: unknown): string => {
  const code =
    typeof error === 'object' && error && 'code' in error
      ? String((error as NodeJS.ErrnoException).code || '')
      : ''
  if (code === 'EACCES' || code === 'EPERM') return '没有权限读取本地资源文件'
  if (code === 'ENOENT') return '本地资源文件已不存在'
  return error instanceof Error ? error.message : '复制本地资源文件失败'
}

async function copyExportAsset(
  source: string,
  destination: string
): Promise<{ success: true } | { success: false; error: string }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      try {
        await fs.chmod(destination, 0o644)
      } catch {
        // The destination does not exist on the first export.
      }
      await fs.copyFile(source, destination)
      await fs.chmod(destination, 0o644)
      return { success: true }
    } catch (error) {
      const code =
        typeof error === 'object' && error && 'code' in error
          ? String((error as NodeJS.ErrnoException).code || '')
          : ''
      if (attempt === 0 && (code === 'EACCES' || code === 'EPERM')) {
        await new Promise((resolve) => setTimeout(resolve, 350))
        continue
      }
      return { success: false, error: assetCopyFailureReason(error) }
    }
  }
  return { success: false, error: '复制本地资源文件失败' }
}

async function readHtmlArchive(dataPath: string): Promise<HtmlExportArchive | null> {
  for (const candidate of [dataPath, `${dataPath}.bak`]) {
    try {
      const source = await fs.readFile(candidate, 'utf8')
      if (!source.startsWith(archiveAssignment)) continue
      const parsed = JSON.parse(source.slice(archiveAssignment.length).replace(/;\s*$/, ''))
      if (parsed?.version === 1 && Array.isArray(parsed.messages)) return parsed
    } catch {
      // The backup is attempted when the current data file is incomplete or invalid.
    }
  }
  return null
}

async function hasValidExportedImage(outputDir: string, relativeUrl: string): Promise<boolean> {
  const normalized = String(relativeUrl || '').replace(/\\/g, '/')
  if (!normalized.startsWith('media/') || normalized.includes('../')) return false
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null
  try {
    handle = await fs.open(join(outputDir, ...normalized.split('/')), 'r')
    const header = Buffer.alloc(12)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    return Boolean(detectAssetExtension(header.subarray(0, bytesRead)))
  } catch {
    return false
  } finally {
    await handle?.close()
  }
}

async function mergeArchiveMessages(
  previous: Message[],
  incoming: Message[],
  outputDir: string
): Promise<Message[]> {
  const merged = new Map<string, Message>()
  for (const message of previous) merged.set(messageKey(message), message)
  for (const message of incoming) {
    const key = messageKey(message)
    const current = merged.get(key)
    const next = { ...current, ...message }
    next.exportMediaUrl = message.exportMediaUrl || current?.exportMediaUrl
    next.exportMediaType = message.exportMediaType || current?.exportMediaType
    next.voiceDataUrl = message.voiceDataUrl || current?.voiceDataUrl
    next.voiceDuration = message.voiceDuration || current?.voiceDuration
    next.exportFileUrl = message.exportFileUrl || current?.exportFileUrl
    next.exportFileName = message.exportFileName || current?.exportFileName
    next.exportFileSize = message.exportFileSize || current?.exportFileSize
    next.exportAvatarUrl = message.exportAvatarUrl || current?.exportAvatarUrl
    if (
      message.exportMediaError &&
      current?.exportMediaUrl &&
      (kindOf(message) === 'image' || kindOf(message) === 'sticker') &&
      !(await hasValidExportedImage(outputDir, current.exportMediaUrl))
    ) {
      delete next.exportMediaUrl
      delete next.exportMediaType
    }
    if (next.exportMediaUrl || next.voiceDataUrl || next.exportFileUrl) {
      delete next.exportMediaError
      delete next.exportOmitIfMissing
    }
    merged.set(key, next)
  }
  return Array.from(merged.values()).sort(
    (left, right) =>
      (left.createTime || 0) - (right.createTime || 0) || (left.localId || 0) - (right.localId || 0)
  )
}

async function writeHtmlArchive(dataPath: string, archive: HtmlExportArchive): Promise<void> {
  try {
    await fs.copyFile(dataPath, `${dataPath}.bak`)
  } catch {
    // A first export has no previous archive to back up.
  }
  const json = JSON.stringify(archive).replace(/[\u2028\u2029]/g, (value) =>
    value === '\u2028' ? '\\u2028' : '\\u2029'
  )
  await fs.writeFile(dataPath, `${archiveAssignment}${json};\n`, 'utf8')
}

type MediaExportSummary = NonNullable<ExportResult['media']>

function createMediaSummary(): MediaExportSummary & {
  failures: Map<string, { kind: MediaExportKind; reason: string; count: number }>
} {
  return { requested: 0, exported: 0, failed: 0, warnings: [], failures: new Map() }
}

function recordMediaFailure(
  summary: ReturnType<typeof createMediaSummary>,
  message: Message,
  kind: MediaExportKind,
  reason: string,
  keepMissing: boolean
): void {
  summary.failed += 1
  message.exportMediaError = kind === '表情包' ? '[未知表情]' : `${kind}未导出：${reason}`
  message.exportOmitIfMissing = !keepMissing
  const key = `${kind}:${reason}`
  const current = summary.failures.get(key)
  summary.failures.set(key, { kind, reason, count: (current?.count || 0) + 1 })
}

function finalizeMediaSummary(summary: ReturnType<typeof createMediaSummary>): MediaExportSummary {
  return {
    requested: summary.requested,
    exported: summary.exported,
    failed: summary.failed,
    warnings: Array.from(summary.failures.values()).map(
      ({ kind, reason, count }) => `${kind}有 ${count} 条未导出：${reason}`
    )
  }
}
function decodeDataUrl(data: string): { extension: string; buffer: Buffer } | null {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(data)
  if (!match) return null
  const buffer = Buffer.from(match[2], 'base64')
  const detected = detectAssetExtension(buffer)
  if (!detected) return null
  return {
    extension: detected,
    buffer
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
  if (
    type === 'share' &&
    (message.contentData.typeVal === '6' || message.contentData.typeVal === '74')
  )
    return 'file'
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
  if (type === 'miniProgram' || type === 'redPacket' || type === 'card') return 'share'
  if (type === 'voip') return 'system'
  if (message.type === '图片') return 'image'
  if (message.type === '视频') return 'video'
  if (message.type === '语音') return 'voice'
  if (message.type === '表情包') return 'sticker'
  if (message.type === '文件' || message.type === '文件发送中') return 'file'
  return 'text'
}
const csv = (value: unknown): string => `"${String(value ?? '').replace(/"/g, '""')}"`

function render(format: ExportRequest['format'], messages: Message[], name: string): string {
  if (format === 'html') return renderExportPage(name)
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
  const mediaSummary = createMediaSummary()
  const send = (p: ExportJobProgress): void => {
    if (!win.isDestroyed()) win.webContents.send('export:progress', p)
  }
  try {
    send({ jobId: request.jobId, phase: 'reading', processed: 0, total: 100, percent: 0 })
    await new Promise<void>((resolve) => setImmediate(resolve))
    const messages = (
      await chat.listMessagesForExport(request.userMd5, request.startTime, request.endTime)
    ).filter((message) => request.kinds.includes(kindOf(message)))
    const client = chat.getChatDb()?.getWcdb4Client()
    const peerUsername = client?.getUsernameByMd5(request.userMd5) || ''
    const isGroupChat = peerUsername.endsWith('@chatroom')
    const self = chat.getSelfAccountInfo()
    for (const message of messages) {
      message.exportShowAvatar = request.includeAvatars !== false
      if (!isGroupChat && !message.senderId) {
        message.senderId = message.isSender ? self?.wxid : peerUsername
      }
      const mappedName = message.senderId ? request.nameMap?.[message.senderId] : undefined
      message.name =
        mappedName ||
        message.name ||
        (message.isSender ? self?.nickname || '我' : request.name || '联系人')
      if (!message.img && !isGroupChat) {
        message.img = message.isSender
          ? self?.avatar
          : peerUsername
            ? request.avatarUrls?.[peerUsername]
            : undefined
      }
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
    const outputFolder =
      request.format === 'html'
        ? safeFilePart(request.outputName)
        : `${safeFilePart(request.outputName)}_${exportStamp()}`
    const outputDir = join(root, outputFolder)
    const outputPath =
      request.format === 'html'
        ? join(outputDir, 'index.html')
        : join(root, `${outputFolder}.${ext}`)
    if (request.format === 'html') {
      await fs.mkdir(join(outputDir, 'voices'), { recursive: true })
      await fs.mkdir(join(outputDir, 'media'), { recursive: true })
      await fs.mkdir(join(outputDir, 'files'), { recursive: true })
      await fs.mkdir(join(outputDir, 'avatars'), { recursive: true })
      await fs.mkdir(join(outputDir, 'data'), { recursive: true })
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
      const fileService = client ? new FileAssetService(client.getAccountRoot()) : null
      const exportedAvatars = new Map<string, string>()
      const voiceService =
        request.includeMedia && chat.getChatDb()
          ? new VoiceService(chat.getChatDb()!.getWcdb4Client())
          : null
      if (voiceService) {
        for (const message of messages) {
          if (kindOf(message) !== 'voice') continue
          mediaSummary.requested += 1
          if (!message.sessionId || !message.localId || !message.createTime) {
            recordMediaFailure(
              mediaSummary,
              message,
              '语音',
              '消息缺少会话、消息 ID 或时间信息',
              request.keepMissing !== false
            )
            continue
          }
          const voice = await voiceService.resolveVoice(
            message.sessionId,
            message.localId,
            message.createTime,
            message.serverId
          )
          if (!voice.success || !voice.data) {
            recordMediaFailure(
              mediaSummary,
              message,
              '语音',
              voice.error || '未找到或无法解码语音数据',
              request.keepMissing !== false
            )
            continue
          }
          const voiceName = `voice_${assetToken(message)}.wav`
          const audioBuffer = Buffer.from(voice.data, 'base64')
          await fs.writeFile(join(outputDir, 'voices', voiceName), audioBuffer)
          message.voiceDataUrl = `voices/${voiceName}`
          message.voiceDuration = Math.max(1, Math.round(audioBuffer.length / (24000 * 2)))
          mediaSummary.exported += 1
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
            const avatarToken = createHash('sha1').update(avatarKey).digest('hex').slice(0, 16)
            avatarName = `avatar_${avatarToken}.${avatarExtension}`
            await fs.writeFile(join(outputDir, 'avatars', avatarName), avatarBuffer)
            exportedAvatars.set(avatarKey, avatarName)
          }
          message.exportAvatarUrl = `avatars/${avatarName}`
        }
        if (!request.includeMedia) {
          send({
            jobId: request.jobId,
            phase: 'writing',
            processed: index + 1,
            total: messages.length,
            percent: 15 + Math.round(((index + 1) / Math.max(messages.length, 1)) * 75)
          })
          continue
        }
        if (!message.contentData) {
          const kind = kindOf(message)
          const label =
            kind === 'image'
              ? '图片'
              : kind === 'video'
                ? '视频'
                : kind === 'sticker'
                  ? '表情包'
                  : kind === 'file'
                    ? '文件'
                    : null
          if (label) {
            mediaSummary.requested += 1
            recordMediaFailure(
              mediaSummary,
              message,
              label,
              '消息缺少可用于定位资源的标识',
              request.keepMissing !== false
            )
          }
          continue
        }
        if (message.contentData.type === 'image') {
          mediaSummary.requested += 1
          if (!imageService) {
            recordMediaFailure(
              mediaSummary,
              message,
              '图片',
              '未配置图片解密密钥，请先到设置中配置并测试',
              request.keepMissing !== false
            )
            continue
          }
          const originalFile = imageService.findImageFile(
            message.contentData.md5,
            message.contentData.datName,
            {
              allowThumbnail: request.preferOriginal === false,
              preferThumbnail: request.preferOriginal === false,
              sessionMd5: request.userMd5,
              createTime: message.createTime
            }
          )
          let file = originalFile
          let decrypted = file ? imageService.decryptImageToBase64WithFallback(file, false) : null
          if (!decrypted && request.fallbackThumbnail !== false) {
            const fallbackFile = imageService.findImageFile(
              message.contentData.md5,
              message.contentData.datName,
              {
                allowThumbnail: true,
                preferThumbnail: true,
                sessionMd5: request.userMd5,
                createTime: message.createTime
              }
            )
            if (fallbackFile) {
              file = fallbackFile
              decrypted = imageService.decryptImageToBase64WithFallback(fallbackFile, true)
            }
          }
          const decoded = decrypted ? decodeDataUrl(decrypted.data) : null
          if (decoded) {
            const name = `image_${assetToken(message)}.${decoded.extension}`
            await fs.writeFile(join(outputDir, 'media', name), decoded.buffer)
            message.exportMediaUrl = `media/${name}`
            message.exportMediaType = 'image'
            mediaSummary.exported += 1
          } else {
            recordMediaFailure(
              mediaSummary,
              message,
              '图片',
              file ? '图片解密失败' : '本地未找到原图或缩略图',
              request.keepMissing !== false
            )
          }
        } else if (message.contentData.type === 'video' && videoService) {
          mediaSummary.requested += 1
          const hashes = [
            message.contentData.md5,
            message.contentData.newMd5,
            message.contentData.rawMd5
          ].filter((value): value is string => Boolean(value))
          const resolved = await videoService.resolveForExport(hashes, {
            createTime: message.createTime,
            duration: message.contentData.duration,
            width: message.contentData.width,
            height: message.contentData.height
          })
          const token = resolved.url?.split('/').pop()
          const source = token ? videoService.pathForToken(token) : undefined
          if (source) {
            const name = `video_${assetToken(message)}.mp4`
            const copied = await copyExportAsset(source, join(outputDir, 'media', name))
            if (copied.success) {
              message.exportMediaUrl = `media/${name}`
              message.exportMediaType = 'video'
              mediaSummary.exported += 1
            } else {
              recordMediaFailure(
                mediaSummary,
                message,
                '视频',
                copied.error,
                request.keepMissing !== false
              )
            }
          } else {
            recordMediaFailure(
              mediaSummary,
              message,
              '视频',
              resolved.error || '本地未找到视频文件',
              request.keepMissing !== false
            )
          }
        } else if (message.contentData.type === 'sticker' && stickerService) {
          mediaSummary.requested += 1
          const stickerSource = message.contentData.url || message.contentData.thumbUrl
          const result = await stickerService.resolveSticker(
            stickerSource,
            message.contentData.md5,
            {
              thumbUrl: message.contentData.thumbUrl,
              encryptUrl: message.contentData.encryptUrl,
              aesKey: message.contentData.aeskey
            }
          )
          const decoded = result.data ? decodeDataUrl(result.data) : null
          if (decoded) {
            const name = `sticker_${assetToken(message)}.${decoded.extension}`
            await fs.writeFile(join(outputDir, 'media', name), decoded.buffer)
            message.exportMediaUrl = `media/${name}`
            message.exportMediaType = 'sticker'
            mediaSummary.exported += 1
          } else {
            recordMediaFailure(
              mediaSummary,
              message,
              '表情包',
              result.error || '本地及网络均未找到表情资源',
              request.keepMissing !== false
            )
          }
        } else if (kindOf(message) === 'file') {
          mediaSummary.requested += 1
          const resolved = fileService ? await fileService.resolve(message) : null
          if (resolved) {
            const name = `file_${assetToken(message)}_${safeAttachmentName(resolved.name)}`
            const copied = await copyExportAsset(resolved.path, join(outputDir, 'files', name))
            if (copied.success) {
              message.exportFileUrl = `files/${name}`
              message.exportFileName = resolved.name
              message.exportFileSize = resolved.size
              mediaSummary.exported += 1
            } else {
              recordMediaFailure(
                mediaSummary,
                message,
                '文件',
                copied.error,
                request.keepMissing !== false
              )
            }
          } else {
            recordMediaFailure(
              mediaSummary,
              message,
              '文件',
              fileService ? '本地未找到附件文件' : '当前聊天数据库未连接',
              request.keepMissing !== false
            )
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
    let exportedMessageCount = messages.length
    if (request.format === 'html') {
      const dataPath = join(outputDir, 'data', 'messages.js')
      const previous = await readHtmlArchive(dataPath)
      if (previous?.sourceId && previous.sourceId !== request.userMd5) {
        throw new Error('同名导出目录属于另一个会话，请修改导出文件名后重试')
      }
      const incoming = messages
        .filter((message) => !message.exportOmitIfMissing)
        .map((message) => {
          const archived = { ...message }
          delete archived.img
          return archived
        })
      const merged = await mergeArchiveMessages(previous?.messages || [], incoming, outputDir)
      await writeHtmlArchive(dataPath, {
        version: 1,
        sourceId: request.userMd5,
        name: request.name,
        updatedAt: new Date().toISOString(),
        messages: merged
      })
      await fs.writeFile(outputPath, renderExportPage(request.name), 'utf8')
      exportedMessageCount = merged.length
    } else {
      await fs.writeFile(outputPath, render(request.format, messages, request.name), 'utf8')
    }
    send({
      jobId: request.jobId,
      phase: 'completed',
      processed: exportedMessageCount,
      total: exportedMessageCount,
      percent: 100,
      outputPath
    })
    return {
      success: true,
      outputPath,
      messageCount: exportedMessageCount,
      media: finalizeMediaSummary(mediaSummary)
    }
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
