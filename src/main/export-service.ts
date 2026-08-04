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
import { getImageExportAttempts } from '../shared/export-media'
import { FileAssetService } from './file-asset-service'
import { mergeCachedSelfInfo } from './services/bootstrap-cache'
import type { VoiceRecognitionUseCase } from './voice-pipeline/voice-recognition-use-case'

const jobs = new Set<string>()
const safeFilePart = (value: string): string =>
  value.replace(/[\\/:*?"<>|]/g, '_').trim() || '聊天档案'
const exportStamp = (): string => {
  const date = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}
const imageKeys = new ImageKeyConfigService()

const copyExportAsset = async (
  source: string,
  destination: string
): Promise<{ success: true } | { success: false; error: string }> => {
  try {
    await fs.copyFile(source, destination)
    return { success: true }
  } catch (error) {
    try {
      const [sourceStat, destinationStat] = await Promise.all([
        fs.stat(source),
        fs.stat(destination)
      ])
      if (
        sourceStat.isFile() &&
        destinationStat.isFile() &&
        sourceStat.size > 0 &&
        sourceStat.size === destinationStat.size
      ) {
        return { success: true }
      }
    } catch {
      // The original copy error below is more useful than a secondary stat error.
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export interface HtmlExportArchive {
  version: 1
  sourceId: string
  name: string
  exportedAt: string
  messages: Message[]
}

const archiveDataPrefix = 'window.__WECHAT_EXPORT__ = '
const hashPart = (value: string, length = 16): string =>
  createHash('sha1').update(value).digest('hex').slice(0, length)

export const exportMessageKey = (message: Message, sourceId = ''): string => {
  const sessionId = message.sessionId || sourceId
  if (message.localId && message.createTime) {
    return `${sessionId}:local:${message.localId}:${message.createTime}`
  }
  if (message.serverId) return `${sessionId}:server:${message.serverId}`
  if (message.id && message.createTime && !/^0\.\d+$/.test(message.id)) {
    return `${sessionId}:id:${message.id}:${message.createTime}`
  }
  return `${sessionId}:fallback:${hashPart(
    JSON.stringify([
      message.createTime || 0,
      message.senderId || '',
      message.isSender,
      message.type,
      message.content,
      message.contentData || null
    ]),
    24
  )}`
}

const mergeArchiveMessage = (previous: Message, current: Message): Message => {
  const merged = { ...previous, ...current }
  const preserveWhenMissing: (keyof Message)[] = [
    'voiceDataUrl',
    'voiceDuration',
    'voiceTranscript',
    'voiceTranscriptError',
    'exportMediaUrl',
    'exportMediaType',
    'exportMediaName',
    'exportAvatarUrl'
  ]
  for (const key of preserveWhenMissing) {
    if (current[key] == null && previous[key] != null) {
      Object.assign(merged, { [key]: previous[key] })
    }
  }
  if (!current.exportMediaUrl && !current.voiceDataUrl && previous.exportMediaError) {
    merged.exportMediaError = previous.exportMediaError
  }
  return merged
}

export function mergeHtmlArchiveMessages(
  previous: Message[],
  current: Message[],
  sourceId = ''
): Message[] {
  const merged = new Map<string, Message>()
  for (const message of previous) merged.set(exportMessageKey(message, sourceId), message)
  for (const message of current) {
    const key = exportMessageKey(message, sourceId)
    const existing = merged.get(key)
    merged.set(key, existing ? mergeArchiveMessage(existing, message) : message)
  }
  return Array.from(merged.values()).sort((left, right) => {
    const byTime = Number(left.createTime || 0) - Number(right.createTime || 0)
    if (byTime !== 0) return byTime
    return Number(left.localId || 0) - Number(right.localId || 0)
  })
}

export function normalizeHtmlArchiveSelfNames(
  messages: Message[],
  selfInfo: { wxid: string; nickname: string } | null
): Message[] {
  const wxid = String(selfInfo?.wxid || '').trim()
  const nickname = String(selfInfo?.nickname || '').trim()
  if (!nickname || nickname === wxid || /^wxid_/i.test(nickname)) return messages
  return messages.map((message) => {
    if (!message.isSender) return message
    const currentName = String(message.name || '').trim()
    const senderId = String(message.senderId || '').trim()
    const usesRawAccount =
      !currentName ||
      currentName === wxid ||
      (senderId === wxid && currentName === senderId) ||
      /^wxid_/i.test(currentName)
    return usesRawAccount ? { ...message, name: nickname } : message
  })
}

export async function readHtmlArchive(
  outputDir: string,
  sourceId: string,
  name: string
): Promise<HtmlExportArchive> {
  const dataPath = join(outputDir, 'data', 'messages.js')
  let source = ''
  try {
    source = await fs.readFile(dataPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, sourceId, name, exportedAt: new Date(0).toISOString(), messages: [] }
    }
    throw error
  }
  const assignment = source.indexOf('=')
  if (assignment < 0) throw new Error('现有 HTML 档案数据格式无法识别，请更换导出名称')
  const json = source
    .slice(assignment + 1)
    .trim()
    .replace(/;\s*$/, '')
  let archive: HtmlExportArchive
  try {
    archive = JSON.parse(json) as HtmlExportArchive
  } catch {
    throw new Error('现有 HTML 档案数据已损坏，请从 messages.js.bak 恢复或更换导出名称')
  }
  if (archive.sourceId && archive.sourceId !== sourceId) {
    throw new Error('同名导出目录已属于另一个会话，请修改文件名称后重试')
  }
  return {
    version: 1,
    sourceId,
    name: archive.name || name,
    exportedAt: archive.exportedAt || new Date(0).toISOString(),
    messages: Array.isArray(archive.messages) ? archive.messages : []
  }
}

export async function writeHtmlArchive(
  outputDir: string,
  archive: HtmlExportArchive
): Promise<void> {
  const dataDir = join(outputDir, 'data')
  const dataPath = join(dataDir, 'messages.js')
  const backupPath = `${dataPath}.bak`
  const temporaryPath = `${dataPath}.tmp-${process.pid}-${Date.now()}`
  await fs.mkdir(dataDir, { recursive: true })
  try {
    await fs.copyFile(dataPath, backupPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const source = `${archiveDataPrefix}${JSON.stringify(archive)};\n`
  await fs.writeFile(temporaryPath, source, 'utf8')
  try {
    await fs.rename(temporaryPath, dataPath)
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes((error as NodeJS.ErrnoException).code || '')) throw error
    await fs.rm(dataPath, { force: true })
    await fs.rename(temporaryPath, dataPath)
  } finally {
    await fs.rm(temporaryPath, { force: true })
  }
}

const keepMediaError = (request: ExportRequest, message: Message, error: string): void => {
  if (request.keepMissing !== false) message.exportMediaError = error
}
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
  if (type === 'share' && message.contentData.typeVal === '6') return 'file'
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
  if (format === 'html') return renderExportPage(name)
  if (format === 'json')
    return JSON.stringify({ name, exportedAt: new Date().toISOString(), messages }, null, 2)
  if (format === 'markdown')
    return `# ${name}\n\n${messages.map((m) => `**${m.name || (m.isSender ? '我' : '联系人')}** · ${m.datetime}\n\n${m.content || `[${m.type}]`}${m.exportMediaUrl || m.voiceDataUrl || m.exportMediaError ? `\n\n媒体：${m.exportMediaUrl || m.voiceDataUrl || m.exportMediaError}` : ''}\n`).join('\n')}`
  return [
    '时间,发送者,类型,内容,媒体路径,媒体状态',
    ...messages.map((m) =>
      [
        m.datetime,
        m.name || (m.isSender ? '我' : '联系人'),
        m.type,
        m.content,
        m.exportMediaUrl || m.voiceDataUrl || '',
        m.exportMediaError || ''
      ]
        .map(csv)
        .join(',')
    )
  ].join('\n')
}

export async function runExport(
  request: ExportRequest,
  win: BrowserWindow,
  voiceRecognition?: Pick<VoiceRecognitionUseCase, 'recognize'>
): Promise<ExportResult> {
  jobs.add(request.jobId)
  const send = (p: ExportJobProgress): void => {
    if (!win.isDestroyed()) win.webContents.send('export:progress', p)
  }
  try {
    send({ jobId: request.jobId, phase: 'reading', processed: 0, total: 100, percent: 0 })
    await new Promise<void>((resolve) => setImmediate(resolve))
    const messages = (
      await chat.listMessagesAsync(request.userMd5, request.startTime, request.endTime)
    ).filter((message) => request.kinds.includes(kindOf(message)))
    const rawSelfInfo = await chat.getSelfAccountInfoAsync()
    const selfInfo = rawSelfInfo ? mergeCachedSelfInfo(rawSelfInfo.accountRoot, rawSelfInfo) : null
    const isUsableSelfName = (value: string | undefined): value is string => {
      const name = String(value || '').trim()
      if (!name) return false
      if (name === selfInfo?.wxid) return false
      if (/^wxid_/i.test(name)) return false
      return true
    }
    for (const message of messages) {
      message.exportMediaUrl = undefined
      message.exportMediaType = undefined
      message.exportMediaName = undefined
      message.exportMediaError = undefined
      message.voiceDataUrl = undefined
      message.voiceTranscript = undefined
      message.voiceTranscriptError = undefined
      message.exportShowAvatar = request.includeAvatars !== false
      const mappedName = message.senderId ? request.nameMap?.[message.senderId] : undefined
      if (mappedName && (!message.isSender || isUsableSelfName(mappedName))) {
        message.name = mappedName
      } else if (message.isSender && isUsableSelfName(selfInfo?.nickname)) {
        message.name = selfInfo.nickname
      }
      if (
        request.format !== 'html' &&
        ['image', 'video', 'voice', 'sticker', 'file'].includes(kindOf(message))
      ) {
        message.exportMediaError = '当前导出格式记录媒体状态，但不复制媒体文件'
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
      const previousArchive = await readHtmlArchive(outputDir, request.userMd5, request.name)
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
      const fileService = client ? new FileAssetService(client) : null
      const exportedAvatars = new Map<string, string>()
      const voiceService =
        request.includeMedia && chat.getChatDb()
          ? new VoiceService(chat.getChatDb()!.getWcdb4Client())
          : null
      if (voiceService) {
        for (const message of messages) {
          if (kindOf(message) !== 'voice') continue
          if (!message.sessionId || message.localId == null || !message.createTime) {
            keepMediaError(request, message, '语音标识不完整，无法定位本地语音')
            continue
          }
          try {
            const voice = await voiceService.resolveVoice(
              message.sessionId,
              message.localId,
              message.createTime,
              message.serverId
            )
            if (!voice.success || !voice.data) {
              const detail = voice.error || '未知原因'
              const reason = /未找到|不存在|获取语音数据失败/.test(detail)
                ? `语音文件缺失：${detail}`
                : /Silk|解码|数据为空/.test(detail)
                  ? `语音解析失败：${detail}`
                  : `语音格式不支持或读取失败：${detail}`
              keepMediaError(request, message, reason)
              continue
            }
            const voiceName = `voice_${hashPart(exportMessageKey(message, request.userMd5))}.wav`
            const audioBuffer = Buffer.from(voice.data, 'base64')
            await fs.writeFile(join(outputDir, 'voices', voiceName), audioBuffer)
            message.voiceDataUrl = `voices/${voiceName}`
            message.voiceDuration = Math.max(1, Math.round(audioBuffer.length / (24000 * 2)))
            if (request.includeVoiceTranscripts) {
              if (!voiceRecognition) {
                message.voiceTranscriptError = '语音转文字服务不可用'
              } else {
                const recognition = await voiceRecognition.recognize({
                  sessionId: message.sessionId,
                  localId: message.localId,
                  createTime: message.createTime,
                  svrId: message.serverId
                })
                if (recognition.success) {
                  message.voiceTranscript = recognition.transcript?.trim() || '未识别出文字'
                } else {
                  message.voiceTranscriptError = recognition.error || '语音识别失败'
                }
              }
            }
          } catch (error) {
            keepMediaError(
              request,
              message,
              `语音文件写入失败：${error instanceof Error ? error.message : String(error)}`
            )
          }
        }
      } else if (request.includeMedia) {
        for (const message of messages) {
          if (kindOf(message) === 'voice') {
            keepMediaError(request, message, '数据库未连接，无法读取本地语音')
          }
        }
      }
      for (const [index, message] of messages.entries()) {
        message.exportShowAvatar = request.includeAvatars !== false
        const avatar = (message.senderId ? avatarMap[message.senderId] : undefined) || message.img
        const resolvedAvatar = avatar ? await readAvatarAsset(avatar) : null
        const avatarBuffer = resolvedAvatar?.buffer || null
        const avatarExtension = resolvedAvatar?.extension || 'jpg'
        if (avatarBuffer) {
          const avatarKey =
            message.senderId || avatar || `message_${exportMessageKey(message, request.userMd5)}`
          let avatarName = exportedAvatars.get(avatarKey)
          if (!avatarName) {
            avatarName = `avatar_${hashPart(avatarKey)}.${avatarExtension}`
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
        if (message.contentData.type === 'image') {
          if (!imageService) {
            keepMediaError(request, message, '未配置图片解密密钥，无法导出图片')
          } else {
            let fileFound = false
            let decryptedImage: { data: string; filePath: string } | null = null
            let usedFallback = false
            for (const attempt of getImageExportAttempts(request)) {
              const file = await imageService.findImageFileAsync(
                message.contentData.md5,
                message.contentData.datName,
                {
                  allowThumbnail: attempt.allowThumbnail,
                  preferThumbnail: attempt.preferThumbnail,
                  sessionId: message.sessionId,
                  sessionMd5: request.userMd5,
                  createTime: message.createTime
                }
              )
              if (!file) continue
              fileFound = true
              let decrypted = await imageService.decryptImageToBase64WithFallbackAsync(
                file,
                attempt.allowThumbnail
              )
              // Worker 启动异常时，普通 JPEG/PNG 仍可由主进程同步解析；
              // WXGF/HEVC 原图则以 Worker 的 FFmpeg 结果为准。
              if (!decrypted) {
                decrypted = imageService.decryptImageToBase64WithFallback(
                  file,
                  attempt.allowThumbnail
                )
              }
              if (!decrypted) continue
              decryptedImage = decrypted
              usedFallback = attempt.fallback || imageService.isThumbnailFile(decrypted.filePath)
              break
            }
            const decoded = decryptedImage ? decodeDataUrl(decryptedImage.data) : null
            if (decoded) {
              const name = `image_${hashPart(exportMessageKey(message, request.userMd5))}.${decoded.extension}`
              await fs.writeFile(join(outputDir, 'media', name), decoded.buffer)
              message.exportMediaUrl = `media/${name}`
              message.exportMediaType = 'image'
              if (usedFallback) {
                keepMediaError(request, message, '原图不可用，已降级使用缩略图')
              }
            } else if (!fileFound) {
              keepMediaError(
                request,
                message,
                request.fallbackThumbnail === false
                  ? '原图文件缺失，未启用缩略图降级'
                  : '原图和缩略图文件均缺失'
              )
            } else {
              keepMediaError(request, message, '图片解析失败或当前格式不支持')
            }
          }
        } else if (message.contentData.type === 'video') {
          const hashes = [
            message.contentData.md5,
            message.contentData.newMd5,
            message.contentData.rawMd5
          ].filter((value): value is string => Boolean(value))
          if (!videoService) {
            keepMediaError(request, message, '数据库未连接，无法定位本地视频')
          } else if (hashes.length === 0) {
            keepMediaError(request, message, '视频标识不完整，无法定位本地视频')
          } else {
            const resolved = videoService.resolve(hashes)
            const source = resolved.url ? videoService.pathForUrl(resolved.url) : undefined
            if (!resolved.success || !source) {
              keepMediaError(request, message, resolved.error || '视频文件缺失或已移动')
            } else if (extname(source).toLowerCase() !== '.mp4') {
              keepMediaError(request, message, '视频格式不支持，仅支持本地 MP4 文件')
            } else {
              const name = `video_${hashPart(exportMessageKey(message, request.userMd5))}.mp4`
              const copied = await copyExportAsset(source, join(outputDir, 'media', name))
              if (copied.success) {
                message.exportMediaUrl = `media/${name}`
                message.exportMediaType = 'video'
              } else {
                keepMediaError(request, message, `视频复制失败：${copied.error}`)
              }
            }
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
            const name = `sticker_${hashPart(exportMessageKey(message, request.userMd5))}.${decoded.extension}`
            await fs.writeFile(join(outputDir, 'media', name), decoded.buffer)
            message.exportMediaUrl = `media/${name}`
            message.exportMediaType = 'sticker'
          } else {
            keepMediaError(request, message, result.error || '表情资源缺失或下载失败')
          }
        } else if (message.contentData.type === 'share' && message.contentData.typeVal === '6') {
          if (!fileService) {
            keepMediaError(request, message, '数据库未连接，无法定位本地文件附件')
          } else {
            const resolved = fileService.resolve(message.contentData.title, message.createTime)
            if (!resolved.success || !resolved.filePath || !resolved.fileName) {
              keepMediaError(request, message, resolved.error || '本地文件附件缺失')
            } else {
              const name = `file_${hashPart(exportMessageKey(message, request.userMd5))}_${safeFilePart(resolved.fileName)}`
              const copied = await copyExportAsset(
                resolved.filePath,
                join(outputDir, 'media', name)
              )
              if (copied.success) {
                message.exportMediaUrl = `media/${name}`
                message.exportMediaType = 'file'
                message.exportMediaName = message.contentData.title || resolved.fileName
              } else {
                keepMediaError(request, message, `附件复制失败：${copied.error}`)
              }
            }
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
      const mergedMessages = mergeHtmlArchiveMessages(
        previousArchive.messages,
        messages,
        request.userMd5
      )
      const archive: HtmlExportArchive = {
        version: 1,
        sourceId: request.userMd5,
        name: request.name,
        exportedAt: new Date().toISOString(),
        messages: normalizeHtmlArchiveSelfNames(mergedMessages, selfInfo)
      }
      await fs.writeFile(outputPath, renderExportPage(request.name), 'utf8')
      await writeHtmlArchive(outputDir, archive)
      send({
        jobId: request.jobId,
        phase: 'completed',
        processed: archive.messages.length,
        total: archive.messages.length,
        percent: 100,
        outputPath
      })
      return { success: true, outputPath, messageCount: archive.messages.length }
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
