import fs from 'fs-extra'
import path from 'path'
import crypto from 'crypto'
import { spawnSync } from 'node:child_process'
import ffmpegStaticPath from 'ffmpeg-static'
import type { Wcdb4Client } from './wcdb4-client'

type VideoAsset = {
  month: string
  filePath: string
  posterPath?: string
  duration?: number
  width?: number
  height?: number
}

type VideoIndex = {
  byName: Map<string, VideoAsset>
  byMonth: Map<string, VideoAsset[]>
}

export type VideoResolveContext = {
  createTime?: number
  duration?: number
  width?: number
  height?: number
}

export type VideoResolveResult = {
  success: boolean
  url?: string
  poster?: string
  error?: string
}

const normalizeHashes = (hashes: string[]): string[] =>
  Array.from(
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

const monthForTimestamp = (createTime?: number): string | null => {
  if (!createTime) return null
  const date = new Date(createTime * 1000)
  if (Number.isNaN(date.getTime())) return null
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

const resolveFfmpegPath = (): string | null => {
  const configured = String(process.env['FFMPEG_PATH'] || '').trim()
  if (configured && fs.existsSync(configured)) return configured
  const bundled = ffmpegStaticPath?.replace('app.asar', 'app.asar.unpacked')
  return bundled && fs.existsSync(bundled) ? bundled : null
}

const probeVideo = (filePath: string): { duration?: number; width?: number; height?: number } => {
  const ffmpegPath = resolveFfmpegPath()
  if (!ffmpegPath) return {}
  const result = spawnSync(ffmpegPath, ['-hide_banner', '-i', filePath], {
    timeout: 8_000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
    encoding: 'utf8'
  })
  const output = `${result.stderr || ''}\n${result.stdout || ''}`
  const durationMatch = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i.exec(output)
  const videoMatch = /Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b/i.exec(output)
  return {
    duration: durationMatch
      ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
      : undefined,
    width: videoMatch ? Number(videoMatch[1]) : undefined,
    height: videoMatch ? Number(videoMatch[2]) : undefined
  }
}

const scoreCandidate = (asset: VideoAsset, context: VideoResolveContext): number => {
  let score = 0
  if (context.duration && asset.duration) {
    const difference = Math.abs(context.duration - asset.duration)
    if (difference <= 1.5) {
      score += 55
    } else if (difference <= 3.5) {
      score += 35
    } else if (difference <= 8) {
      score += 15
    }
  }
  if (context.width && context.height && asset.width && asset.height) {
    if (context.width === asset.width && context.height === asset.height) {
      score += 40
    } else if (context.width === asset.height && context.height === asset.width) {
      score += 35
    } else {
      const expectedRatio = context.width / context.height
      const actualRatio = asset.width / asset.height
      if (Math.abs(expectedRatio - actualRatio) <= 0.03) {
        score += 20
      }
    }
  }
  return score
}

export class VideoAssetService {
  private readonly urlTokens = new Map<string, string>()
  private readonly contentIndexes = new Map<string, Promise<Map<string, VideoAsset[]>>>()
  private index: VideoIndex | null = null

  constructor(private readonly client: Wcdb4Client) {}

  resolve(hashes: string[]): VideoResolveResult {
    const candidates = normalizeHashes(hashes)
    if (candidates.length === 0) return { success: false, error: '视频标识为空' }

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

    const index = this.getIndex().byName
    for (const key of lookupKeys) {
      const asset = index.get(key) || index.get(`${key}_raw`)
      if (!asset) continue
      return {
        success: true,
        url: this.createUrl(asset.filePath),
        poster: asset.posterPath ? this.createUrl(asset.posterPath) : undefined
      }
    }
    return { success: false, error: '本地未找到该视频文件' }
  }

  async resolveForExport(
    hashes: string[],
    context: VideoResolveContext = {}
  ): Promise<VideoResolveResult> {
    const direct = this.resolve(hashes)
    if (direct.success) return direct

    const month = monthForTimestamp(context.createTime)
    if (!month) return direct
    const assets = this.getIndex().byMonth.get(month) || []
    if (assets.length === 0) return direct

    const hashesToFind = new Set(normalizeHashes(hashes))
    const contentIndex = await this.getContentIndex(month, assets)
    for (const hash of hashesToFind) {
      const matches = contentIndex.get(hash)
      if (matches?.length === 1) return this.resultForAsset(matches[0])
      if (matches && matches.length > 1) return this.resultForAsset(matches[0])
    }

    const ranked = assets
      .map((asset) => {
        this.ensureMetadata(asset)
        return { asset, score: scoreCandidate(asset, context) }
      })
      .sort(
        (left, right) =>
          right.score - left.score || left.asset.filePath.localeCompare(right.asset.filePath)
      )
    const best = ranked[0]
    return best ? this.resultForAsset(best.asset) : direct
  }

  pathForToken(token: string): string | undefined {
    const filePath = this.urlTokens.get(token)
    if (!filePath || !fs.existsSync(filePath)) return undefined
    return filePath
  }

  private createUrl(filePath: string): string {
    const token = crypto.randomBytes(18).toString('hex')
    this.urlTokens.set(token, filePath)
    if (this.urlTokens.size > 500) {
      const first = this.urlTokens.keys().next().value
      if (first) this.urlTokens.delete(first)
    }
    return `wxe-media://local/${token}`
  }

  private resultForAsset(asset: VideoAsset): VideoResolveResult {
    return {
      success: true,
      url: this.createUrl(asset.filePath),
      poster: asset.posterPath ? this.createUrl(asset.posterPath) : undefined
    }
  }

  private ensureMetadata(asset: VideoAsset): void {
    if (asset.duration !== undefined) return
    const probed = probeVideo(asset.filePath)
    asset.duration = probed.duration || 0
    if (asset.posterPath) {
      try {
        const dimensions = this.readJpegDimensions(asset.posterPath)
        asset.width = dimensions?.width || probed.width
        asset.height = dimensions?.height || probed.height
        return
      } catch {
        // Fall back to the video stream dimensions.
      }
    }
    asset.width = probed.width
    asset.height = probed.height
  }

  private readJpegDimensions(filePath: string): { width: number; height: number } | null {
    const buffer = fs.readFileSync(filePath)
    if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null
    let offset = 2
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1
        continue
      }
      const marker = buffer[offset + 1]
      const length = buffer.readUInt16BE(offset + 2)
      if (length < 2) break
      if (marker >= 0xc0 && marker <= 0xc3) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) }
      }
      offset += length + 2
    }
    return null
  }

  private async getContentIndex(
    month: string,
    assets: VideoAsset[]
  ): Promise<Map<string, VideoAsset[]>> {
    let pending = this.contentIndexes.get(month)
    if (!pending) {
      pending = (async () => {
        const result = new Map<string, VideoAsset[]>()
        for (const asset of assets) {
          const hash = await this.hashFile(asset.filePath).catch(() => null)
          if (!hash) continue
          result.set(hash, [...(result.get(hash) || []), asset])
        }
        return result
      })()
      this.contentIndexes.set(month, pending)
    }
    return pending
  }

  private hashFile(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('md5')
      const stream = fs.createReadStream(filePath)
      stream.on('data', (chunk) => hash.update(chunk))
      stream.on('error', reject)
      stream.on('end', () => resolve(hash.digest('hex')))
    })
  }

  private getIndex(): VideoIndex {
    if (this.index) return this.index
    const byName = new Map<string, VideoAsset>()
    const byMonth = new Map<string, VideoAsset[]>()
    const root = path.join(this.client.getAccountRoot(), 'msg', 'video')
    if (!fs.existsSync(root)) {
      this.index = { byName, byMonth }
      return this.index
    }

    for (const month of fs.readdirSync(root).sort()) {
      const monthPath = path.join(root, month)
      if (!fs.statSync(monthPath).isDirectory()) continue
      for (const name of fs.readdirSync(monthPath).sort()) {
        const match = /^([a-f0-9]{32})(?:(_raw))?(?:(_thumb))?\.(mp4|jpg)$/i.exec(name)
        if (!match) continue
        const key = `${match[1].toLowerCase()}${match[2] || ''}`
        const fullPath = path.join(monthPath, name)
        const existing = byName.get(key) || { month, filePath: '' }
        if (match[4].toLowerCase() === 'mp4') {
          existing.filePath = fullPath
        } else if (!existing.posterPath) existing.posterPath = fullPath
        byName.set(key, existing)
      }
    }

    for (const [key, asset] of byName) {
      if (!asset.filePath) {
        byName.delete(key)
        continue
      }
      byMonth.set(asset.month, [...(byMonth.get(asset.month) || []), asset])
    }
    this.index = { byName, byMonth }
    return this.index
  }
}
