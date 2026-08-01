import fs from 'fs-extra'
import path from 'path'
import crypto from 'crypto'
import type { Wcdb4Client } from './wcdb4-client'

type VideoAsset = {
  filePath: string
  posterPath?: string
}

export class VideoAssetService {
  private readonly urlTokens = new Map<string, string>()
  private readonly fileTokens = new Map<string, string>()
  private index: Map<string, VideoAsset> | null = null

  constructor(private readonly client: Wcdb4Client) {}

  resolve(hashes: string[]): { success: boolean; url?: string; poster?: string; error?: string } {
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
      for (const name of fs.readdirSync(monthPath)) {
        const match = /^([a-f0-9]{32})(?:(_raw))?\.(mp4|jpg)$/i.exec(name)
        if (!match) continue
        const key = `${match[1].toLowerCase()}${match[2] || ''}`
        const fullPath = path.join(monthPath, name)
        const existing = result.get(key) || { filePath: '' }
        if (match[3].toLowerCase() === 'mp4') existing.filePath = fullPath
        else if (!existing.posterPath) existing.posterPath = fullPath
        result.set(key, existing)
      }
    }

    for (const [key, asset] of result) {
      if (!asset.filePath) result.delete(key)
    }
    this.index = result
    return result
  }
}
