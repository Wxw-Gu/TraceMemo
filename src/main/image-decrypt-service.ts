import { basename, dirname, extname, join, resolve } from 'path'
import { existsSync, readFileSync, statSync, readdirSync, promises as fsPromises } from 'fs'
import crypto from 'crypto'
import os from 'os'
import { app } from 'electron'
import { execFile } from 'child_process'
import { Worker } from 'worker_threads'
import ffmpegStaticPath from 'ffmpeg-static'
import type { ImageDecoderSource, ImageDecoderStatus } from '../shared/image-decryption'
import { imageFileQuality, imageQualityRank } from '../shared/image-quality'
import { loadSettings } from './services/settings-store'
import { Wcdb4Client } from './wcdb4-client'

const imageDecryptDebugEnabled =
  process.env['TRACEMEMO_DEBUG_IMAGE'] === '1' ||
  (!process.env['TRACEMEMO_DEBUG_IMAGE'] && process.env['WECHATEXPLORER_DEBUG_IMAGE'] === '1')
const imageDecryptLog = (...args: unknown[]): void => {
  if (imageDecryptDebugEnabled) console.log(...args)
}

export type DecodedImage = {
  data: string
  filePath: string
  isThumbnail: boolean
  cacheFilePath?: string
  mimeType?: string
}

export type ImageDecodeDiagnosticCode =
  | 'NOT_RUN'
  | 'FILE_NOT_FOUND'
  | 'DIRECT_IMAGE'
  | 'UNSUPPORTED_DAT_VERSION'
  | 'MISSING_AES_KEY'
  | 'AES_DECRYPT_FAILED'
  | 'INVALID_DAT_FILE'
  | 'WXGF_REQUIRES_DECODER'
  | 'UNKNOWN_IMAGE_FORMAT'
  | 'SUCCESS'

export interface ImageDecodeDiagnostic {
  code: ImageDecodeDiagnosticCode
  detail: string
  datVersion?: number
  fileSize?: number
  imageFormat?: string
  wxgf?: boolean
}

type ImageFindOptions = {
  allowThumbnail?: boolean
  accountDir?: string
  preferThumbnail?: boolean
  sessionId?: string
  sessionMd5?: string
  createTime?: number
}

const MAX_DECODED_IMAGE_CACHE_BYTES = 48 * 1024 * 1024
const MAX_PERSISTENT_IMAGE_CACHE_BYTES = 512 * 1024 * 1024
const MAX_PERSISTENT_IMAGE_CACHE_FILES = 512
const PERSISTENT_IMAGE_CACHE_VERSION = 2

interface PersistentImageMeta {
  version: number
  sourcePath: string
  sourceSize: number
  sourceMtimeMs: number
  fileName: string
  cacheSize: number
  mimeType: string
  isThumbnail: boolean
}

type FfmpegCandidate = { executable: string; source: ImageDecoderSource }

function getFfmpegCandidates(selectedPath = loadSettings().ffmpegPath): FfmpegCandidate[] {
  const selected = String(selectedPath || '').trim()
  const environment = String(process.env['FFMPEG_BIN'] || '').trim()
  const executable = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const staticExecutable = String(ffmpegStaticPath || '')
    .replace('app.asar', 'app.asar.unpacked')
    .trim()
  const candidates: FfmpegCandidate[] = [
    ...(selected ? [{ executable: selected, source: 'selected' as const }] : []),
    ...(environment ? [{ executable: environment, source: 'environment' as const }] : []),
    ...(staticExecutable ? [{ executable: staticExecutable, source: 'bundled' as const }] : []),
    {
      executable: join(process.resourcesPath, 'resources', 'ffmpeg', executable),
      source: 'bundled'
    },
    {
      executable: join(process.resourcesPath, 'ffmpeg', executable),
      source: 'bundled'
    },
    {
      executable: join(process.cwd(), 'resources', 'ffmpeg', executable),
      source: 'bundled'
    },
    ...(process.platform === 'darwin'
      ? [
          { executable: `/opt/homebrew/bin/${executable}`, source: 'system' as const },
          { executable: `/usr/local/bin/${executable}`, source: 'system' as const }
        ]
      : []),
    { executable: process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg', source: 'system' }
  ]

  return candidates.filter(
    (candidate, index) =>
      candidates.findIndex(
        (other) => other.executable.toLowerCase() === candidate.executable.toLowerCase()
      ) === index
  )
}

function resolveFfmpegExecutable(): string {
  for (const candidate of getFfmpegCandidates()) {
    const pathLike = candidate.executable.includes('/') || candidate.executable.includes('\\')
    if (pathLike) {
      if (existsSync(candidate.executable)) return candidate.executable
      continue
    }
    return candidate.executable
  }
  return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
}

function runImageDecoderCommand(
  executable: string,
  args: string[]
): Promise<{ success: boolean; output: string }> {
  return new Promise((resolveValidation) => {
    execFile(
      executable,
      args,
      { timeout: 7_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolveValidation({ success: !error, output: `${stdout}\n${stderr}` })
      }
    )
  })
}

export async function inspectImageDecoderExecutable(
  executable: string
): Promise<{ installed: boolean; supportsHevc: boolean }> {
  const version = await runImageDecoderCommand(executable, ['-hide_banner', '-version'])
  if (!version.success || !/ffmpeg version/i.test(version.output)) {
    return { installed: false, supportsHevc: false }
  }

  const decoders = await runImageDecoderCommand(executable, ['-hide_banner', '-decoders'])
  return {
    installed: true,
    supportsHevc: decoders.success && /^\s*[A-Z.]{6}\s+hevc\s/im.test(decoders.output)
  }
}

async function resolveImageDecoderPath(executable: string): Promise<string | undefined> {
  if (existsSync(executable)) return resolve(executable)
  const locator = process.platform === 'win32' ? 'where.exe' : 'which'
  const located = await runImageDecoderCommand(locator, [executable])
  if (!located.success) return undefined
  return located.output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && existsSync(line))
}

export async function inspectImageDecoderStatus(
  selectedPath = loadSettings().ffmpegPath
): Promise<ImageDecoderStatus> {
  for (const candidate of getFfmpegCandidates(selectedPath)) {
    const inspection = await inspectImageDecoderExecutable(candidate.executable)
    if (inspection.installed) {
      const resolvedPath = await resolveImageDecoderPath(candidate.executable)
      return {
        installed: true,
        available: inspection.supportsHevc,
        source: candidate.source,
        selected: candidate.source === 'selected',
        directory: resolvedPath ? dirname(resolvedPath) : undefined
      }
    }
  }
  return { installed: false, available: false, source: 'none', selected: false }
}

const IMAGE_DECRYPT_WORKER_SOURCE = String.raw`
const crypto = require('node:crypto')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { parentPort, workerData } = require('node:worker_threads')

function normalizeDatBase(value) {
  const lower = String(value || '').trim().toLowerCase()
  if (!lower) return ''
  const file = lower.split('/').pop().split('\\').pop()
  const withoutDat = file.endsWith('.dat') ? file.slice(0, -4) : file
  return withoutDat.replace(
    /(_thumb|\.thumb|_hd|\.hd|_h_m|_h|\.h|_t_m|_t|\.t|_m|_b|_w|_c)$/i,
    ''
  )
}

function isThumbnailName(fileName) {
  const lower = fileName.toLowerCase()
  return /(?:_t(?:_m)?|_thumb|\.thumb|_b|_w|_c)\.dat$/i.test(lower)
}

function imageQualityRank(fileName) {
  const lower = fileName.toLowerCase()
  if (/(?:_t(?:_m)?|_thumb|\.thumb|_b|_w|_c)\.dat$/i.test(lower)) return 1
  if (/(?:_hd|\.hd|_h_m|_h|\.h)\.dat$/i.test(lower)) return 3
  return 2
}

function buildPreferredDatNames(baseName) {
  const base = normalizeDatBase(baseName)
  if (!base) return []
  return [
    base + '.dat',
    base + '_hd.dat',
    base + '_h_M.dat',
    base + '_h.dat',
    base + '_M.dat',
    base + '_b.dat',
    base + '_w.dat',
    base + '_c.dat',
    base + '_t_M.dat',
    base + '_t.dat',
    base + '.thumb.dat',
    base + '_thumb.dat'
  ]
}

function detectImageExtension(buffer) {
  if (buffer.length < 4) return null
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return '.jpg'
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return '.png'
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) return '.gif'
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return '.bmp'
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) return '.webp'
  return null
}

function getMimeType(extension) {
  if (extension === '.png') return 'image/png'
  if (extension === '.gif') return 'image/gif'
  if (extension === '.bmp') return 'image/bmp'
  if (extension === '.webp') return 'image/webp'
  return 'image/jpeg'
}

function strictRemovePadding(buffer) {
  if (buffer.length === 0) return buffer
  const paddingLength = buffer[buffer.length - 1]
  if (paddingLength <= 0 || paddingLength > 16 || paddingLength > buffer.length) {
    throw new Error('invalid PKCS#7 padding')
  }
  for (let index = buffer.length - paddingLength; index < buffer.length; index += 1) {
    if (buffer[index] !== paddingLength) throw new Error('invalid PKCS#7 padding')
  }
  return buffer.subarray(0, buffer.length - paddingLength)
}

function unwrapWxgf(buffer, ffmpegPath) {
  if (
    buffer.length < 20 ||
    buffer[0] !== 0x77 ||
    buffer[1] !== 0x78 ||
    buffer[2] !== 0x67 ||
    buffer[3] !== 0x66
  ) {
    return buffer
  }
  for (let index = 4; index < Math.min(buffer.length - 12, 4096); index += 1) {
    if (buffer[index] === 0xff && buffer[index + 1] === 0xd8 && buffer[index + 2] === 0xff) {
      return buffer.subarray(index)
    }
    if (
      buffer[index] === 0x89 &&
      buffer[index + 1] === 0x50 &&
      buffer[index + 2] === 0x4e &&
      buffer[index + 3] === 0x47
    ) {
      return buffer.subarray(index)
    }
  }

  function findHevcPartitions(data) {
    if (data.length < 15) return []
    const headerLength = data[4]
    if (headerLength < 5 || headerLength >= data.length) return []

    for (const pattern of [Buffer.from([0, 0, 0, 1]), Buffer.from([0, 0, 1])]) {
      const partitions = []
      let searchOffset = headerLength
      while (searchOffset < data.length) {
        const relativeIndex = data.subarray(searchOffset).indexOf(pattern)
        if (relativeIndex < 0) break
        const offset = searchOffset + relativeIndex
        if (offset < 4) {
          searchOffset = offset + 1
          continue
        }
        const size = data.readUInt32BE(offset - 4)
        if (size === 0 || offset + size > data.length) {
          searchOffset = offset + 1
          continue
        }
        partitions.push({ offset, size })
        searchOffset = offset + size
      }
      if (partitions.length > 0) return partitions
    }
    return []
  }

  const partitions = findHevcPartitions(buffer)
  let hevcData = null
  if (partitions.length > 0) {
    const largest = partitions.reduce((best, current) =>
      current.size > best.size ? current : best
    )
    hevcData = buffer.subarray(largest.offset, largest.offset + largest.size)
  } else {
    for (let index = 4; index < Math.min(buffer.length - 4, 4096); index += 1) {
      if (
        buffer[index] === 0x00 &&
        buffer[index + 1] === 0x00 &&
        buffer[index + 2] === 0x00 &&
        buffer[index + 3] === 0x01
      ) {
        hevcData = buffer.subarray(index)
        break
      }
    }
  }
  if (!hevcData || !ffmpegPath) return buffer

  const nonce = process.pid + '-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex')
  const tempBase = path.join(os.tmpdir(), 'wxe-wxgf-' + nonce)
  const inputPath = tempBase + '.hevc'
  const outputPath = tempBase + '.png'
  try {
    fs.writeFileSync(inputPath, hevcData)
    childProcess.execFileSync(
      ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'hevc',
        '-i',
        inputPath,
        '-frames:v',
        '1',
        outputPath
      ],
      { timeout: 20_000, windowsHide: true, stdio: 'ignore' }
    )
    const converted = fs.readFileSync(outputPath)
    return detectImageExtension(converted) ? converted : buffer
  } catch {
    return buffer
  } finally {
    try { fs.rmSync(inputPath, { force: true }) } catch {}
    try { fs.rmSync(outputPath, { force: true }) } catch {}
  }
}

function decryptCandidate(filePath, aesKey, xorKey, ffmpegPath) {
  const bytes = fs.readFileSync(filePath)
  const directExtension = detectImageExtension(bytes)
  if (directExtension) {
    return {
      data: 'data:' + getMimeType(directExtension) + ';base64,' + bytes.toString('base64'),
      filePath
    }
  }
  if (!path.extname(filePath).toLowerCase().includes('dat')) {
    const extension = path.extname(filePath).toLowerCase()
    return { data: 'data:' + getMimeType(extension) + ';base64,' + bytes.toString('base64'), filePath }
  }
  if (
    bytes.length < 15 ||
    bytes[0] !== 0x07 ||
    bytes[1] !== 0x08 ||
    bytes[2] !== 0x56 ||
    bytes[3] !== 0x32 ||
    bytes[4] !== 0x08 ||
    bytes[5] !== 0x07 ||
    !aesKey
  ) {
    return null
  }

  const payload = bytes.subarray(15)
  const aesSize = bytes.readInt32LE(6)
  const xorSize = bytes.readInt32LE(10)
  const remainder = ((aesSize % 16) + 16) % 16
  const alignedAesSize = aesSize + (16 - remainder)
  if (alignedAesSize > payload.length) return null

  const aesData = payload.subarray(0, alignedAesSize)
  let unpadded = Buffer.alloc(0)
  if (aesData.length > 0) {
    const key = Buffer.from(aesKey, 'ascii').subarray(0, 16)
    const decipher = crypto.createDecipheriv('aes-128-ecb', key, null)
    decipher.setAutoPadding(false)
    unpadded = strictRemovePadding(Buffer.concat([decipher.update(aesData), decipher.final()]))
  }

  const remaining = payload.subarray(alignedAesSize)
  if (xorSize < 0 || xorSize > remaining.length) return null
  const rawLength = remaining.length - xorSize
  const rawData = remaining.subarray(0, rawLength)
  const xorData = remaining.subarray(rawLength)
  const xorPlain = Buffer.allocUnsafe(xorData.length)
  for (let index = 0; index < xorData.length; index += 1) {
    xorPlain[index] = xorData[index] ^ xorKey
  }

  const image = unwrapWxgf(Buffer.concat([unpadded, rawData, xorPlain]), ffmpegPath)
  const extension = detectImageExtension(image)
  if (!extension) return null
  return {
    data: 'data:' + getMimeType(extension) + ';base64,' + image.toString('base64'),
    filePath
  }
}

function collectCandidates(datPath, allowThumbnail) {
  const candidates = [datPath]
  if (!path.extname(datPath).toLowerCase().includes('dat')) return candidates
  const directory = path.dirname(datPath)
  const base = normalizeDatBase(path.basename(datPath))
  const siblings = buildPreferredDatNames(base)
    .filter((name) => allowThumbnail || !isThumbnailName(name))
    .map((name) => path.join(directory, name))
    .filter((candidate) => fs.existsSync(candidate))
    .sort((left, right) => {
      const qualityOrder = imageQualityRank(path.basename(right)) - imageQualityRank(path.basename(left))
      return qualityOrder || fs.statSync(right).size - fs.statSync(left).size
    })
  return Array.from(new Set(candidates.concat(siblings)))
}

let result = null
for (const candidate of collectCandidates(workerData.datPath, workerData.allowThumbnail)) {
  try {
    result = decryptCandidate(
      candidate,
      workerData.aesKey,
      workerData.xorKey,
      workerData.ffmpegPath
    )
    if (result) break
  } catch {
    // Try the next local quality variant.
  }
}
parentPort.postMessage(result)
`

export class ImageDecryptService {
  private xorKey: number = 0
  private aesKey: string = ''
  private wcdb4Client: Wcdb4Client | null = null
  private accountDirResolved = false
  private cachedAccountDir: string | null = null
  private imagePathCache = new Map<string, string>()
  private decodedImageCache = new Map<string, DecodedImage>()
  private decodedImageCacheBytes = 0
  private persistentCachePrunePromise: Promise<void> | null = null
  private persistentCachePrunePending = false
  private lastDecodeDiagnostic: ImageDecodeDiagnostic = {
    code: 'NOT_RUN',
    detail: '尚未执行图片解析'
  }

  constructor(
    xorKey: string,
    aesKey: string,
    wcdb4Client?: Wcdb4Client | null,
    configuredAccountDir?: string
  ) {
    // 解析 XOR Key (支持 0x40 或 64 格式)
    const xorHex = xorKey.trim().toLowerCase()
    if (xorHex.startsWith('0x')) {
      this.xorKey = parseInt(xorHex, 16)
    } else {
      this.xorKey = parseInt(xorHex, 10)
    }

    // AES Key 直接使用
    this.aesKey = aesKey.trim()
    this.wcdb4Client = wcdb4Client || null

    const accountDir = this.wcdb4Client?.getAccountRoot() || configuredAccountDir
    if (accountDir && existsSync(accountDir)) {
      this.cachedAccountDir = accountDir
      this.accountDirResolved = true
    }
  }

  getLastDecodeDiagnostic(): ImageDecodeDiagnostic {
    return { ...this.lastDecodeDiagnostic }
  }

  /**
   * 获取账号目录
   */
  private getAccountDir(): string | null {
    if (this.accountDirResolved) return this.cachedAccountDir
    this.accountDirResolved = true

    const wcdbAccountRoot = this.wcdb4Client?.getAccountRoot()
    if (wcdbAccountRoot && existsSync(wcdbAccountRoot)) {
      this.cachedAccountDir = wcdbAccountRoot
      return this.cachedAccountDir
    }

    const homeDir = os.homedir()
    const accountRoot = join(
      homeDir,
      'Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files'
    )

    if (!existsSync(accountRoot)) {
      imageDecryptLog('[ImageDecrypt] account root not found:', accountRoot)
      return null
    }

    const accounts = readdirSync(accountRoot)
      .filter((name) => {
        const fullPath = join(accountRoot, name)
        try {
          return statSync(fullPath).isDirectory()
        } catch {
          return false
        }
      })
      .map((name) => ({
        name,
        mtime: statSync(join(accountRoot, name)).mtimeMs
      }))
      .sort((a, b) => b.mtime - a.mtime)

    if (accounts.length === 0) {
      imageDecryptLog('[ImageDecrypt] no accounts found')
      return null
    }

    // 返回最新的账号目录
    this.cachedAccountDir = join(accountRoot, accounts[0].name)
    return this.cachedAccountDir
  }

  /**
   * 根据 md5 查找图片文件
   */
  findImageFile(md5?: string, imageDatName?: string, options?: ImageFindOptions): string | null {
    const allowThumbnail = options?.allowThumbnail !== false
    const normalizedMd5 = this.normalizeDatBase(md5 || '')
    const normalizedDatName = this.normalizeDatBase(imageDatName || '')
    const sessionDirectory = this.getSessionDirectoryName(options?.sessionMd5 || options?.sessionId)
    const pathCacheKey = [
      normalizedMd5,
      normalizedDatName,
      allowThumbnail ? 'thumb' : 'original',
      options?.preferThumbnail ? 'prefer-thumb' : 'prefer-original',
      options?.accountDir || '',
      sessionDirectory,
      options?.createTime || 0
    ].join('|')
    const cachedPath = this.imagePathCache.get(pathCacheKey)
    if (cachedPath && existsSync(cachedPath)) return cachedPath

    const rememberPath = (path: string | null): string | null => {
      if (path) this.imagePathCache.set(pathCacheKey, path)
      return path
    }

    // 测试场景下可显式指定根目录；不传则维持原 getAccountDir() 行为
    const accountDir =
      options?.accountDir && existsSync(options.accountDir)
        ? options.accountDir
        : this.getAccountDir()
    if (!accountDir) return null
    imageDecryptLog('[ImageDecrypt] findImageFile:', {
      md5: normalizedMd5,
      imageDatName: normalizedDatName,
      accountDir,
      allowThumbnail,
      sessionDirectory,
      createTime: options?.createTime
    })

    const attachDir = join(accountDir, 'msg', 'attach')
    // The attach directory stores DAT filenames, while the message MD5 often
    // identifies the original image rather than the local file.
    const searchKeys = this.uniq([normalizedDatName, normalizedMd5])

    if (sessionDirectory && allowThumbnail && options?.preferThumbnail) {
      const bubblePreview = this.findBubblePreview(
        accountDir,
        searchKeys,
        sessionDirectory,
        options?.createTime
      )
      if (bubblePreview) return rememberPath(bubblePreview)
    }

    // Message rows already identify their conversation. Prefer that small,
    // deterministic directory before consulting the native hardlink database.
    if (sessionDirectory && existsSync(attachDir)) {
      for (const key of searchKeys) {
        const scopedHit = this.fastProbabilisticSearch(
          attachDir,
          key,
          allowThumbnail,
          options?.preferThumbnail,
          sessionDirectory,
          options?.createTime
        )
        if (scopedHit) return rememberPath(scopedHit)
      }
    }

    for (const key of this.uniq([normalizedMd5, normalizedDatName])) {
      const hardlink = this.wcdb4Client?.resolveImageHardlink(key)
      const fullPath = typeof hardlink?.full_path === 'string' ? hardlink.full_path : ''
      if (fullPath && existsSync(fullPath)) {
        const selected = this.getPreferredDatVariantPath(
          fullPath,
          allowThumbnail,
          options?.preferThumbnail
        )
        if (allowThumbnail || !this.isThumbnailName(basename(selected))) {
          imageDecryptLog('[ImageDecrypt] hardlink hit:', selected)
          return rememberPath(selected)
        }
      }
    }

    // 尝试 TraceMemo 兼容的微信目录结构: msg/attach/{hash}/{YYYY-MM}/Img/
    if (!existsSync(attachDir)) {
      imageDecryptLog('[ImageDecrypt] attach dir not found:', attachDir)
      return rememberPath(
        this.findImageFileInLegacyDirs(
          accountDir,
          normalizedMd5 || normalizedDatName,
          allowThumbnail,
          options?.preferThumbnail
        )
      )
    }

    if (searchKeys.length === 0) return null

    if (!sessionDirectory) {
      for (const key of searchKeys) {
        const directHit = this.fastProbabilisticSearch(
          attachDir,
          key,
          allowThumbnail,
          options?.preferThumbnail
        )
        if (directHit) return rememberPath(directHit)
      }
    }

    const legacyHit = this.findImageFileInLegacyDirs(
      accountDir,
      searchKeys[0],
      allowThumbnail,
      options?.preferThumbnail
    )
    if (legacyHit) return rememberPath(legacyHit)

    imageDecryptLog('[ImageDecrypt] findImageFile miss for:', searchKeys)
    return null
  }

  async getCachedDecodedImage(
    key: string,
    options: { includeData?: boolean } = {}
  ): Promise<DecodedImage | null> {
    const cached = this.decodedImageCache.get(key)
    if (cached) {
      this.decodedImageCache.delete(key)
      this.decodedImageCache.set(key, cached)
      return cached
    }

    const persistent = await this.getPersistentDecodedImage(key, options.includeData !== false)
    if (!persistent) return null
    if (persistent.data) this.putDecodedImageInMemory(key, persistent)
    return persistent
  }

  async cacheDecodedImage(key: string, image: DecodedImage): Promise<void> {
    this.putDecodedImageInMemory(key, image)

    try {
      const persisted = await this.writePersistentDecodedImage(key, image)
      if (persisted) {
        const current = this.decodedImageCache.get(key)
        if (current) {
          current.cacheFilePath = persisted.cacheFilePath
          current.mimeType = persisted.mimeType
        }
      }
    } catch (error) {
      imageDecryptLog('[ImageDecrypt] persistent cache write failed:', error)
    }
  }

  private putDecodedImageInMemory(key: string, image: DecodedImage): void {
    const size = image.data.length * 2
    const previous = this.decodedImageCache.get(key)
    if (previous) {
      this.decodedImageCacheBytes -= previous.data.length * 2
      this.decodedImageCache.delete(key)
    }
    this.decodedImageCache.set(key, image)
    this.decodedImageCacheBytes += size
    while (
      this.decodedImageCacheBytes > MAX_DECODED_IMAGE_CACHE_BYTES &&
      this.decodedImageCache.size > 1
    ) {
      const oldestKey = this.decodedImageCache.keys().next().value
      if (!oldestKey) break
      const oldest = this.decodedImageCache.get(oldestKey)
      this.decodedImageCache.delete(oldestKey)
      this.decodedImageCacheBytes -= oldest?.data.length ? oldest.data.length * 2 : 0
    }
  }

  private getPersistentCacheDir(): string | null {
    try {
      return join(app.getPath('userData'), 'cache', 'images')
    } catch (error) {
      imageDecryptLog('[ImageDecrypt] persistent cache path unavailable:', error)
      return null
    }
  }

  private getPersistentCacheKey(key: string): string {
    const accountDir = this.getAccountDir() || this.wcdb4Client?.getAccountRoot() || ''
    const resolvedAccountDir = accountDir ? resolve(accountDir) : ''
    const accountScope =
      process.platform === 'win32'
        ? resolvedAccountDir.replace(/\\/g, '/').toLowerCase()
        : resolvedAccountDir
    const scope = JSON.stringify({
      version: PERSISTENT_IMAGE_CACHE_VERSION,
      accountDir: accountScope,
      key
    })
    return crypto.createHash('sha256').update(scope).digest('hex')
  }

  private async getPersistentDecodedImage(
    key: string,
    includeData: boolean
  ): Promise<DecodedImage | null> {
    const cacheDir = this.getPersistentCacheDir()
    if (!cacheDir) return null

    const cacheKey = this.getPersistentCacheKey(key)
    const metadataPath = join(cacheDir, `${cacheKey}.json`)
    let metadata: PersistentImageMeta | null = null

    try {
      metadata = JSON.parse(await fsPromises.readFile(metadataPath, 'utf8')) as PersistentImageMeta
      if (!this.isValidPersistentImageMeta(metadata, cacheKey)) {
        throw new Error('invalid persistent image metadata')
      }

      const sourceStat = await fsPromises.stat(metadata.sourcePath)
      if (
        !sourceStat.isFile() ||
        sourceStat.size !== metadata.sourceSize ||
        Math.trunc(sourceStat.mtimeMs) !== Math.trunc(metadata.sourceMtimeMs)
      ) {
        throw new Error('persistent image source changed')
      }

      const cacheFilePath = join(cacheDir, metadata.fileName)
      const cacheStat = await fsPromises.stat(cacheFilePath)
      if (!cacheStat.isFile() || cacheStat.size <= 0 || cacheStat.size !== metadata.cacheSize) {
        throw new Error('persistent image payload changed')
      }

      const payload = includeData
        ? await fsPromises.readFile(cacheFilePath)
        : await this.readImageSignature(cacheFilePath)
      const extension = this.detectImageExtension(payload)
      if (!extension || this.getMimeType(extension) !== metadata.mimeType) {
        throw new Error('persistent image payload is invalid')
      }

      const now = new Date()
      void Promise.all([
        fsPromises.utimes(cacheFilePath, now, now),
        fsPromises.utimes(metadataPath, now, now)
      ]).catch(() => undefined)

      return {
        data: includeData ? `data:${metadata.mimeType};base64,${payload.toString('base64')}` : '',
        filePath: metadata.sourcePath,
        isThumbnail: metadata.isThumbnail,
        cacheFilePath,
        mimeType: metadata.mimeType
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        imageDecryptLog('[ImageDecrypt] persistent cache miss:', error)
      }
      await this.removePersistentCacheEntry(cacheDir, cacheKey, metadata?.fileName)
      return null
    }
  }

  private async writePersistentDecodedImage(
    key: string,
    image: DecodedImage
  ): Promise<{ cacheFilePath: string; mimeType: string } | null> {
    const cacheDir = this.getPersistentCacheDir()
    if (!cacheDir || !image.filePath) return null

    const payload = await this.getDecodedImagePayload(image)
    if (!payload) return null

    const extension = this.detectImageExtension(payload)
    if (!extension) return null

    const sourceStat = await fsPromises.stat(image.filePath)
    if (!sourceStat.isFile()) return null

    const cacheKey = this.getPersistentCacheKey(key)
    const fileName = `${cacheKey}${extension}`
    const cacheFilePath = join(cacheDir, fileName)
    const metadataPath = join(cacheDir, `${cacheKey}.json`)
    const mimeType = this.getMimeType(extension)
    const nonce = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
    const payloadTempPath = join(cacheDir, `${cacheKey}.${nonce}.tmp`)
    const metadataTempPath = join(cacheDir, `${cacheKey}.${nonce}.json.tmp`)
    const metadata: PersistentImageMeta = {
      version: PERSISTENT_IMAGE_CACHE_VERSION,
      sourcePath: image.filePath,
      sourceSize: sourceStat.size,
      sourceMtimeMs: sourceStat.mtimeMs,
      fileName,
      cacheSize: payload.length,
      mimeType,
      isThumbnail: image.isThumbnail
    }

    await fsPromises.mkdir(cacheDir, { recursive: true })
    try {
      await fsPromises.writeFile(payloadTempPath, payload)
      await this.replaceFileAtomically(payloadTempPath, cacheFilePath)
      await fsPromises.writeFile(metadataTempPath, JSON.stringify(metadata))
      await this.replaceFileAtomically(metadataTempPath, metadataPath)
      await this.removeOtherPersistentPayloads(cacheDir, cacheKey, fileName)
    } finally {
      await Promise.allSettled([
        fsPromises.rm(payloadTempPath, { force: true }),
        fsPromises.rm(metadataTempPath, { force: true })
      ])
    }

    this.schedulePersistentCachePrune()
    return { cacheFilePath, mimeType }
  }

  private async getDecodedImagePayload(image: DecodedImage): Promise<Buffer | null> {
    const separatorIndex = image.data.indexOf(',')
    if (separatorIndex > 0) {
      const header = image.data.slice(0, separatorIndex)
      if (/^data:image\/[a-z0-9.+-]+;base64$/i.test(header)) {
        const payload = Buffer.from(image.data.slice(separatorIndex + 1), 'base64')
        return payload.length > 0 ? payload : null
      }
    }

    if (image.cacheFilePath) {
      try {
        return await fsPromises.readFile(image.cacheFilePath)
      } catch {
        return null
      }
    }
    return null
  }

  async findImageFileAsync(
    md5?: string,
    imageDatName?: string,
    options?: ImageFindOptions
  ): Promise<string | null> {
    const sessionDirectory = this.getSessionDirectoryName(options?.sessionMd5 || options?.sessionId)
    if (!sessionDirectory) return this.findImageFile(md5, imageDatName, options)

    const allowThumbnail = options?.allowThumbnail !== false
    const normalizedMd5 = this.normalizeDatBase(md5 || '')
    const normalizedDatName = this.normalizeDatBase(imageDatName || '')
    const pathCacheKey = [
      normalizedMd5,
      normalizedDatName,
      allowThumbnail ? 'thumb' : 'original',
      options?.preferThumbnail ? 'prefer-thumb' : 'prefer-original',
      options?.accountDir || '',
      sessionDirectory,
      options?.createTime || 0
    ].join('|')
    const cachedPath = this.imagePathCache.get(pathCacheKey)
    if (cachedPath && existsSync(cachedPath)) return cachedPath

    const rememberPath = (filePath: string | null): string | null => {
      if (filePath) this.imagePathCache.set(pathCacheKey, filePath)
      return filePath
    }
    const accountDir =
      options?.accountDir && existsSync(options.accountDir)
        ? options.accountDir
        : this.getAccountDir()
    if (!accountDir) return null

    const attachDir = join(accountDir, 'msg', 'attach')
    const searchKeys = this.uniq([normalizedDatName, normalizedMd5])
    if (allowThumbnail && options?.preferThumbnail) {
      const bubblePreview = await this.findBubblePreviewAsync(
        accountDir,
        searchKeys,
        sessionDirectory,
        options?.createTime
      )
      if (bubblePreview) return rememberPath(bubblePreview)
    }
    if (existsSync(attachDir)) {
      for (const key of searchKeys) {
        const scopedHit = await this.findImageInSessionDirectoryAsync(
          attachDir,
          key,
          allowThumbnail,
          options?.preferThumbnail,
          sessionDirectory,
          options?.createTime
        )
        if (scopedHit) return rememberPath(scopedHit)
      }
    }

    for (const key of this.uniq([normalizedMd5, normalizedDatName])) {
      const hardlink = await this.wcdb4Client?.resolveImageHardlinkAsync(key)
      const fullPath = typeof hardlink?.full_path === 'string' ? hardlink.full_path : ''
      if (!fullPath || !existsSync(fullPath)) continue
      const selected = this.getPreferredDatVariantPath(
        fullPath,
        allowThumbnail,
        options?.preferThumbnail
      )
      if (allowThumbnail || !this.isThumbnailName(basename(selected))) {
        return rememberPath(selected)
      }
    }

    return null
  }

  private async findImageInSessionDirectoryAsync(
    attachDir: string,
    datName: string,
    allowThumbnail: boolean,
    preferThumbnail: boolean | undefined,
    sessionDirectory: string,
    createTime?: number
  ): Promise<string | null> {
    const normalized = this.normalizeDatBase(datName)
    if (!normalized || !sessionDirectory) return null

    const sessionRoot = join(attachDir, sessionDirectory)
    let monthDirectories: string[]
    try {
      monthDirectories = (await fsPromises.readdir(sessionRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}$/.test(entry.name))
        .map((entry) => entry.name)
        .sort((left, right) => right.localeCompare(left))
    } catch {
      return null
    }

    monthDirectories = this.prioritizeImageMonth(monthDirectories, createTime)
    const variants = this.buildPreferredDatNames(normalized)
    for (const month of monthDirectories) {
      const candidates = ['Img', 'Image', 'image'].flatMap((subDirectory) =>
        variants.map((variant) => join(sessionRoot, month, subDirectory, variant))
      )
      const found = await this.getLargestExistingPathAsync(
        candidates,
        allowThumbnail,
        preferThumbnail
      )
      if (found) return found
    }
    return null
  }

  private isValidPersistentImageMeta(metadata: PersistentImageMeta, cacheKey: string): boolean {
    return (
      metadata !== null &&
      typeof metadata === 'object' &&
      metadata.version === PERSISTENT_IMAGE_CACHE_VERSION &&
      typeof metadata.sourcePath === 'string' &&
      metadata.sourcePath.length > 0 &&
      Number.isFinite(metadata.sourceSize) &&
      metadata.sourceSize >= 0 &&
      Number.isFinite(metadata.sourceMtimeMs) &&
      typeof metadata.fileName === 'string' &&
      basename(metadata.fileName) === metadata.fileName &&
      metadata.fileName.startsWith(`${cacheKey}.`) &&
      Number.isFinite(metadata.cacheSize) &&
      metadata.cacheSize > 0 &&
      typeof metadata.mimeType === 'string' &&
      metadata.mimeType.startsWith('image/') &&
      typeof metadata.isThumbnail === 'boolean'
    )
  }

  private async readImageSignature(filePath: string): Promise<Buffer> {
    const handle = await fsPromises.open(filePath, 'r')
    try {
      const signature = Buffer.alloc(16)
      const { bytesRead } = await handle.read(signature, 0, signature.length, 0)
      return signature.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
  }

  private async replaceFileAtomically(tempPath: string, targetPath: string): Promise<void> {
    try {
      await fsPromises.rename(tempPath, targetPath)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST' && code !== 'EPERM') throw error
      await fsPromises.rm(targetPath, { force: true })
      await fsPromises.rename(tempPath, targetPath)
    }
  }

  private async removeOtherPersistentPayloads(
    cacheDir: string,
    cacheKey: string,
    keepFileName: string
  ): Promise<void> {
    const names = await fsPromises.readdir(cacheDir)
    const obsolete = names.filter(
      (name) =>
        name !== keepFileName &&
        name.startsWith(`${cacheKey}.`) &&
        /^\.(?:jpe?g|png|gif|bmp|webp)$/i.test(name.slice(cacheKey.length))
    )
    await Promise.allSettled(
      obsolete.map((name) => fsPromises.rm(join(cacheDir, name), { force: true }))
    )
  }

  private async removePersistentCacheEntry(
    cacheDir: string,
    cacheKey: string,
    fileName?: string
  ): Promise<void> {
    const candidates = new Set<string>([`${cacheKey}.json`])
    if (fileName && basename(fileName) === fileName && fileName.startsWith(`${cacheKey}.`)) {
      candidates.add(fileName)
    } else {
      try {
        const names = await fsPromises.readdir(cacheDir)
        for (const name of names) {
          if (
            name.startsWith(`${cacheKey}.`) &&
            /^\.(?:jpe?g|png|gif|bmp|webp)$/i.test(name.slice(cacheKey.length))
          ) {
            candidates.add(name)
          }
        }
      } catch {
        return
      }
    }
    await Promise.allSettled(
      Array.from(candidates, (name) => fsPromises.rm(join(cacheDir, name), { force: true }))
    )
  }

  private schedulePersistentCachePrune(): void {
    if (this.persistentCachePrunePromise) {
      this.persistentCachePrunePending = true
      return
    }
    this.persistentCachePrunePromise = this.prunePersistentCache()
      .catch((error) => imageDecryptLog('[ImageDecrypt] persistent cache prune failed:', error))
      .finally(() => {
        this.persistentCachePrunePromise = null
        if (this.persistentCachePrunePending) {
          this.persistentCachePrunePending = false
          this.schedulePersistentCachePrune()
        }
      })
  }

  private async prunePersistentCache(): Promise<void> {
    const cacheDir = this.getPersistentCacheDir()
    if (!cacheDir) return

    const entries = await fsPromises.readdir(cacheDir, { withFileTypes: true })
    const payloadNames = entries
      .filter(
        (entry) => entry.isFile() && /^[a-f0-9]{64}\.(?:jpe?g|png|gif|bmp|webp)$/i.test(entry.name)
      )
      .map((entry) => entry.name)
    const payloads = (
      await Promise.all(
        payloadNames.map(async (name) => {
          try {
            const stat = await fsPromises.stat(join(cacheDir, name))
            return { name, size: stat.size, mtimeMs: stat.mtimeMs }
          } catch {
            return null
          }
        })
      )
    )
      .filter((entry): entry is { name: string; size: number; mtimeMs: number } => entry !== null)
      .sort((left, right) => left.mtimeMs - right.mtimeMs)

    let totalBytes = payloads.reduce((total, entry) => total + entry.size, 0)
    let totalFiles = payloads.length
    for (const payload of payloads) {
      if (
        totalFiles <= MAX_PERSISTENT_IMAGE_CACHE_FILES &&
        totalBytes <= MAX_PERSISTENT_IMAGE_CACHE_BYTES
      ) {
        break
      }
      const cacheKey = payload.name.slice(0, 64)
      await Promise.allSettled([
        fsPromises.rm(join(cacheDir, payload.name), { force: true }),
        fsPromises.rm(join(cacheDir, `${cacheKey}.json`), { force: true })
      ])
      totalFiles -= 1
      totalBytes -= payload.size
    }

    const remainingPayloadKeys = new Set(
      payloads.slice(payloads.length - totalFiles).map((payload) => payload.name.slice(0, 64))
    )
    const staleMetadata = entries.filter(
      (entry) =>
        entry.isFile() &&
        /^[a-f0-9]{64}\.json$/i.test(entry.name) &&
        !remainingPayloadKeys.has(entry.name.slice(0, 64))
    )
    await Promise.allSettled(
      staleMetadata.map((entry) => fsPromises.rm(join(cacheDir, entry.name), { force: true }))
    )
  }

  private fastProbabilisticSearch(
    attachDir: string,
    datName: string,
    allowThumbnail = true,
    preferThumbnail = false,
    sessionDirectory = '',
    createTime?: number
  ): string | null {
    const normalized = this.normalizeDatBase(datName)
    if (!normalized) return null

    const variants = this.buildPreferredDatNames(normalized)

    if (/^[a-f0-9]{32}$/.test(normalized)) {
      const dir1 = normalized.substring(0, 2)
      const dir2 = normalized.substring(2, 4)
      for (const variant of variants) {
        const candidates = [
          join(attachDir, dir1, dir2, variant),
          join(attachDir, dir1, dir2, 'Img', variant),
          join(attachDir, dir1, dir2, 'Image', variant),
          join(attachDir, dir1, dir2, 'image', variant)
        ]
        const found = this.getLargestExistingPath(candidates, allowThumbnail, preferThumbnail)
        if (found) {
          imageDecryptLog('[ImageDecrypt] prefix path hit:', found)
          return found
        }
      }
    }

    try {
      const sessionDirs = sessionDirectory
        ? existsSync(join(attachDir, sessionDirectory))
          ? [sessionDirectory]
          : []
        : readdirSync(attachDir).filter((name) => name.length === 32 && /^[a-f0-9]+$/i.test(name))

      for (const sessDir of sessionDirs) {
        const sessionRoot = join(attachDir, sessDir)
        const months = sessionDirectory
          ? this.getImageMonthDirectories(sessionRoot, createTime)
          : this.getRecentImageMonths(24)
        for (const month of months) {
          for (const sub of ['Img', 'Image', 'image']) {
            const imgDir = join(attachDir, sessDir, month, sub)
            if (!existsSync(imgDir)) continue

            const found = this.getLargestExistingPath(
              variants.map((variant) => join(imgDir, variant)),
              allowThumbnail,
              preferThumbnail
            )
            if (found) {
              imageDecryptLog('[ImageDecrypt] found at:', found)
              return found
            }
          }
        }
      }
    } catch (e) {
      imageDecryptLog('[ImageDecrypt]遍历目录失败:', e)
    }

    return null
  }

  private findImageFileInLegacyDirs(
    accountDir: string,
    datName: string,
    allowThumbnail = true,
    preferThumbnail = false
  ): string | null {
    const normalized = this.normalizeDatBase(datName)
    if (!normalized) return null

    const roots = [
      join(accountDir, 'FileStorage', 'Image'),
      join(accountDir, 'FileStorage', 'Image2'),
      join(accountDir, 'FileStorage', 'MsgImg')
    ].filter((root) => existsSync(root))

    for (const root of roots) {
      const found = this.recursiveFindDat(root, normalized, 5, allowThumbnail, preferThumbnail)
      if (found) return found
    }

    return null
  }

  private recursiveFindDat(
    dir: string,
    datName: string,
    depth: number,
    allowThumbnail = true,
    preferThumbnail = false
  ): string | null {
    if (depth < 0) return null

    try {
      const variantNames = this.buildPreferredDatNames(datName).filter(
        (name) => allowThumbnail || !this.isThumbnailName(name)
      )
      const variants = new Set(
        preferThumbnail
          ? [
              ...variantNames.filter((name) => this.isThumbnailName(name)),
              ...variantNames.filter((name) => !this.isThumbnailName(name))
            ]
          : variantNames
      )
      const entries = readdirSync(dir)
      const matchingFiles: string[] = []
      for (const entry of entries) {
        const fullPath = join(dir, entry)
        const stat = statSync(fullPath)
        if (stat.isFile() && variants.has(entry.toLowerCase())) {
          matchingFiles.push(fullPath)
        }
      }
      const preferredFile = this.getLargestExistingPath(
        matchingFiles,
        allowThumbnail,
        preferThumbnail
      )
      if (preferredFile) {
        imageDecryptLog('[ImageDecrypt] legacy path hit:', preferredFile)
        return preferredFile
      }

      for (const entry of entries) {
        const fullPath = join(dir, entry)
        if (!statSync(fullPath).isDirectory()) continue
        const found = this.recursiveFindDat(
          fullPath,
          datName,
          depth - 1,
          allowThumbnail,
          preferThumbnail
        )
        if (found) return found
      }
    } catch {
      return null
    }

    return null
  }

  /**
   * 解密图片文件并返回 Buffer
   */
  decryptImage(datPath: string): Buffer | null {
    if (!existsSync(datPath)) {
      imageDecryptLog('[ImageDecrypt] file not found:', datPath)
      this.lastDecodeDiagnostic = {
        code: 'FILE_NOT_FOUND',
        detail: '候选图片文件不存在'
      }
      return null
    }

    try {
      const source = readFileSync(datPath)
      const directExtension = this.detectImageExtension(source)
      if (directExtension) {
        this.lastDecodeDiagnostic = {
          code: 'DIRECT_IMAGE',
          detail: 'DAT 文件内容是可直接读取的图片',
          fileSize: source.length,
          imageFormat: directExtension.replace(/^\./, '').toUpperCase()
        }
        return source
      }
      const version = this.getDatVersion(datPath)
      const fileSize = statSync(datPath).size
      imageDecryptLog(
        '[ImageDecrypt] dat version:',
        version,
        'file:',
        datPath,
        'aesKey present:',
        !!this.aesKey
      )

      let decrypted: Buffer
      if (version === 2) {
        // WeChat 4.0 标准 dat 头: 07 08 56 32 08 07
        imageDecryptLog('[ImageDecrypt] using WeChat 4.0 (user AES key)')
        if (!this.aesKey) {
          imageDecryptLog('[ImageDecrypt] no AES key configured')
          this.lastDecodeDiagnostic = {
            code: 'MISSING_AES_KEY',
            detail: '未配置 AES 图片密钥',
            datVersion: version,
            fileSize
          }
          return null
        }
        const key = Buffer.from(this.aesKey, 'ascii').slice(0, 16)
        decrypted = this.decryptDatV4(datPath, key)
      } else {
        // 仅支持 WeChat 4.0：版本不匹配直接返回 null，不做 V3/老版本兜底。
        imageDecryptLog('[ImageDecrypt] unsupported dat version (WeChat 4.0 only):', version)
        this.lastDecodeDiagnostic = {
          code: 'UNSUPPORTED_DAT_VERSION',
          detail: '不是受支持的 WeChat 4.0 DAT 图片格式',
          datVersion: version,
          fileSize
        }
        return null
      }

      this.lastDecodeDiagnostic = {
        code: 'SUCCESS',
        detail: 'DAT 数据已解密，正在识别图片格式',
        datVersion: version,
        fileSize
      }
      return decrypted
    } catch (error) {
      imageDecryptLog('[ImageDecrypt] decrypt error:', error)
      const message = error instanceof Error ? error.message : String(error)
      const aesFailure = /padding|bad decrypt|decrypt/i.test(message)
      this.lastDecodeDiagnostic = {
        code: aesFailure ? 'AES_DECRYPT_FAILED' : 'INVALID_DAT_FILE',
        detail: aesFailure
          ? 'AES 解密校验失败，密钥可能与当前账号不匹配'
          : 'DAT 文件结构异常或文件不完整',
        datVersion: 2,
        fileSize: existsSync(datPath) ? statSync(datPath).size : undefined
      }
      return null
    }
  }

  /**
   * 将解密后的图片转换为 base64
   */
  decryptImageToBase64(datPath: string): string | null {
    if (!extname(datPath).toLowerCase().includes('dat')) {
      try {
        const data = readFileSync(datPath)
        const ext = this.detectImageExtension(data) || extname(datPath).toLowerCase()
        const mimeType = this.getMimeType(ext)
        this.lastDecodeDiagnostic = {
          code: 'DIRECT_IMAGE',
          detail: '文件本身是可直接读取的图片',
          fileSize: data.length,
          imageFormat: ext.replace(/^\./, '').toUpperCase()
        }
        return `data:${mimeType};base64,${data.toString('base64')}`
      } catch {
        this.lastDecodeDiagnostic = {
          code: 'FILE_NOT_FOUND',
          detail: '候选图片文件无法读取'
        }
        return null
      }
    }

    const decrypted = this.decryptImage(datPath)
    if (!decrypted) return null

    const directImage = this.lastDecodeDiagnostic.code === 'DIRECT_IMAGE'
    const wxgf = this.isWxgfBuffer(decrypted)
    const unwrapped = this.unwrapWxgf(decrypted)
    const ext = this.detectImageExtension(unwrapped)
    if (!ext) {
      imageDecryptLog('[ImageDecrypt] unknown image format')
      this.lastDecodeDiagnostic = {
        ...this.lastDecodeDiagnostic,
        code: wxgf ? 'WXGF_REQUIRES_DECODER' : 'UNKNOWN_IMAGE_FORMAT',
        detail: wxgf
          ? '已解密为 WXGF/HEVC 数据，但 FFmpeg 转换未成功'
          : '数据已解密，但无法识别为常见图片格式',
        wxgf
      }
      return null
    }

    const mimeType = this.getMimeType(ext)
    this.lastDecodeDiagnostic = {
      ...this.lastDecodeDiagnostic,
      code: directImage ? 'DIRECT_IMAGE' : 'SUCCESS',
      detail: directImage ? 'DAT 文件内容是可直接读取的图片' : '图片解密并识别成功',
      imageFormat: ext.replace(/^\./, '').toUpperCase(),
      wxgf
    }
    return `data:${mimeType};base64,${unwrapped.toString('base64')}`
  }

  /**
   * 首选 DAT 无法解密时，继续尝试同目录下属于同一图片的其他清晰度变体。
   * 微信可能只保留 base/_h/_hd/_t 中的一部分，不能把首个文件失败等同于整张图失败。
   */
  decryptImageToBase64WithFallback(
    datPath: string,
    allowThumbnail = true
  ): { data: string; filePath: string } | null {
    const candidates = [datPath]
    if (extname(datPath).toLowerCase().includes('dat')) {
      const dir = dirname(datPath)
      const base = this.normalizeDatBase(basename(datPath))
      const siblings = this.buildPreferredDatNames(base)
        .filter((name) => allowThumbnail || !this.isThumbnailName(name))
        .map((name) => join(dir, name))
        .filter((candidate) => existsSync(candidate))
        .sort((left, right) => {
          const leftThumb = this.isThumbnailName(basename(left)) ? 1 : 0
          const rightThumb = this.isThumbnailName(basename(right)) ? 1 : 0
          if (leftThumb !== rightThumb) return leftThumb - rightThumb
          return statSync(right).size - statSync(left).size
        })
      candidates.push(...siblings)
    }

    for (const candidate of this.uniq(candidates)) {
      const data = this.decryptImageToBase64(candidate)
      if (data) return { data, filePath: candidate }
    }
    imageDecryptLog('[ImageDecrypt] all variants failed:', this.uniq(candidates))
    return null
  }

  async decryptImageToBase64WithFallbackAsync(
    datPath: string,
    allowThumbnail = true
  ): Promise<{ data: string; filePath: string } | null> {
    if (!existsSync(datPath)) return null

    return new Promise((resolve) => {
      let settled = false
      const worker = new Worker(IMAGE_DECRYPT_WORKER_SOURCE, {
        eval: true,
        workerData: {
          datPath,
          allowThumbnail,
          xorKey: this.xorKey,
          aesKey: this.aesKey,
          ffmpegPath: resolveFfmpegExecutable()
        }
      })
      const timeout = setTimeout(() => {
        imageDecryptLog('[ImageDecrypt] worker timed out:', datPath)
        void worker.terminate()
        finish(null)
      }, 30_000)
      const finish = (result: { data: string; filePath: string } | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        resolve(result)
      }
      worker.once('message', (value: unknown) => {
        if (
          value &&
          typeof value === 'object' &&
          typeof (value as { data?: unknown }).data === 'string' &&
          typeof (value as { filePath?: unknown }).filePath === 'string'
        ) {
          finish(value as { data: string; filePath: string })
          return
        }
        finish(null)
      })
      worker.once('error', (error) => {
        imageDecryptLog('[ImageDecrypt] worker failed:', error)
        finish(null)
      })
      worker.once('exit', () => finish(null))
    })
  }

  /**
   * 检测 DAT 文件版本（仅识别 WeChat 4.0 头 V2）。
   * 老 V1 头（V3 及以下）直接返回 0，由调用方走"不支持"分支。
   */
  private getDatVersion(inputPath: string): number {
    const bytes = readFileSync(inputPath)
    if (bytes.length < 6) {
      return 0
    }

    const signature = bytes.subarray(0, 6)
    if (this.compareBytes(signature, Buffer.from([0x07, 0x08, 0x56, 0x32, 0x08, 0x07]))) {
      return 2
    }
    return 0
  }

  /**
   * V4 解密 - AES + XOR
   */
  private decryptDatV4(inputPath: string, aesKey: Buffer): Buffer {
    const bytes = readFileSync(inputPath)
    if (bytes.length < 0x0f) {
      throw new Error('文件太小，无法解析')
    }

    const header = bytes.subarray(0, 0x0f)
    const data = bytes.subarray(0x0f)

    const aesSize = this.bytesToInt32(header.subarray(6, 10))
    const xorSize = this.bytesToInt32(header.subarray(10, 14))

    // 对齐 AES 数据到 16 字节边界
    const remainder = ((aesSize % 16) + 16) % 16
    const alignedAesSize = aesSize + (16 - remainder)

    if (alignedAesSize > data.length) {
      throw new Error('文件格式异常：AES 数据长度超过文件实际长度')
    }

    // 解密 AES 数据
    const aesData = data.subarray(0, alignedAesSize)
    let unpadded: Buffer = Buffer.alloc(0)
    if (aesData.length > 0) {
      const decipher = crypto.createDecipheriv('aes-128-ecb', aesKey, null)
      decipher.setAutoPadding(false)
      const decrypted = Buffer.concat([decipher.update(aesData), decipher.final()])
      unpadded = this.strictRemovePadding(decrypted)
    }

    // 解密 XOR 数据
    const remaining = data.subarray(alignedAesSize)
    if (xorSize < 0 || xorSize > remaining.length) {
      throw new Error('文件格式异常：XOR 数据长度不合法')
    }

    let rawData: Buffer
    let xoredData: Buffer
    if (xorSize > 0) {
      const rawLength = remaining.length - xorSize
      if (rawLength < 0) {
        throw new Error('文件格式异常：原始数据长度小于XOR长度')
      }
      rawData = remaining.subarray(0, rawLength)
      const xorData = remaining.subarray(rawLength)
      xoredData = Buffer.alloc(xorData.length)
      for (let i = 0; i < xorData.length; i += 1) {
        xoredData[i] = xorData[i] ^ this.xorKey
      }
    } else {
      rawData = remaining
      xoredData = Buffer.alloc(0)
    }

    return Buffer.concat([unpadded, rawData, xoredData])
  }

  /**
   * 检测图片扩展名
   */
  private detectImageExtension(buffer: Buffer): string | null {
    if (buffer.length < 4) return null

    const SIGNATURES: Record<string, Buffer> = {
      '.jpg': Buffer.from([0xff, 0xd8, 0xff]),
      '.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      '.gif': Buffer.from([0x47, 0x49, 0x46, 0x38]),
      '.bmp': Buffer.from([0x42, 0x4d]),
      '.webp': Buffer.from([0x52, 0x49, 0x46, 0x46])
    }

    for (const [ext, sig] of Object.entries(SIGNATURES)) {
      if (this.compareBytes(buffer.subarray(0, sig.length), sig)) {
        return ext
      }
    }

    return null
  }

  private getMimeType(ext: string): string {
    const mimeTypes: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.bmp': 'image/bmp',
      '.webp': 'image/webp'
    }
    return mimeTypes[ext] || 'image/jpeg'
  }

  private normalizeDatBase(value: string): string {
    const lower = String(value || '')
      .trim()
      .toLowerCase()
    if (!lower) return ''
    const file = lower.split('/').pop()?.split('\\').pop() || lower
    const withoutDat = file.endsWith('.dat') ? file.slice(0, -4) : file
    return withoutDat
      .replace(/(_thumb|\.thumb|_hd|\.hd|_h_m|_h|\.h|_t_m|_t|\.t|_m|_b|_w|_c)$/i, '')
      .toLowerCase()
  }

  private getSessionDirectoryName(sessionId?: string): string {
    const value = String(sessionId || '').trim()
    if (!value) return ''
    if (/^[a-f0-9]{32}$/i.test(value)) return value.toLowerCase()
    return crypto.createHash('md5').update(value).digest('hex')
  }

  private getImageMonth(createTime?: number): string {
    if (!createTime || !Number.isFinite(createTime)) return ''
    const date = new Date(createTime * 1000)
    if (Number.isNaN(date.getTime())) return ''
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
  }

  private prioritizeImageMonth(months: string[], createTime?: number): string[] {
    const preferred = this.getImageMonth(createTime)
    if (!preferred || !months.includes(preferred)) return months
    return [preferred, ...months.filter((month) => month !== preferred)]
  }

  private getImageMonthDirectories(root: string, createTime?: number): string[] {
    try {
      const months = readdirSync(root)
        .filter((name) => /^\d{4}-\d{2}$/.test(name) && existsSync(join(root, name)))
        .sort((left, right) => right.localeCompare(left))
      return this.prioritizeImageMonth(months, createTime)
    } catch {
      return []
    }
  }

  private getRecentImageMonths(count: number): string[] {
    const now = new Date()
    return Array.from({ length: count }, (_, index) => {
      const date = new Date(now.getFullYear(), now.getMonth() - index, 1)
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
    })
  }

  private findBubblePreview(
    accountDir: string,
    imageKeys: string[],
    sessionDirectory: string,
    createTime?: number
  ): string | null {
    const cacheRoot = join(accountDir, 'cache')
    const months = this.getImageMonthDirectories(cacheRoot, createTime)
    const previewNames = imageKeys.flatMap((key) => [
      `${key}_b.dat`,
      `${key}_w.dat`,
      `${key}_c.dat`,
      `${key}_t_M.dat`,
      `${key}_t.dat`
    ])
    for (const month of months) {
      const bubbleDir = join(cacheRoot, month, 'Message', sessionDirectory, 'Bubble')
      const found = this.getLargestExistingPath(
        previewNames.map((name) => join(bubbleDir, name)),
        true,
        true
      )
      if (found) return found
    }
    return null
  }

  private async findBubblePreviewAsync(
    accountDir: string,
    imageKeys: string[],
    sessionDirectory: string,
    createTime?: number
  ): Promise<string | null> {
    const cacheRoot = join(accountDir, 'cache')
    let months: string[]
    try {
      months = (await fsPromises.readdir(cacheRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}$/.test(entry.name))
        .map((entry) => entry.name)
        .sort((left, right) => right.localeCompare(left))
    } catch {
      return null
    }
    months = this.prioritizeImageMonth(months, createTime)
    const previewNames = imageKeys.flatMap((key) => [
      `${key}_b.dat`,
      `${key}_w.dat`,
      `${key}_c.dat`,
      `${key}_t_M.dat`,
      `${key}_t.dat`
    ])
    for (const month of months) {
      const bubbleDir = join(cacheRoot, month, 'Message', sessionDirectory, 'Bubble')
      const found = await this.getLargestExistingPathAsync(
        previewNames.map((name) => join(bubbleDir, name)),
        true,
        true
      )
      if (found) return found
    }
    return null
  }

  private buildPreferredDatNames(baseName: string): string[] {
    const base = this.normalizeDatBase(baseName)
    if (!base) return []
    return [
      `${base}.dat`,
      `${base}_hd.dat`,
      `${base}_h_M.dat`,
      `${base}_h.dat`,
      `${base}_M.dat`,
      `${base}_b.dat`,
      `${base}_w.dat`,
      `${base}_c.dat`,
      `${base}_t_M.dat`,
      `${base}_t.dat`,
      `${base}.thumb.dat`,
      `${base}_thumb.dat`
    ]
  }

  private getPreferredDatVariantPath(
    inputPath: string,
    allowThumbnail: boolean,
    preferThumbnail = false
  ): string {
    const actualDir = dirname(inputPath)
    const base = this.normalizeDatBase(basename(inputPath))
    const variants = this.buildPreferredDatNames(base)
    const ordered = allowThumbnail
      ? variants
      : variants.filter((name) => !this.isThumbnailName(name))
    const largest = this.getLargestExistingPath(
      ordered.map((variant) => join(actualDir, variant)),
      allowThumbnail,
      preferThumbnail
    )
    if (largest) return largest
    return inputPath
  }

  private getLargestExistingPath(
    paths: string[],
    allowThumbnail: boolean,
    preferThumbnail = false
  ): string | null {
    const toSized = (candidates: string[]): { candidate: string; size: number }[] =>
      candidates
        .filter((candidate) => existsSync(candidate))
        .map((candidate) => {
          try {
            return { candidate, size: statSync(candidate).size }
          } catch {
            return { candidate, size: 0 }
          }
        })
        .sort((left, right) => right.size - left.size)

    const thumbnail = toSized(
      paths.filter((candidate) => imageFileQuality(candidate) === 'thumbnail')
    )
    if (preferThumbnail && thumbnail[0]) return thumbnail[0].candidate
    const allowed = toSized(paths)
      .filter((entry) => allowThumbnail || imageFileQuality(entry.candidate) !== 'thumbnail')
      .sort(
        (left, right) =>
          imageQualityRank(imageFileQuality(right.candidate)) -
            imageQualityRank(imageFileQuality(left.candidate)) || right.size - left.size
      )
    return allowed[0]?.candidate || null
  }

  private async getLargestExistingPathAsync(
    paths: string[],
    allowThumbnail: boolean,
    preferThumbnail = false
  ): Promise<string | null> {
    const sized = (
      await Promise.all(
        paths.map(async (candidate) => {
          try {
            const stat = await fsPromises.stat(candidate)
            return stat.isFile() ? { candidate, size: stat.size } : null
          } catch {
            return null
          }
        })
      )
    )
      .filter((entry): entry is { candidate: string; size: number } => entry !== null)
      .sort((left, right) => right.size - left.size)

    if (preferThumbnail) {
      const thumbnail = sized.find((entry) => imageFileQuality(entry.candidate) === 'thumbnail')
      if (thumbnail) return thumbnail.candidate
    }
    const allowed = sized
      .filter((entry) => allowThumbnail || imageFileQuality(entry.candidate) !== 'thumbnail')
      .sort(
        (left, right) =>
          imageQualityRank(imageFileQuality(right.candidate)) -
            imageQualityRank(imageFileQuality(left.candidate)) || right.size - left.size
      )
    return allowed[0]?.candidate || null
  }

  private isThumbnailName(fileName: string): boolean {
    return imageFileQuality(fileName) === 'thumbnail'
  }

  isThumbnailFile(filePath: string): boolean {
    return this.isThumbnailName(basename(filePath))
  }

  private unwrapWxgf(buffer: Buffer): Buffer {
    if (!this.isWxgfBuffer(buffer)) {
      return buffer
    }

    for (let i = 4; i < Math.min(buffer.length - 12, 4096); i += 1) {
      if (buffer[i] === 0xff && buffer[i + 1] === 0xd8 && buffer[i + 2] === 0xff) {
        return buffer.subarray(i)
      }
      if (
        buffer[i] === 0x89 &&
        buffer[i + 1] === 0x50 &&
        buffer[i + 2] === 0x4e &&
        buffer[i + 3] === 0x47
      ) {
        return buffer.subarray(i)
      }
    }

    return buffer
  }

  private isWxgfBuffer(buffer: Buffer): boolean {
    return (
      buffer.length >= 20 &&
      buffer[0] === 0x77 &&
      buffer[1] === 0x78 &&
      buffer[2] === 0x67 &&
      buffer[3] === 0x66
    )
  }

  private uniq(values: string[]): string[] {
    return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
  }

  private bytesToInt32(bytes: Buffer): number {
    return bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)
  }

  private compareBytes(a: Buffer, b: Buffer): boolean {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return false
    }
    return true
  }

  private strictRemovePadding(buffer: Buffer): Buffer {
    if (buffer.length === 0) return buffer
    const lastByte = buffer[buffer.length - 1]
    if (lastByte <= 0 || lastByte > 16 || lastByte > buffer.length) {
      throw new Error('invalid PKCS#7 padding')
    }
    const paddingLength = lastByte
    for (let i = buffer.length - paddingLength; i < buffer.length; i += 1) {
      if (buffer[i] !== lastByte) throw new Error('invalid PKCS#7 padding')
    }
    return buffer.subarray(0, buffer.length - paddingLength)
  }
}
