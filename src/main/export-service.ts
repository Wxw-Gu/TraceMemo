import { app, BrowserWindow, nativeImage, shell } from 'electron'
import { createHash } from 'crypto'
import { createReadStream, createWriteStream, promises as fs } from 'fs'
import { extname, join } from 'path'
import { fileURLToPath } from 'url'
import { ZipArchive, type Archiver } from 'archiver'
import * as chat from './services/chat-service'
import type {
  ExportJobProgress,
  ExportMessageKind,
  ExportRequest,
  ExportResult,
  ExportTarget
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
import { mergeCachedSelfInfo, type CachedSelfInfo } from './services/bootstrap-cache'
import type { VoiceRecognitionUseCase } from './voice-pipeline/voice-recognition-use-case'
import { imageFileQuality } from '../shared/image-quality'
import { resolveMemberName } from '../shared/member-names'

const jobs = new Set<string>()
const activeArchives = new Map<string, Archiver>()
const safeFilePart = (value: string): string =>
  value.replace(/[\\/:*?"<>|]/g, '_').trim() || '聊天档案'
const copyWritableExportFile = async (source: string, destination: string): Promise<void> => {
  try {
    await fs.chmod(destination, 0o644)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await fs.copyFile(source, destination)
  await fs.chmod(destination, 0o644)
}
const exportStamp = (): string => {
  const date = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}
const defaultExportRoot = (): string => join(app.getPath('documents'), 'TraceMemo', '导出')
const legacyExportRoot = (): string => join(app.getPath('documents'), 'WechatExplorer', '导出')
const resolveDefaultExportRoot = async (outputFolder?: string): Promise<string> => {
  if (!outputFolder) return defaultExportRoot()
  try {
    await fs.access(join(legacyExportRoot(), outputFolder))
    // Continue incremental exports in the legacy folder when it already exists.
    return legacyExportRoot()
  } catch {
    return defaultExportRoot()
  }
}
const imageKeys = new ImageKeyConfigService()

export interface HtmlExportConversation {
  id: string
  name: string
  type: 'user' | 'group'
  avatarUrl?: string
  messageCount: number
}

interface HtmlExportAvatarVersion {
  sourceHash: string
  visualHash?: string
  avatarUrl: string
}

interface HtmlExportArchiveV1 {
  version: 1
  sourceId: string
  name: string
  exportedAt: string
  messages: Message[]
}

export interface HtmlExportArchive {
  version: 2
  name: string
  exportedAt: string
  conversations: HtmlExportConversation[]
  messages: Message[]
  avatarVersions?: Record<string, HtmlExportAvatarVersion>
}

const htmlArchiveResourcePrefixes = {
  voices: ['voice_'],
  media: ['image_', 'video_', 'sticker_', 'file_'],
  files: ['file_'],
  avatars: ['avatar_', 'conversation_']
} as const
type HtmlArchiveResourceDirectory = keyof typeof htmlArchiveResourcePrefixes

const archiveDataPrefix = 'window.__WECHAT_EXPORT__ = '
const hashPart = (value: string, length = 16): string =>
  createHash('sha1').update(value).digest('hex').slice(0, length)
const bufferHashPart = (buffer: Buffer, length = 16): string =>
  createHash('sha1').update(buffer).digest('hex').slice(0, length)
const fileHashPart = async (filePath: string, length = 16): Promise<string> => {
  const hash = createHash('sha1')
  await new Promise<void>((resolve, reject) => {
    const input = createReadStream(filePath)
    input.on('data', (chunk) => hash.update(chunk))
    input.once('end', resolve)
    input.once('error', reject)
  })
  return hash.digest('hex').slice(0, length)
}
const avatarFileName = (source: string, buffer: Buffer, extension: string): string =>
  `avatar_${/^https?:\/\//i.test(source) ? hashPart(source) : bufferHashPart(buffer)}.${extension}`
const avatarVersionFileName = (source: string, buffer: Buffer, extension: string): string =>
  `avatar_${hashPart(source)}_${bufferHashPart(buffer)}.${extension}`
const avatarSourceHash = (source: string): string => hashPart(source, 24)
const avatarIdentityKey = (conversationId: string, message: Message): string =>
  `${conversationId}:${
    message.senderId ||
    (message.isSender ? '__self__' : message.from || message.name || '__unknown__')
  }`

const avatarVisualHash = (buffer: Buffer): string | null => {
  try {
    const image = nativeImage.createFromBuffer(buffer)
    if (image.isEmpty()) return null
    const bitmap = image.resize({ width: 9, height: 8, quality: 'good' }).toBitmap()
    if (bitmap.length < 9 * 8 * 4) return null
    let hash = 0n
    let red = 0
    let green = 0
    let blue = 0
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        const left = (y * 9 + x) * 4
        const right = left + 4
        blue += bitmap[left]
        green += bitmap[left + 1]
        red += bitmap[left + 2]
        const leftLuma = bitmap[left + 2] * 3 + bitmap[left + 1] * 6 + bitmap[left]
        const rightLuma = bitmap[right + 2] * 3 + bitmap[right + 1] * 6 + bitmap[right]
        hash = (hash << 1n) | (leftLuma > rightLuma ? 1n : 0n)
      }
    }
    const averageHex = [red, green, blue]
      .map((total) =>
        Math.round(total / 64)
          .toString(16)
          .padStart(2, '0')
      )
      .join('')
    return `${hash.toString(16).padStart(16, '0')}:${averageHex}`
  } catch {
    return null
  }
}

const parseAvatarVisualHash = (value: string): { shape: bigint; color: number[] } | null => {
  const match = /^([0-9a-f]{16}):([0-9a-f]{6})$/i.exec(value)
  if (!match) return null
  return {
    shape: BigInt(`0x${match[1]}`),
    color: [0, 2, 4].map((offset) => Number.parseInt(match[2].slice(offset, offset + 2), 16))
  }
}

const avatarHashDistance = (left: bigint, right: bigint): number => {
  let difference = left ^ right
  let distance = 0
  while (difference) {
    difference &= difference - 1n
    distance += 1
  }
  return distance
}

const avatarsLookTheSame = (left?: string | null, right?: string | null): boolean => {
  if (!left || !right) return false
  const leftHash = parseAvatarVisualHash(left)
  const rightHash = parseAvatarVisualHash(right)
  if (!leftHash || !rightHash || avatarHashDistance(leftHash.shape, rightHash.shape) > 5) {
    return false
  }
  return leftHash.color.every((channel, index) => Math.abs(channel - rightHash.color[index]) <= 12)
}

const htmlArchiveSourceSignature = (message: Message): string =>
  JSON.stringify([
    message.type,
    message.content,
    message.contentData || null,
    message.localId || null,
    message.serverId || null,
    message.createTime || null,
    message.sessionId || null,
    message.senderId || null,
    message.isSender,
    message.recalled || false,
    message.recalledBy || null
  ])

const htmlArchiveResourcePath = (outputDir: string, value?: string): string | null => {
  if (!value) return null
  const normalized = value.replace(/\\/g, '/').split(/[?#]/, 1)[0]
  const [directory, fileName, ...rest] = normalized.split('/')
  if (
    !directory ||
    !fileName ||
    rest.length > 0 ||
    !Object.prototype.hasOwnProperty.call(htmlArchiveResourcePrefixes, directory)
  ) {
    return null
  }
  return join(outputDir, directory, fileName)
}

const htmlArchiveResourceExists = async (outputDir: string, value?: string): Promise<boolean> => {
  const filePath = htmlArchiveResourcePath(outputDir, value)
  if (!filePath) return false
  try {
    const stat = await fs.stat(filePath)
    if (!stat.isFile()) return false
    if ((stat.mode & 0o200) === 0) await fs.chmod(filePath, 0o644)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export const exportMessageKey = (message: Message, sourceId = ''): string => {
  const conversationId = message.exportConversationId || sourceId
  const sessionId = message.sessionId || sourceId
  if (message.localId && message.createTime) {
    return `${conversationId}:${sessionId}:local:${message.localId}:${message.createTime}`
  }
  if (message.serverId) return `${conversationId}:${sessionId}:server:${message.serverId}`
  if (message.id && message.createTime && !/^0\.\d+$/.test(message.id)) {
    return `${conversationId}:${sessionId}:id:${message.id}:${message.createTime}`
  }
  return `${conversationId}:${sessionId}:fallback:${hashPart(
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
    'exportMediaQuality',
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
  if (merged.voiceDataUrl) delete merged.exportMediaError
  if (merged.voiceTranscript) delete merged.voiceTranscriptError
  return merged
}

export function mergeHtmlArchiveMessages(
  previous: Message[],
  current: Message[],
  sourceId = '',
  conversationOrder: string[] = []
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
    const byConversation =
      conversationOrder.indexOf(left.exportConversationId || sourceId) -
      conversationOrder.indexOf(right.exportConversationId || sourceId)
    if (byConversation !== 0) return byConversation
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

export function stripHtmlArchiveInlineAvatars(messages: Message[]): Message[] {
  return messages.map((message) => {
    if (message.img == null) return message
    const archiveMessage = { ...message }
    delete archiveMessage.img
    return archiveMessage
  })
}

export async function readHtmlArchive(
  outputDir: string,
  targets: ExportTarget[],
  name: string,
  allowTargetChanges = false
): Promise<HtmlExportArchive> {
  const dataPath = join(outputDir, 'data', 'messages.js')
  let source = ''
  try {
    source = await fs.readFile(dataPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        version: 2,
        name,
        exportedAt: new Date(0).toISOString(),
        conversations: targets.map((target) => ({
          id: target.userMd5,
          name: target.name,
          type: target.type,
          messageCount: 0
        })),
        messages: []
      }
    }
    throw error
  }
  const assignment = source.indexOf('=')
  if (assignment < 0) throw new Error('现有 HTML 档案数据格式无法识别，请更换导出名称')
  const json = source
    .slice(assignment + 1)
    .trim()
    .replace(/;\s*$/, '')
  let parsed: HtmlExportArchive | HtmlExportArchiveV1
  try {
    parsed = JSON.parse(json) as HtmlExportArchive | HtmlExportArchiveV1
  } catch {
    throw new Error('现有 HTML 档案数据已损坏，请从 messages.js.bak 恢复或更换导出名称')
  }
  const expectedIds = targets.map((target) => target.userMd5).sort()
  if (parsed.version === 1) {
    if (targets.length !== 1 || parsed.sourceId !== targets[0].userMd5) {
      throw new Error('同名导出目录的聊天集合不同，请修改文件名称后重试')
    }
    return {
      version: 2,
      name: parsed.name || name,
      exportedAt: parsed.exportedAt || new Date(0).toISOString(),
      conversations: [
        {
          id: targets[0].userMd5,
          name: targets[0].name,
          type: targets[0].type,
          messageCount: Array.isArray(parsed.messages) ? parsed.messages.length : 0
        }
      ],
      messages: (Array.isArray(parsed.messages) ? parsed.messages : []).map((message) => ({
        ...message,
        exportConversationId: targets[0].userMd5,
        exportConversationName: targets[0].name
      }))
    }
  }
  const actualIds = (Array.isArray(parsed.conversations) ? parsed.conversations : [])
    .map((conversation) => conversation.id)
    .sort()
  if (!allowTargetChanges && actualIds.join('|') !== expectedIds.join('|')) {
    throw new Error('同名导出目录的聊天集合不同，请修改文件名称后重试')
  }
  return {
    version: 2,
    name: parsed.name || name,
    exportedAt: parsed.exportedAt || new Date(0).toISOString(),
    conversations: parsed.conversations,
    messages: Array.isArray(parsed.messages) ? parsed.messages : [],
    avatarVersions: parsed.avatarVersions
  }
}

async function writeZipArchive(
  outputDir: string,
  zipPath: string,
  folderName: string,
  jobId: string
): Promise<void> {
  const temporaryPath = `${zipPath}.tmp-${process.pid}-${Date.now()}`
  await fs.rm(temporaryPath, { force: true })
  const output = createWriteStream(temporaryPath)
  await new Promise<void>((resolve, reject) => {
    output.once('open', () => resolve())
    output.once('error', reject)
  })
  const archive = new ZipArchive({ zlib: { level: 6 } })
  activeArchives.set(jobId, archive)
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        if (error) reject(error)
        else resolve()
      }
      output.on('close', () => finish())
      output.on('error', finish)
      archive.on('warning', (error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') finish(error)
      })
      archive.on('error', finish)
      archive.pipe(output)
      archive.directory(outputDir, safeFilePart(folderName))
      void archive.finalize().catch(finish)
    })
    if (!jobs.has(jobId)) throw new Error('已取消')
    try {
      await fs.rename(temporaryPath, zipPath)
    } catch (error) {
      if (!['EEXIST', 'EPERM'].includes((error as NodeJS.ErrnoException).code || '')) throw error
      await fs.rm(zipPath, { force: true })
      await fs.rename(temporaryPath, zipPath)
    }
  } finally {
    activeArchives.delete(jobId)
    if (!output.closed) {
      output.destroy()
      await new Promise<void>((resolve) => output.once('close', () => resolve()))
    }
    await fs.rm(temporaryPath, { force: true })
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
  await fs.writeFile(
    join(dataDir, 'conversations.json'),
    JSON.stringify(
      {
        version: archive.version,
        name: archive.name,
        exportedAt: archive.exportedAt,
        conversations: archive.conversations
      },
      null,
      2
    ),
    'utf8'
  )
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

export async function pruneHtmlArchiveResources(
  outputDir: string,
  archive: HtmlExportArchive
): Promise<void> {
  const referenced = Object.fromEntries(
    Object.keys(htmlArchiveResourcePrefixes).map((directory) => [directory, new Set<string>()])
  ) as Record<HtmlArchiveResourceDirectory, Set<string>>
  const addReference = (value?: string): void => {
    if (!value) return
    const path = value.replace(/\\/g, '/').split(/[?#]/, 1)[0]
    const separator = path.indexOf('/')
    if (separator <= 0 || path.indexOf('/', separator + 1) >= 0) return
    const directory = path.slice(0, separator) as HtmlArchiveResourceDirectory
    const fileName = path.slice(separator + 1)
    if (!referenced[directory] || !fileName) return
    referenced[directory].add(fileName)
  }

  for (const conversation of archive.conversations) addReference(conversation.avatarUrl)
  for (const message of archive.messages) {
    addReference(message.voiceDataUrl)
    addReference(message.exportMediaUrl)
    addReference(message.exportAvatarUrl)
  }

  for (const [directory, prefixes] of Object.entries(htmlArchiveResourcePrefixes) as [
    HtmlArchiveResourceDirectory,
    readonly string[]
  ][]) {
    let entries
    try {
      entries = await fs.readdir(join(outputDir, directory), { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    for (const entry of entries) {
      if (
        entry.isFile() &&
        prefixes.some((prefix) => entry.name.startsWith(prefix)) &&
        !referenced[directory].has(entry.name)
      ) {
        await fs.unlink(join(outputDir, directory, entry.name))
      }
    }
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

interface SingleExportOptions {
  outputRoot?: string
  outputFolderName?: string
  manageJob?: boolean
  sendProgress?: (progress: ExportJobProgress) => void
  selfInfo?: CachedSelfInfo | null
}

interface AllExportManifestEntry {
  id: string
  name: string
  type: ExportTarget['type']
  folder: string
  messageCount: number
}

const writeAllExportManifest = async (
  outputDir: string,
  conversations: AllExportManifestEntry[],
  messageCount: number,
  status: 'running' | 'completed' | 'cancelled' | 'failed',
  error?: string
): Promise<void> => {
  const manifestPath = join(outputDir, '导出清单.json')
  const temporaryPath = `${manifestPath}.tmp-${process.pid}-${Date.now()}`
  await fs.writeFile(
    temporaryPath,
    JSON.stringify(
      {
        version: 1,
        status,
        exportedAt: new Date().toISOString(),
        messageCount,
        conversations,
        error
      },
      null,
      2
    ),
    'utf8'
  )
  try {
    await fs.rename(temporaryPath, manifestPath)
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes((error as NodeJS.ErrnoException).code || '')) throw error
    await fs.rm(manifestPath, { force: true })
    await fs.rename(temporaryPath, manifestPath)
  } finally {
    await fs.rm(temporaryPath, { force: true })
  }
}

const conversationFolderNames = (targets: ExportTarget[]): Map<string, string> => {
  const names = new Map<string, string>()
  const used = new Set<string>()
  for (const target of targets) {
    const base = safeFilePart(target.name).slice(0, 80).trim() || '未命名聊天'
    let candidate = base
    const usedKey = (value: string): string => `${target.type}:${value.toLowerCase()}`
    if (used.has(usedKey(candidate))) {
      candidate = `${base}_${hashPart(target.userMd5, 8)}`
    }
    let suffix = 2
    while (used.has(usedKey(candidate))) {
      candidate = `${base}_${hashPart(target.userMd5, 8)}_${suffix}`
      suffix += 1
    }
    used.add(usedKey(candidate))
    names.set(target.userMd5, candidate)
  }
  return names
}

const pathExists = async (value: string): Promise<boolean> => {
  try {
    await fs.stat(value)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

const preserveLegacyCombinedArchive = async (outputDir: string): Promise<void> => {
  const legacyIndex = join(outputDir, 'index.html')
  const legacyData = join(outputDir, 'data', 'messages.js')
  if (!(await pathExists(legacyIndex)) || !(await pathExists(legacyData))) return

  let legacyDir = join(outputDir, '旧版合并档案')
  if (await pathExists(legacyDir)) {
    legacyDir = join(outputDir, `旧版合并档案_${exportStamp()}`)
  }
  await fs.mkdir(legacyDir, { recursive: true })
  for (const entry of ['index.html', 'data', 'avatars', 'media', 'voices', 'files']) {
    const source = join(outputDir, entry)
    if (await pathExists(source)) await fs.rename(source, join(legacyDir, entry))
  }
}

async function runSingleExport(
  request: ExportRequest,
  win: BrowserWindow,
  voiceRecognition?: Pick<VoiceRecognitionUseCase, 'recognize'> &
    Partial<Pick<VoiceRecognitionUseCase, 'publishTranscript'>>,
  options: SingleExportOptions = {}
): Promise<ExportResult> {
  const manageJob = options.manageJob !== false
  if (manageJob) jobs.add(request.jobId)
  const send =
    options.sendProgress ||
    ((p: ExportJobProgress): void => {
      if (!win.isDestroyed()) win.webContents.send('export:progress', p)
    })
  try {
    const targets = (request.targets || []).map((target) => ({
      ...target,
      nameMap: { ...(target.nameMap || {}) },
      avatarUrls: { ...(target.avatarUrls || {}) }
    }))
    const targetLimit = request.scope === 'all' ? null : 5
    if (targets.length < 1 || (targetLimit !== null && targets.length > targetLimit)) {
      throw new Error(
        targetLimit === null ? '全部导出至少需要一个聊天' : '一次导出必须选择 1 到 5 个聊天'
      )
    }
    if (new Set(targets.map((target) => target.userMd5)).size !== targets.length) {
      throw new Error('导出聊天不能重复')
    }
    if (targets.length > 1 && request.format !== 'html') {
      throw new Error('多聊天合并仅支持 HTML 格式')
    }
    const archiveName = safeFilePart(request.outputName)
    const targetById = new Map(targets.map((target) => [target.userMd5, target]))
    send({ jobId: request.jobId, phase: 'reading', processed: 0, total: 100, percent: 0 })
    await new Promise<void>((resolve) => setImmediate(resolve))
    const messageEntries: { message: Message; targetOrder: number; messageOrder: number }[] = []
    for (const [targetOrder, target] of targets.entries()) {
      if (!jobs.has(request.jobId)) {
        send({ jobId: request.jobId, phase: 'cancelled', processed: 0, percent: 5 })
        return { success: false, error: '已取消' }
      }
      if (
        target.type === 'group' &&
        (request.scope === 'all' || !Object.keys(target.nameMap || {}).length)
      ) {
        const snapshot = await chat.getGroupSnapshotAsync(target.userMd5)
        for (const member of snapshot?.members || []) {
          target.nameMap![member.wxid] = resolveMemberName(
            {
              wxid: member.wxid,
              nickname: member.nickname,
              groupNickname: member.groupNickname,
              wechatNickname: member.wechatNickname,
              remark: member.remark
            },
            target.nameMode || 'groupNickname'
          )
          if (member.avatar) target.avatarUrls![member.wxid] = member.avatar
        }
      }
      const targetMessages = (
        await chat.listMessagesForExport(target.userMd5, request.startTime, request.endTime)
      ).filter((message) => request.kinds.includes(kindOf(message)))
      for (const [messageOrder, message] of targetMessages.entries()) {
        messageEntries.push({
          message: {
            ...message,
            exportConversationId: target.userMd5,
            exportConversationName: target.name
          },
          targetOrder,
          messageOrder
        })
      }
      send({
        jobId: request.jobId,
        phase: 'reading',
        processed: targetOrder + 1,
        total: targets.length,
        percent: Math.max(1, Math.round(((targetOrder + 1) / targets.length) * 10))
      })
    }
    const messages = messageEntries
      .sort((left, right) => {
        const byTime = Number(left.message.createTime || 0) - Number(right.message.createTime || 0)
        if (byTime !== 0) return byTime
        if (left.targetOrder !== right.targetOrder) return left.targetOrder - right.targetOrder
        return left.messageOrder - right.messageOrder
      })
      .map((entry) => entry.message)
    const selfInfo =
      options.selfInfo !== undefined
        ? options.selfInfo
        : await chat
            .getSelfAccountInfoAsync()
            .then((value) => (value ? mergeCachedSelfInfo(value.accountRoot, value) : null))
    const client = chat.getChatDb()?.getWcdb4Client()
    const isUsableSelfName = (value: string | undefined): value is string => {
      const name = String(value || '').trim()
      if (!name) return false
      if (name === selfInfo?.wxid) return false
      if (/^wxid_/i.test(name)) return false
      return true
    }
    send({
      jobId: request.jobId,
      phase: 'parsing',
      processed: 0,
      total: messages.length,
      percent: 12
    })
    for (const message of messages) {
      const target = targetById.get(message.exportConversationId || '')
      const peerUsername = target ? client?.getUsernameByMd5(target.userMd5) || '' : ''
      const isGroupChat = target?.type === 'group' || peerUsername.endsWith('@chatroom')
      message.exportMediaUrl = undefined
      message.exportMediaType = undefined
      message.exportMediaName = undefined
      message.exportMediaQuality = undefined
      message.exportMediaError = undefined
      message.voiceDataUrl = undefined
      message.voiceTranscript = undefined
      message.voiceTranscriptError = undefined
      message.exportShowAvatar = request.includeAvatars !== false
      if (!isGroupChat && !message.senderId) {
        message.senderId = message.isSender ? selfInfo?.wxid : peerUsername || message.sessionId
      }
      const mappedName = message.senderId ? target?.nameMap?.[message.senderId] : undefined
      if (!isGroupChat) {
        message.name = message.isSender
          ? isUsableSelfName(selfInfo?.nickname)
            ? selfInfo.nickname
            : isUsableSelfName(message.name)
              ? message.name
              : '我'
          : target?.name || message.name || '联系人'
        if (!message.img) {
          message.img = message.isSender ? selfInfo?.avatar : target?.avatarUrl
        }
      } else if (mappedName && (!message.isSender || isUsableSelfName(mappedName))) {
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
    send({
      jobId: request.jobId,
      phase: 'parsing',
      processed: messages.length,
      total: messages.length,
      percent: 15
    })
    if (!jobs.has(request.jobId)) {
      send({ jobId: request.jobId, phase: 'cancelled', processed: 0, percent: 10 })
      return { success: false, error: '已取消' }
    }
    send({
      jobId: request.jobId,
      phase: request.format === 'html' ? 'parsing' : 'writing',
      processed: 0,
      total: messages.length,
      percent: request.format === 'html' ? 18 : 20
    })
    const ext = request.format === 'markdown' ? 'md' : request.format
    const outputFolder =
      request.format === 'html'
        ? options.outputFolderName || safeFilePart(request.outputName)
        : `${safeFilePart(request.outputName)}_${exportStamp()}`
    const root = options.outputRoot || request.outputDirectory || (await resolveDefaultExportRoot(outputFolder))
    await fs.mkdir(root, { recursive: true })
    const outputDir = join(root, outputFolder)
    const outputPath =
      request.format === 'html'
        ? join(outputDir, 'index.html')
        : join(root, `${outputFolder}.${ext}`)
    if (request.format === 'html') {
      const previousArchive = await readHtmlArchive(
        outputDir,
        targets,
        archiveName,
        request.scope === 'all'
      )
      const currentTargetIds = new Set(targets.map((target) => target.userMd5))
      const previousMessages =
        request.scope === 'all'
          ? previousArchive.messages.filter((message) =>
              currentTargetIds.has(message.exportConversationId || targets[0].userMd5)
            )
          : previousArchive.messages
      const previousMessagesByKey = new Map(
        previousMessages.map((message) => [exportMessageKey(message), message])
      )
      const latestPreviousAvatarUrls = new Map<string, string>()
      for (const message of previousMessages) {
        if (!message.exportAvatarUrl) continue
        const conversationId = message.exportConversationId || targets[0].userMd5
        latestPreviousAvatarUrls.set(
          avatarIdentityKey(conversationId, message),
          message.exportAvatarUrl
        )
      }
      const reusablePreviousMessages = new Map<Message, Message>()
      for (const message of messages) {
        const previous = previousMessagesByKey.get(exportMessageKey(message))
        if (
          previous &&
          htmlArchiveSourceSignature(previous) === htmlArchiveSourceSignature(message)
        ) {
          reusablePreviousMessages.set(message, previous)
        }
      }
      const resourceExistence = new Map<string, Promise<boolean>>()
      const resourceExists = (value?: string): Promise<boolean> => {
        if (!value) return Promise.resolve(false)
        const existing = resourceExistence.get(value)
        if (existing) return existing
        const pending = htmlArchiveResourceExists(outputDir, value)
        resourceExistence.set(value, pending)
        return pending
      }
      const markResourceExists = (value: string): void => {
        resourceExistence.set(value, Promise.resolve(true))
      }
      await fs.mkdir(join(outputDir, 'voices'), { recursive: true })
      await fs.mkdir(join(outputDir, 'media'), { recursive: true })
      await fs.mkdir(join(outputDir, 'files'), { recursive: true })
      await fs.mkdir(join(outputDir, 'avatars'), { recursive: true })
      const avatarUsernames = Array.from(
        new Set(
          messages
            .map((message) => message.senderId)
            .filter((value): value is string => Boolean(value))
        )
      )
      const requestedAvatarUrls = Object.assign(
        {},
        ...targets.map((target) => target.avatarUrls || {})
      ) as Record<string, string>
      const avatarMap =
        request.includeAvatars === false
          ? {}
          : { ...(await chat.getContactAvatars(avatarUsernames)), ...requestedAvatarUrls }
      const imageConfig = imageKeys.getConfig()
      const imageService =
        client && imageConfig.aesKey
          ? new ImageDecryptService(imageConfig.xorKey || '0x40', imageConfig.aesKey, client)
          : null
      const videoService = client ? new VideoAssetService(client) : null
      const stickerService = client ? new StickerService(client) : null
      const fileService = client ? new FileAssetService(client) : null
      const exportedAvatars = new Map<string, string>()
      const previousAvatarVersions = previousArchive.avatarVersions || {}
      const avatarVersions: Record<string, HtmlExportAvatarVersion> = {
        ...previousAvatarVersions
      }
      const resolveExportAvatar = async (
        identity: string,
        source: string,
        legacyAvatarUrl?: string
      ): Promise<string | undefined> => {
        const sourceHash = avatarSourceHash(source)
        const previousVersion = previousAvatarVersions[identity]
        const resolved = await readAvatarAsset(source)
        if (!resolved?.buffer) return undefined
        const visualHash = avatarVisualHash(resolved.buffer)
        const previousAvatarUrl = previousVersion?.avatarUrl || legacyAvatarUrl
        if (previousAvatarUrl && (await resourceExists(previousAvatarUrl))) {
          const previousVisualHash =
            previousVersion?.visualHash ||
            avatarVisualHash(await fs.readFile(join(outputDir, previousAvatarUrl)))
          if (avatarsLookTheSame(previousVisualHash, visualHash)) {
            avatarVersions[identity] = {
              sourceHash,
              visualHash: visualHash || previousVisualHash || undefined,
              avatarUrl: previousAvatarUrl
            }
            return previousAvatarUrl
          }
        }

        const extension = resolved.extension || 'jpg'
        let avatarName = avatarFileName(source, resolved.buffer, extension)
        let avatarUrl = `avatars/${avatarName}`
        if (avatarUrl === previousAvatarUrl) {
          avatarName = avatarVersionFileName(source, resolved.buffer, extension)
          avatarUrl = `avatars/${avatarName}`
        }
        if (!(await resourceExists(avatarUrl))) {
          await fs.writeFile(join(outputDir, 'avatars', avatarName), resolved.buffer)
          markResourceExists(avatarUrl)
        }
        avatarVersions[identity] = {
          sourceHash,
          visualHash: visualHash || undefined,
          avatarUrl
        }
        return avatarUrl
      }
      const conversationAvatarUrls = new Map<string, string>()
      if (request.includeAvatars !== false) {
        for (const target of targets) {
          if (!jobs.has(request.jobId)) throw new Error('已取消')
          if (!target.avatarUrl) continue
          const avatarUrl = await resolveExportAvatar(
            `conversation:${target.userMd5}`,
            target.avatarUrl,
            previousArchive.conversations.find((item) => item.id === target.userMd5)?.avatarUrl
          )
          if (avatarUrl) conversationAvatarUrls.set(target.userMd5, avatarUrl)
        }
      }
      const voiceService =
        request.includeMedia && chat.getChatDb()
          ? new VoiceService(chat.getChatDb()!.getWcdb4Client())
          : null
      const voiceMessages = messages.filter((message) => kindOf(message) === 'voice')
      const voicePhase = request.includeVoiceTranscripts ? 'transcribing' : 'media'
      const voiceProgressEnd = request.includeVoiceTranscripts ? 50 : 35
      if (voiceService) {
        send({
          jobId: request.jobId,
          phase: voicePhase,
          processed: 0,
          total: voiceMessages.length,
          percent: 20
        })
        const voiceIndexUpdates = new Map<
          string,
          {
            reference: {
              sessionId: string
              localId: number
              createTime: number
              svrId?: string | number
            }
            transcript: string
            cached: boolean
          }
        >()
        const batchSize = 16
        for (let batchStart = 0; batchStart < voiceMessages.length; batchStart += batchSize) {
          const batch = voiceMessages.slice(batchStart, batchStart + batchSize)
          const mediaItems: Array<{
            message: Message
            reference: {
              sessionId: string
              localId: number
              createTime: number
              svrId?: string | number
            }
          }> = []
          for (const message of batch) {
            if (!jobs.has(request.jobId)) throw new Error('已取消')
            const previous = reusablePreviousMessages.get(message)
            const hasVoiceIdentity = Boolean(
              message.sessionId && message.localId != null && message.createTime
            )
            const reference = hasVoiceIdentity
              ? {
                  sessionId: message.sessionId!,
                  localId: message.localId!,
                  createTime: message.createTime!,
                  svrId: message.serverId
                }
              : null
            if (previous?.voiceDataUrl && (await resourceExists(previous.voiceDataUrl))) {
              message.voiceDataUrl = previous.voiceDataUrl
              message.voiceDuration = previous.voiceDuration
              if (request.includeVoiceTranscripts && previous.voiceTranscript) {
                message.voiceTranscript = previous.voiceTranscript
              }
            }
            if (request.includeVoiceTranscripts && !message.voiceTranscript) {
              if (!reference) {
                message.voiceTranscriptError = '语音标识不完整，无法转文字'
              } else if (!voiceRecognition) {
                message.voiceTranscriptError = '语音转文字服务不可用'
              } else {
                try {
                  const recognition = await voiceRecognition.recognize(
                    reference,
                    voiceRecognition.publishTranscript
                      ? { publishTranscriptUpdate: false }
                      : undefined
                  )
                  if (recognition.success) {
                    message.voiceTranscript = recognition.transcript?.trim() || '未识别出文字'
                    if (voiceRecognition.publishTranscript && recognition.transcript?.trim()) {
                      voiceIndexUpdates.set(reference.sessionId, {
                        reference,
                        transcript: recognition.transcript.trim(),
                        cached: Boolean(recognition.cached)
                      })
                    }
                  } else {
                    message.voiceTranscriptError = recognition.error || '语音识别失败'
                  }
                } catch (error) {
                  message.voiceTranscriptError =
                    error instanceof Error ? error.message : '语音识别失败'
                }
              }
            }
            if (
              request.includeVoiceTranscripts &&
              reference &&
              message.voiceTranscript &&
              voiceRecognition?.publishTranscript &&
              !voiceIndexUpdates.has(reference.sessionId)
            ) {
              voiceIndexUpdates.set(reference.sessionId, {
                reference,
                transcript: message.voiceTranscript,
                cached: true
              })
            }
            if (!message.voiceDataUrl) {
              if (!reference) {
                keepMediaError(request, message, '语音标识不完整，无法定位本地语音')
              } else {
                mediaItems.push({ message, reference })
              }
            }
          }

          const voices =
            typeof voiceService.resolveVoices === 'function'
              ? await voiceService.resolveVoices(mediaItems.map((item) => item.reference))
              : await Promise.all(
                  mediaItems.map(({ reference }) =>
                    voiceService.resolveVoice(
                      reference.sessionId,
                      reference.localId,
                      reference.createTime,
                      reference.svrId
                    )
                  )
                )
          for (const [{ message }, voice] of mediaItems.map(
            (item, index) => [item, voices[index]] as const
          )) {
            if (!voice?.success || !voice.data) {
              const detail = voice?.error || '未知原因'
              const reason = /未找到|不存在|获取语音数据失败/.test(detail)
                ? `语音文件缺失：${detail}`
                : /Silk|解码|数据为空/.test(detail)
                  ? `语音解析失败：${detail}`
                  : `语音格式不支持或读取失败：${detail}`
              keepMediaError(request, message, reason)
              continue
            }
            try {
              const audioBuffer = Buffer.from(voice.data, 'base64')
              const voiceName = `voice_${bufferHashPart(audioBuffer)}.wav`
              const voiceUrl = `voices/${voiceName}`
              if (!(await resourceExists(voiceUrl))) {
                await fs.writeFile(join(outputDir, 'voices', voiceName), audioBuffer)
                markResourceExists(voiceUrl)
              }
              message.voiceDataUrl = voiceUrl
              message.voiceDuration = Math.max(1, Math.round(audioBuffer.length / (24000 * 2)))
            } catch (error) {
              keepMediaError(
                request,
                message,
                `语音文件写入失败：${error instanceof Error ? error.message : String(error)}`
              )
            }
          }
          const processedVoices = Math.min(batchStart + batch.length, voiceMessages.length)
          send({
            jobId: request.jobId,
            phase: voicePhase,
            processed: processedVoices,
            total: voiceMessages.length,
            percent:
              20 +
              Math.round(
                (processedVoices / Math.max(voiceMessages.length, 1)) * (voiceProgressEnd - 20)
              )
          })
          await new Promise<void>((resolve) => setImmediate(resolve))
        }
        for (const update of voiceIndexUpdates.values()) {
          try {
            await voiceRecognition?.publishTranscript?.(
              update.reference,
              update.transcript,
              update.cached
            )
          } catch (error) {
            console.warn('[Export] voice transcript index refresh failed:', error)
          }
        }
      } else if (request.includeMedia) {
        for (const message of messages) {
          if (kindOf(message) === 'voice') {
            keepMediaError(request, message, '数据库未连接，无法读取本地语音')
          }
        }
      }
      const mediaStartPercent = voiceService ? voiceProgressEnd : 20
      const mediaPercent = (processed: number): number =>
        mediaStartPercent +
        Math.round((processed / Math.max(messages.length, 1)) * (90 - mediaStartPercent))
      send({
        jobId: request.jobId,
        phase: 'media',
        processed: 0,
        total: messages.length,
        percent: mediaStartPercent
      })
      for (const [index, message] of messages.entries()) {
        if (!jobs.has(request.jobId)) {
          send({
            jobId: request.jobId,
            phase: 'cancelled',
            processed: index,
            total: messages.length,
            percent: mediaPercent(index)
          })
          return { success: false, error: '已取消' }
        }
        const conversationId = message.exportConversationId || targets[0].userMd5
        message.exportShowAvatar = request.includeAvatars !== false
        const previous = reusablePreviousMessages.get(message)
        const previousMessage = previousMessagesByKey.get(exportMessageKey(message))
        const avatar = (message.senderId ? avatarMap[message.senderId] : undefined) || message.img
        const avatarKey = avatarIdentityKey(conversationId, message)
        let avatarUrl: string | undefined
        if (
          request.includeAvatars !== false &&
          previousMessage?.exportAvatarUrl &&
          (await resourceExists(previousMessage.exportAvatarUrl))
        ) {
          avatarUrl = previousMessage.exportAvatarUrl
        } else if (request.includeAvatars !== false && avatar) {
          avatarUrl = exportedAvatars.get(avatarKey)
          if (!avatarUrl) {
            avatarUrl = await resolveExportAvatar(
              avatarKey,
              avatar,
              latestPreviousAvatarUrls.get(avatarKey)
            )
            if (avatarUrl) exportedAvatars.set(avatarKey, avatarUrl)
          }
        }
        if (avatarUrl) message.exportAvatarUrl = avatarUrl
        if (!request.includeMedia || !message.contentData) {
          send({
            jobId: request.jobId,
            phase: 'media',
            processed: index + 1,
            total: messages.length,
            percent: mediaPercent(index + 1)
          })
          continue
        }
        const reusableMediaType =
          message.contentData.type === 'image' ||
          message.contentData.type === 'video' ||
          message.contentData.type === 'sticker'
            ? message.contentData.type
            : message.contentData.type === 'share' && message.contentData.typeVal === '6'
              ? 'file'
              : null
        const reusableImageQuality =
          previous?.exportMediaQuality === 'original' ||
          (request.preferOriginal === false && previous?.exportMediaQuality === 'thumbnail')
        if (
          reusableMediaType &&
          previous?.exportMediaUrl &&
          (!previous.exportMediaType || previous.exportMediaType === reusableMediaType) &&
          (reusableMediaType !== 'image' || reusableImageQuality) &&
          (await resourceExists(previous.exportMediaUrl))
        ) {
          message.exportMediaUrl = previous.exportMediaUrl
          message.exportMediaType = reusableMediaType
          message.exportMediaName = previous.exportMediaName
          message.exportMediaQuality = previous.exportMediaQuality
          send({
            jobId: request.jobId,
            phase: 'media',
            processed: index + 1,
            total: messages.length,
            percent: mediaPercent(index + 1)
          })
          continue
        }
        if (message.contentData.type === 'image') {
          if (!imageService) {
            keepMediaError(request, message, '未配置图片解密密钥，无法导出图片')
          } else {
            let fileFound = false
            let decryptedImage: { data: string; filePath: string } | null = null
            for (const attempt of getImageExportAttempts(request)) {
              const file = await imageService.findImageFileAsync(
                message.contentData.md5,
                message.contentData.datName,
                {
                  allowThumbnail: attempt.allowThumbnail,
                  preferThumbnail: attempt.preferThumbnail,
                  sessionId: message.sessionId,
                  sessionMd5: conversationId,
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
              break
            }
            const decoded = decryptedImage ? decodeDataUrl(decryptedImage.data) : null
            if (decoded) {
              const name = `image_${bufferHashPart(decoded.buffer)}.${decoded.extension}`
              const mediaUrl = `media/${name}`
              if (!(await resourceExists(mediaUrl))) {
                await fs.writeFile(join(outputDir, 'media', name), decoded.buffer)
                markResourceExists(mediaUrl)
              }
              message.exportMediaUrl = mediaUrl
              message.exportMediaType = 'image'
              message.exportMediaQuality = imageFileQuality(decryptedImage!.filePath)
              if (request.preferOriginal !== false && message.exportMediaQuality === 'thumbnail') {
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
          } else {
            const resolved = await videoService.resolve(hashes, {
              createTime: message.createTime,
              byteLength: message.contentData.byteLength,
              duration: message.contentData.duration,
              width: message.contentData.width,
              height: message.contentData.height
            })
            const source = resolved.url ? videoService.pathForUrl(resolved.url) : undefined
            if (!resolved.success || !source) {
              keepMediaError(request, message, resolved.error || '视频文件缺失或已移动')
            } else if (extname(source).toLowerCase() !== '.mp4') {
              keepMediaError(request, message, '视频格式不支持，仅支持本地 MP4 文件')
            } else {
              const name = `video_${await fileHashPart(source)}.mp4`
              const mediaUrl = `media/${name}`
              if (!(await resourceExists(mediaUrl))) {
                await copyWritableExportFile(source, join(outputDir, 'media', name))
                markResourceExists(mediaUrl)
              }
              message.exportMediaUrl = mediaUrl
              message.exportMediaType = 'video'
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
            const name = `sticker_${bufferHashPart(decoded.buffer)}.${decoded.extension}`
            const mediaUrl = `media/${name}`
            if (!(await resourceExists(mediaUrl))) {
              await fs.writeFile(join(outputDir, 'media', name), decoded.buffer)
              markResourceExists(mediaUrl)
            }
            message.exportMediaUrl = mediaUrl
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
              const name = `file_${await fileHashPart(resolved.filePath)}_${safeFilePart(resolved.fileName)}`
              const mediaUrl = `files/${name}`
              if (!(await resourceExists(mediaUrl))) {
                await copyWritableExportFile(resolved.filePath, join(outputDir, 'files', name))
                markResourceExists(mediaUrl)
              }
              message.exportMediaUrl = mediaUrl
              message.exportMediaType = 'file'
              message.exportMediaName = message.contentData.title || resolved.fileName
            }
          }
        }
        send({
          jobId: request.jobId,
          phase: 'media',
          processed: index + 1,
          total: messages.length,
          percent: mediaPercent(index + 1)
        })
      }
      const mergedMessages = mergeHtmlArchiveMessages(
        previousMessages,
        messages,
        '',
        targets.map((target) => target.userMd5)
      )
      const normalizedMessages = stripHtmlArchiveInlineAvatars(
        normalizeHtmlArchiveSelfNames(mergedMessages, selfInfo)
      )
      const archive: HtmlExportArchive = {
        version: 2,
        name: archiveName,
        exportedAt: new Date().toISOString(),
        conversations: targets.map((target) => ({
          id: target.userMd5,
          name: target.name,
          type: target.type,
          avatarUrl:
            conversationAvatarUrls.get(target.userMd5) ||
            previousArchive.conversations.find((item) => item.id === target.userMd5)?.avatarUrl,
          messageCount: normalizedMessages.filter(
            (message) => message.exportConversationId === target.userMd5
          ).length
        })),
        messages: normalizedMessages,
        avatarVersions
      }
      if (!jobs.has(request.jobId)) throw new Error('已取消')
      send({
        jobId: request.jobId,
        phase: 'writing',
        processed: archive.messages.length,
        total: archive.messages.length,
        percent: 92
      })
      await fs.writeFile(outputPath, renderExportPage(archiveName), 'utf8')
      await writeHtmlArchive(outputDir, archive)
      await pruneHtmlArchiveResources(outputDir, archive)
      let completedPath = outputPath
      if (request.zip) {
        if (!jobs.has(request.jobId)) return { success: false, error: '已取消' }
        const zipPath = join(root, `${outputFolder}.zip`)
        send({
          jobId: request.jobId,
          phase: 'compressing',
          processed: archive.messages.length,
          total: archive.messages.length,
          percent: 96
        })
        await writeZipArchive(outputDir, zipPath, outputFolder, request.jobId)
        completedPath = zipPath
      }
      send({
        jobId: request.jobId,
        phase: 'completed',
        processed: archive.messages.length,
        total: archive.messages.length,
        percent: 100,
        outputPath: completedPath
      })
      return { success: true, outputPath: completedPath, messageCount: archive.messages.length }
    } else {
      send({
        jobId: request.jobId,
        phase: 'writing',
        processed: messages.length,
        total: messages.length,
        percent: 90
      })
    }
    await fs.writeFile(outputPath, render(request.format, messages, archiveName), 'utf8')
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
    if (!jobs.has(request.jobId) || message === '已取消') {
      send({ jobId: request.jobId, phase: 'cancelled', processed: 0, error: '已取消' })
      return { success: false, error: '已取消' }
    }
    send({ jobId: request.jobId, phase: 'failed', processed: 0, error: message })
    return { success: false, error: message }
  } finally {
    if (manageJob) jobs.delete(request.jobId)
  }
}

async function runAllExport(
  request: ExportRequest,
  win: BrowserWindow,
  voiceRecognition?: Pick<VoiceRecognitionUseCase, 'recognize'> &
    Partial<Pick<VoiceRecognitionUseCase, 'publishTranscript'>>
): Promise<ExportResult> {
  jobs.add(request.jobId)
  const send = (progress: ExportJobProgress): void => {
    if (!win.isDestroyed()) win.webContents.send('export:progress', progress)
  }
  let outputDir = ''
  const manifest: AllExportManifestEntry[] = []
  let totalMessages = 0
  try {
    const targets = [...(request.targets || [])].sort((left, right) =>
      left.type === right.type ? 0 : left.type === 'group' ? -1 : 1
    )
    if (!targets.length) throw new Error('全部导出至少需要一个聊天')
    if (new Set(targets.map((target) => target.userMd5)).size !== targets.length) {
      throw new Error('导出聊天不能重复')
    }

    const outputFolder = safeFilePart(request.outputName)
    const exportRoot = request.outputDirectory || (await resolveDefaultExportRoot(outputFolder))
    outputDir = join(exportRoot, outputFolder)
    const folderNames = conversationFolderNames(targets)
    let lastProgressAt = 0
    let lastProgressKey = ''
    await fs.mkdir(outputDir, { recursive: true })
    await preserveLegacyCombinedArchive(outputDir)
    const selectedTypes = request.allContactTypes?.length
      ? request.allContactTypes
      : Array.from(new Set(targets.map((target) => target.type)))
    for (const type of selectedTypes) {
      await fs.mkdir(join(outputDir, type === 'group' ? '群聊' : '联系人'), { recursive: true })
    }
    await writeAllExportManifest(outputDir, manifest, totalMessages, 'running')
    const rawSelfInfo = await chat.getSelfAccountInfoAsync()
    const selfInfo = rawSelfInfo ? mergeCachedSelfInfo(rawSelfInfo.accountRoot, rawSelfInfo) : null

    for (const [targetIndex, target] of targets.entries()) {
      if (!jobs.has(request.jobId)) throw new Error('已取消')
      const categoryName = target.type === 'group' ? '群聊' : '联系人'
      const categoryDir = join(outputDir, categoryName)
      const folderName = folderNames.get(target.userMd5) || safeFilePart(target.name)
      await fs.mkdir(categoryDir, { recursive: true })
      const conversationOutputRoot =
        request.format === 'html' ? categoryDir : join(categoryDir, folderName)
      const basePercent = Math.floor((targetIndex / targets.length) * 100)
      send({
        jobId: request.jobId,
        phase: 'reading',
        processed: 0,
        percent: basePercent,
        currentTargetIndex: targetIndex + 1,
        currentTargetCount: targets.length,
        currentTargetName: target.name,
        currentTargetType: target.type
      })

      const result = await runSingleExport(
        {
          ...request,
          targets: [target],
          outputName: target.name,
          zip: false
        },
        win,
        voiceRecognition,
        {
          outputRoot: conversationOutputRoot,
          outputFolderName: request.format === 'html' ? folderName : undefined,
          manageJob: false,
          selfInfo,
          sendProgress: (childProgress) => {
            const childPercent = Math.max(0, Math.min(100, childProgress.percent || 0))
            const percent = Math.min(
              99,
              Math.floor(((targetIndex + childPercent / 100) / targets.length) * 100)
            )
            const phase = childProgress.phase === 'completed' ? 'writing' : childProgress.phase
            const now = Date.now()
            const progressKey = `${targetIndex}:${phase}:${percent}`
            const terminal = phase === 'failed' || phase === 'cancelled'
            if (!terminal && progressKey === lastProgressKey && now - lastProgressAt < 500) return
            lastProgressKey = progressKey
            lastProgressAt = now
            send({
              ...childProgress,
              jobId: request.jobId,
              phase,
              percent,
              outputPath: undefined,
              currentTargetIndex: targetIndex + 1,
              currentTargetCount: targets.length,
              currentTargetName: target.name,
              currentTargetType: target.type
            })
          }
        }
      )
      if (!result.success) {
        if (result.error === '已取消') throw new Error('已取消')
        throw new Error(`${target.name}：${result.error || '导出失败'}`)
      }

      const messageCount = result.messageCount || 0
      totalMessages += messageCount
      manifest.push({
        id: target.userMd5,
        name: target.name,
        type: target.type,
        folder: `${categoryName}/${folderName}`,
        messageCount
      })
      await writeAllExportManifest(outputDir, manifest, totalMessages, 'running')
    }

    await writeAllExportManifest(outputDir, manifest, totalMessages, 'completed')

    let completedPath = outputDir
    if (request.zip) {
      if (!jobs.has(request.jobId)) throw new Error('已取消')
      const zipPath = join(exportRoot, `${outputFolder}.zip`)
      send({
        jobId: request.jobId,
        phase: 'compressing',
        processed: totalMessages,
        total: totalMessages,
        percent: 99
      })
      await writeZipArchive(outputDir, zipPath, outputFolder, request.jobId)
      completedPath = zipPath
    }

    send({
      jobId: request.jobId,
      phase: 'completed',
      processed: totalMessages,
      total: totalMessages,
      percent: 100,
      outputPath: completedPath,
      currentTargetIndex: targets.length,
      currentTargetCount: targets.length,
      currentTargetName: targets.at(-1)?.name,
      currentTargetType: targets.at(-1)?.type
    })
    return { success: true, outputPath: completedPath, messageCount: totalMessages }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const cancelled = !jobs.has(request.jobId) || message === '已取消'
    if (outputDir) {
      try {
        await writeAllExportManifest(
          outputDir,
          manifest,
          totalMessages,
          cancelled ? 'cancelled' : 'failed',
          cancelled ? undefined : message
        )
      } catch (manifestError) {
        console.warn('[Export] failed to update all-export manifest:', manifestError)
      }
    }
    if (cancelled) {
      send({ jobId: request.jobId, phase: 'cancelled', processed: 0, error: '已取消' })
      return { success: false, error: '已取消' }
    }
    send({ jobId: request.jobId, phase: 'failed', processed: 0, error: message })
    return { success: false, error: message }
  } finally {
    jobs.delete(request.jobId)
  }
}

export async function runExport(
  request: ExportRequest,
  win: BrowserWindow,
  voiceRecognition?: Pick<VoiceRecognitionUseCase, 'recognize'> &
    Partial<Pick<VoiceRecognitionUseCase, 'publishTranscript'>>
): Promise<ExportResult> {
  return request.scope === 'all'
    ? runAllExport(request, win, voiceRecognition)
    : runSingleExport(request, win, voiceRecognition)
}
export function cancelExport(jobId: string): void {
  jobs.delete(jobId)
  activeArchives.get(jobId)?.abort()
}
export async function revealExport(path: string): Promise<void> {
  shell.showItemInFolder(path)
}
