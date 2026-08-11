import crypto from 'crypto'
import fs from 'fs-extra'
import http from 'http'
import https from 'https'
import os from 'os'
import path from 'path'
import { Wcdb4Client } from './wcdb4-client'
import { classifyStickerHttpFailure, StickerFailureCode } from '../shared/sticker'

type StickerResult = {
  success: boolean
  data?: string
  error?: string
  failureCode?: StickerFailureCode
  httpStatus?: number
}

const downloadCache = new Map<string, Promise<StickerResult>>()

export class StickerService {
  private readonly cacheDir: string
  private readonly legacyCacheDir: string

  constructor(private readonly wcdb4Client?: Wcdb4Client | null) {
    this.cacheDir = path.join(os.homedir(), 'Documents', 'TraceMemo', 'Emojis')
    // Keep reading the former directory so existing sticker caches remain usable.
    this.legacyCacheDir = path.join(os.homedir(), 'Documents', 'WechatExplorer', 'Emojis')
  }

  async resolveSticker(cdnUrl?: string, md5?: string): Promise<StickerResult> {
    const normalizedMd5 = this.normalizeMd5(md5)
    let url = String(cdnUrl || '').trim()

    const cacheKey =
      normalizedMd5 || (url ? crypto.createHash('md5').update(url).digest('hex') : '')
    if (cacheKey) {
      const cached = await this.readCached(cacheKey)
      if (cached) return { success: true, data: cached }
    }

    if (normalizedMd5 && this.wcdb4Client) {
      const wechatCached = await this.readWechatEmoticonCache(normalizedMd5)
      if (wechatCached) return { success: true, data: wechatCached }
    }

    if (!url && normalizedMd5 && this.wcdb4Client) {
      url = this.wcdb4Client.resolveEmoticonCdnUrl(normalizedMd5) || ''
      if (!url) {
        console.warn(`[StickerService] emoticon CDN URL not found for md5=${normalizedMd5}`)
      }
    }

    if (!url) {
      return { success: false, error: '未找到表情包 CDN URL' }
    }

    const resolvedCacheKey = cacheKey || crypto.createHash('md5').update(url).digest('hex')

    const pending = downloadCache.get(resolvedCacheKey)
    if (pending) return pending

    const task = this.downloadToDataUrl(url, resolvedCacheKey)
    downloadCache.set(resolvedCacheKey, task)
    try {
      return await task
    } finally {
      downloadCache.delete(resolvedCacheKey)
    }
  }

  private async readCached(cacheKey: string): Promise<string | null> {
    const extensions = ['.gif', '.png', '.webp', '.jpg', '.jpeg']
    const cacheDirs = [
      this.cacheDir,
      this.legacyCacheDir
    ]
    for (const cacheDir of cacheDirs) {
      for (const ext of extensions) {
        const filePath = path.join(cacheDir, `${cacheKey}${ext}`)
        if (!fs.existsSync(filePath)) continue
        const buffer = await fs.readFile(filePath)
        return this.toDataUrl(buffer, ext)
      }
    }
    return null
  }

  private async readWechatEmoticonCache(md5: string): Promise<string | null> {
    const accountRoot = this.wcdb4Client?.getAccountRoot()
    if (!accountRoot) return null

    const cacheRoot = path.join(accountRoot, 'cache')
    if (!fs.existsSync(cacheRoot)) return null

    const prefix = md5.slice(0, 2)
    let months: string[] = []
    try {
      months = fs
        .readdirSync(cacheRoot)
        .filter((name) => /^\d{4}-\d{2}$/.test(name))
        .sort()
        .reverse()
    } catch {
      return null
    }

    for (const month of months) {
      const filePath = path.join(cacheRoot, month, 'Emoticon', prefix, md5)
      if (!fs.existsSync(filePath)) continue
      const buffer = await fs.readFile(filePath)
      const ext = this.detectExtension(buffer) || '.gif'
      return this.toDataUrl(buffer, ext)
    }

    return null
  }

  private downloadToDataUrl(
    url: string,
    cacheKey: string,
    redirectCount = 0
  ): Promise<StickerResult> {
    return new Promise((resolve) => {
      if (redirectCount > 5) {
        resolve({ success: false, error: '表情包下载重定向过多' })
        return
      }

      const client = url.startsWith('https:') ? https : http
      const request = client.get(
        url,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 MicroMessenger TraceMemo',
            Referer: 'https://weixin.qq.com/'
          }
        },
        (response) => {
          const redirectUrl = response.headers.location
          if (redirectUrl && [301, 302, 303, 307, 308].includes(Number(response.statusCode || 0))) {
            const nextUrl = new URL(redirectUrl, url).toString()
            response.resume()
            this.downloadToDataUrl(nextUrl, cacheKey, redirectCount + 1).then(resolve)
            return
          }

          if (response.statusCode !== 200) {
            const statusCode = Number(response.statusCode || 0)
            const failure = classifyStickerHttpFailure(statusCode, url)
            response.resume()
            console.warn(
              `[StickerService] download failed code=${failure.code} status=${statusCode} md5=${cacheKey} host=${this.getUrlHost(url)}`
            )
            resolve({
              success: false,
              error: failure.message,
              failureCode: failure.code,
              httpStatus: statusCode
            })
            return
          }

          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => chunks.push(chunk))
          response.on('end', async () => {
            const buffer = Buffer.concat(chunks)
            if (buffer.length === 0) {
              resolve({ success: false, error: '表情包内容为空' })
              return
            }

            const ext = this.detectExtension(buffer) || this.getExtFromUrl(url) || '.gif'
            try {
              await fs.ensureDir(this.cacheDir)
              await fs.writeFile(path.join(this.cacheDir, `${cacheKey}${ext}`), buffer)
            } catch {
              // Cache is best effort; the data URL can still be displayed.
            }
            resolve({ success: true, data: this.toDataUrl(buffer, ext) })
          })
        }
      )

      request.on('error', (error) => resolve({ success: false, error: error.message }))
      request.setTimeout(15000, () => {
        request.destroy()
        resolve({ success: false, error: '表情包下载超时' })
      })
    })
  }

  private detectExtension(buffer: Buffer): string | null {
    if (buffer.length >= 6 && buffer.subarray(0, 3).toString('ascii') === 'GIF') return '.gif'
    if (
      buffer.length >= 8 &&
      buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    )
      return '.png'
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
      return '.jpg'
    if (
      buffer.length >= 12 &&
      buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buffer.subarray(8, 12).toString('ascii') === 'WEBP'
    ) {
      return '.webp'
    }
    return null
  }

  private getExtFromUrl(url: string): string | null {
    try {
      const ext = path.extname(new URL(url).pathname).toLowerCase()
      return ['.gif', '.png', '.webp', '.jpg', '.jpeg'].includes(ext) ? ext : null
    } catch {
      return null
    }
  }

  private getUrlHost(url: string): string {
    try {
      return new URL(url).hostname || 'unknown'
    } catch {
      return 'unknown'
    }
  }

  private toDataUrl(buffer: Buffer, ext: string): string {
    const mimeTypes: Record<string, string> = {
      '.gif': 'image/gif',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg'
    }
    return `data:${mimeTypes[ext] || 'image/gif'};base64,${buffer.toString('base64')}`
  }

  private normalizeMd5(value?: string): string | undefined {
    const md5 = String(value || '')
      .trim()
      .toLowerCase()
    return /^[a-f0-9]{32}$/.test(md5) ? md5 : undefined
  }
}
