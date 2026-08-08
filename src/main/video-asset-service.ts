import fs from 'fs-extra'
import path from 'path'
import crypto from 'crypto'
import type { Wcdb4Client } from './wcdb4-client'

type VideoAsset = {
  filePath: string
  posterPath?: string
}

export type VideoResolveOptions = {
  createTime?: number
  byteLength?: number
  duration?: number
  width?: number
  height?: number
}

type ImageDimensions = {
  width: number
  height: number
}

type Mp4Box = {
  type: string
  size: number
  contentOffset: number
}

export class VideoAssetService {
  private readonly urlTokens = new Map<string, string>()
  private readonly fileTokens = new Map<string, string>()
  private readonly monthAssets = new Map<string, VideoAsset[]>()
  private readonly fileHashes = new Map<string, Promise<string | undefined>>()
  private readonly videoDurations = new Map<string, number | undefined>()
  private readonly imageDimensions = new Map<string, ImageDimensions | undefined>()
  private index: Map<string, VideoAsset> | null = null

  constructor(private readonly client: Wcdb4Client) {}

  async resolve(
    hashes: string[],
    options: VideoResolveOptions = {}
  ): Promise<{ success: boolean; url?: string; poster?: string; error?: string }> {
    const candidates = Array.from(
      new Set(
        hashes
          .map((value) =>
            String(value || '')
              .trim()
              .toLowerCase()
          )
          .filter((value) => /^[a-f0-9]{32}$/.test(value))
      )
    )
    const hasMetadata =
      Number(options.byteLength) > 0 ||
      Number(options.duration) > 0 ||
      (Number(options.width) > 0 && Number(options.height) > 0)
    if (candidates.length === 0 && !hasMetadata) {
      return { success: false, error: '视频标识为空' }
    }

    const hardlinkDb = path.join(
      this.client.getAccountRoot(),
      'db_storage',
      'hardlink',
      'hardlink.db'
    )
    const lookupKeys = [...candidates]
    if (fs.existsSync(hardlinkDb)) {
      for (const hash of candidates) {
        const resolved = this.client.resolveVideoHardlink(hash, hardlinkDb)?.resolved_md5
        if (resolved) lookupKeys.unshift(String(resolved).trim().toLowerCase())
      }
    }

    const index = this.getIndex()
    for (const key of lookupKeys) {
      const asset = index.get(key) || index.get(`${key}_raw`)
      if (!asset) continue
      return {
        success: true,
        url: this.createLocalMediaUrl(asset.filePath),
        poster: asset.posterPath ? this.createLocalMediaUrl(asset.posterPath) : undefined
      }
    }

    const fallback = await this.resolveFromLocalMetadata(candidates, options)
    if (fallback) {
      return {
        success: true,
        url: this.createLocalMediaUrl(fallback.filePath),
        poster: fallback.posterPath ? this.createLocalMediaUrl(fallback.posterPath) : undefined
      }
    }
    return { success: false, error: '本地未找到该视频文件' }
  }

  pathForToken(token: string): string | undefined {
    const filePath = this.urlTokens.get(token)
    if (!filePath || !fs.existsSync(filePath)) return undefined
    return filePath
  }

  pathForUrl(url: string): string | undefined {
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'wxe-media:' || parsed.hostname !== 'local') return undefined
      return this.pathForToken(parsed.pathname.replace(/^\/+/, ''))
    } catch {
      return undefined
    }
  }

  createLocalMediaUrl(filePath: string): string {
    const normalizedPath = path.resolve(filePath)
    const existingToken = this.fileTokens.get(normalizedPath)
    if (existingToken && this.urlTokens.get(existingToken) === normalizedPath) {
      return `wxe-media://local/${existingToken}`
    }

    const token = crypto.randomBytes(18).toString('hex')
    this.urlTokens.set(token, normalizedPath)
    this.fileTokens.set(normalizedPath, token)
    if (this.urlTokens.size > 2048) {
      const oldestToken = this.urlTokens.keys().next().value
      if (oldestToken) {
        const oldestPath = this.urlTokens.get(oldestToken)
        this.urlTokens.delete(oldestToken)
        if (oldestPath) this.fileTokens.delete(oldestPath)
      }
    }
    return `wxe-media://local/${token}`
  }

  private getIndex(): Map<string, VideoAsset> {
    if (this.index) return this.index
    const result = new Map<string, VideoAsset>()
    const root = path.join(this.client.getAccountRoot(), 'msg', 'video')
    if (!fs.existsSync(root)) {
      this.index = result
      return result
    }

    for (const month of fs.readdirSync(root)) {
      const monthPath = path.join(root, month)
      if (!fs.statSync(monthPath).isDirectory()) continue
      const monthly = new Map<string, VideoAsset>()
      for (const name of fs.readdirSync(monthPath)) {
        const videoMatch = /^([a-f0-9]{32})(?:(_raw))?\.mp4$/i.exec(name)
        const posterMatch = /^([a-f0-9]{32})(?:(_raw))?(?:_thumb)?\.jpg$/i.exec(name)
        const match = videoMatch || posterMatch
        if (!match) continue
        const key = `${match[1].toLowerCase()}${match[2] || ''}`
        const fullPath = path.join(monthPath, name)
        const existing = monthly.get(key) || { filePath: '' }
        if (videoMatch) existing.filePath = fullPath
        else if (!existing.posterPath) existing.posterPath = fullPath
        monthly.set(key, existing)
      }

      const assets: VideoAsset[] = []
      for (const [key, asset] of monthly) {
        if (!asset.filePath) continue
        result.set(key, asset)
        assets.push(asset)
      }
      this.monthAssets.set(month, assets)
    }
    this.index = result
    return result
  }

  private async resolveFromLocalMetadata(
    hashes: string[],
    options: VideoResolveOptions
  ): Promise<VideoAsset | undefined> {
    const month = this.monthForCreateTime(options.createTime)
    if (!month) return undefined

    this.getIndex()
    const assets = this.monthAssets.get(month) || []
    if (assets.length === 0) return undefined

    let narrowed = assets
    let appliedCriteria = 0
    const byteLength = Number(options.byteLength)
    if (byteLength > 0) {
      const matches = narrowed.filter((asset) => {
        try {
          return fs.statSync(asset.filePath).size === byteLength
        } catch {
          return false
        }
      })
      if (matches.length > 0) {
        narrowed = matches
        appliedCriteria += 1
      }
    }

    const width = Number(options.width)
    const height = Number(options.height)
    if (width > 0 && height > 0) {
      const matches = narrowed.filter((asset) => {
        const dimensions = asset.posterPath ? this.readImageDimensions(asset.posterPath) : undefined
        return dimensions?.width === width && dimensions.height === height
      })
      if (matches.length > 0) {
        narrowed = matches
        appliedCriteria += 1
      }
    }

    const duration = Number(options.duration)
    if (duration > 0) {
      const matches = narrowed.filter((asset) => {
        const actual = this.readMp4Duration(asset.filePath)
        return actual !== undefined && Math.abs(actual - duration) <= 1.5
      })
      if (matches.length > 0) {
        narrowed = matches
        appliedCriteria += 1
      }
    }

    if (appliedCriteria >= 2 && narrowed.length === 1) return narrowed[0]

    const hashPool = narrowed.length > 0 ? narrowed : assets
    const contentMatches: VideoAsset[] = []
    for (const asset of hashPool) {
      const contentHash = await this.hashFile(asset.filePath)
      if (contentHash && hashes.includes(contentHash)) contentMatches.push(asset)
    }
    return contentMatches.length === 1 ? contentMatches[0] : undefined
  }

  private monthForCreateTime(createTime?: number): string | undefined {
    const raw = Number(createTime)
    if (!Number.isFinite(raw) || raw <= 0) return undefined
    const date = new Date(raw > 10_000_000_000 ? raw : raw * 1000)
    if (Number.isNaN(date.getTime())) return undefined
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
  }

  private hashFile(filePath: string): Promise<string | undefined> {
    const cached = this.fileHashes.get(filePath)
    if (cached) return cached
    const pending = new Promise<string | undefined>((resolve) => {
      const hash = crypto.createHash('md5')
      const stream = fs.createReadStream(filePath)
      stream.on('data', (chunk) => hash.update(chunk))
      stream.on('error', () => resolve(undefined))
      stream.on('end', () => resolve(hash.digest('hex')))
    })
    this.fileHashes.set(filePath, pending)
    return pending
  }

  private readImageDimensions(filePath: string): ImageDimensions | undefined {
    if (this.imageDimensions.has(filePath)) return this.imageDimensions.get(filePath)
    let dimensions: ImageDimensions | undefined
    try {
      const data = fs.readFileSync(filePath)
      if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
        let offset = 2
        const startOfFrame = new Set([
          0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf
        ])
        while (offset + 8 < data.length) {
          if (data[offset] !== 0xff) {
            offset += 1
            continue
          }
          while (offset < data.length && data[offset] === 0xff) offset += 1
          const marker = data[offset]
          offset += 1
          if (marker === 0xd8 || marker === 0x01) continue
          if (marker === 0xd9 || marker === 0xda || offset + 2 > data.length) break
          const length = data.readUInt16BE(offset)
          if (length < 2 || offset + length > data.length) break
          if (startOfFrame.has(marker) && length >= 7) {
            dimensions = {
              height: data.readUInt16BE(offset + 3),
              width: data.readUInt16BE(offset + 5)
            }
            break
          }
          offset += length
        }
      }
    } catch {
      dimensions = undefined
    }
    this.imageDimensions.set(filePath, dimensions)
    return dimensions
  }

  private readMp4Duration(filePath: string): number | undefined {
    if (this.videoDurations.has(filePath)) return this.videoDurations.get(filePath)
    let duration: number | undefined
    let descriptor: number | undefined
    try {
      descriptor = fs.openSync(filePath, 'r')
      const fileSize = fs.fstatSync(descriptor).size
      const moov = this.findMp4Box(descriptor, 0, fileSize, 'moov')
      const mvhd = moov
        ? this.findMp4Box(descriptor, moov.contentOffset, moov.contentOffset + moov.size, 'mvhd')
        : undefined
      if (mvhd) {
        const header = Buffer.alloc(32)
        const bytesRead = fs.readSync(descriptor, header, 0, header.length, mvhd.contentOffset)
        const version = header[0]
        if (version === 0 && bytesRead >= 20) {
          const timescale = header.readUInt32BE(12)
          const ticks = header.readUInt32BE(16)
          if (timescale > 0) duration = ticks / timescale
        } else if (version === 1 && bytesRead >= 32) {
          const timescale = header.readUInt32BE(20)
          const ticks = Number(header.readBigUInt64BE(24))
          if (timescale > 0 && Number.isSafeInteger(ticks)) duration = ticks / timescale
        }
      }
    } catch {
      duration = undefined
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor)
    }
    this.videoDurations.set(filePath, duration)
    return duration
  }

  private findMp4Box(
    descriptor: number,
    start: number,
    end: number,
    target: string
  ): Mp4Box | undefined {
    let offset = start
    const header = Buffer.alloc(16)
    while (offset + 8 <= end) {
      const bytesRead = fs.readSync(descriptor, header, 0, header.length, offset)
      if (bytesRead < 8) return undefined
      const size32 = header.readUInt32BE(0)
      const type = header.toString('ascii', 4, 8)
      let headerSize = 8
      let size = size32
      if (size32 === 1) {
        if (bytesRead < 16) return undefined
        const extendedSize = header.readBigUInt64BE(8)
        if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) return undefined
        size = Number(extendedSize)
        headerSize = 16
      } else if (size32 === 0) {
        size = end - offset
      }
      if (size < headerSize || offset + size > end) return undefined
      if (type === target) {
        return { type, size: size - headerSize, contentOffset: offset + headerSize }
      }
      offset += size
    }
    return undefined
  }
}
