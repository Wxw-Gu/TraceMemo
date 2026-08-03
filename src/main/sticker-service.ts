import crypto from 'crypto'
import fs from 'fs-extra'
import http from 'http'
import https from 'https'
import os from 'os'
import path from 'path'
import zlib from 'zlib'
import { Wcdb4Client } from './wcdb4-client'

type StickerResult = { success: boolean; data?: string; error?: string }

const downloadCache = new Map<string, Promise<StickerResult>>()

export class StickerService {
  private readonly cacheDir: string

  constructor(private readonly wcdb4Client?: Wcdb4Client | null) {
    this.cacheDir = path.join(os.homedir(), 'Documents', 'WechatExplorer', 'Emojis')
  }

  async resolveSticker(
    cdnUrl?: string,
    md5?: string,
    options?: { thumbUrl?: string; encryptUrl?: string; aesKey?: string }
  ): Promise<StickerResult> {
    const normalizedMd5 = this.normalizeMd5(md5)
    const metadata = normalizedMd5 ? this.wcdb4Client?.resolveEmoticonInfo(normalizedMd5) : null
    const aesKey = String(options?.aesKey || metadata?.aesKey || '').trim()
    const clearUrls = this.uniq([
      cdnUrl,
      options?.thumbUrl,
      metadata?.cdnUrl,
      metadata?.externUrl,
      metadata?.thumbUrl
    ])
    const encryptedUrls = this.uniq([options?.encryptUrl, metadata?.encryptUrl])

    const cacheKey =
      normalizedMd5 ||
      (clearUrls[0] || encryptedUrls[0]
        ? crypto
            .createHash('md5')
            .update(clearUrls[0] || encryptedUrls[0])
            .digest('hex')
        : '')
    if (cacheKey) {
      const cached = await this.readCached(cacheKey, aesKey)
      if (cached) return { success: true, data: cached }
    }

    if (normalizedMd5 && this.wcdb4Client) {
      const wechatCached = await this.readWechatEmoticonCache(normalizedMd5, aesKey)
      if (wechatCached) return { success: true, data: wechatCached }
    }

    if (clearUrls.length === 0 && encryptedUrls.length === 0 && normalizedMd5 && this.wcdb4Client) {
      const fallbackUrl = this.wcdb4Client.resolveEmoticonCdnUrl(normalizedMd5)
      if (fallbackUrl) clearUrls.push(fallbackUrl)
    }

    if (clearUrls.length === 0 && encryptedUrls.length === 0) {
      return {
        success: false,
        error: aesKey ? '表情包缓存无法解密，且未找到 CDN URL' : '未找到表情包 CDN URL 或解密密钥'
      }
    }

    const resolvedCacheKey =
      cacheKey ||
      crypto
        .createHash('md5')
        .update(clearUrls[0] || encryptedUrls[0])
        .digest('hex')

    const pending = downloadCache.get(resolvedCacheKey)
    if (pending) return pending

    const task = this.resolveFromUrls(clearUrls, encryptedUrls, resolvedCacheKey, aesKey)
    downloadCache.set(resolvedCacheKey, task)
    try {
      return await task
    } finally {
      downloadCache.delete(resolvedCacheKey)
    }
  }

  private async resolveFromUrls(
    clearUrls: string[],
    encryptedUrls: string[],
    cacheKey: string,
    aesKey: string
  ): Promise<StickerResult> {
    let lastError = '表情包下载失败'
    for (const url of clearUrls) {
      const result = await this.downloadToDataUrl(url, cacheKey)
      if (result.success) return result
      lastError = result.error || lastError
    }
    if (aesKey) {
      // Some WeChat builds put encrypted payloads in cdn_url instead of encrypt_url.
      // Retry every candidate with the message's AES key after the clear-image attempt.
      for (const url of this.uniq([...encryptedUrls, ...clearUrls])) {
        const result = await this.downloadToDataUrl(url, cacheKey, aesKey)
        if (result.success) return result
        lastError = result.error || lastError
      }
    } else if (encryptedUrls.length > 0) {
      lastError = '表情包只有加密 CDN 地址，但缺少 AES 密钥'
    }
    return { success: false, error: lastError }
  }

  private async readCached(cacheKey: string, aesKey: string): Promise<string | null> {
    const extensions = ['.gif', '.png', '.webp', '.jpg', '.jpeg']
    const cacheDirs = [
      this.cacheDir,
      path.join(os.homedir(), 'Documents', 'WechatExplorer', 'Emojis')
    ]
    for (const cacheDir of cacheDirs) {
      for (const ext of extensions) {
        const filePath = path.join(cacheDir, `${cacheKey}${ext}`)
        if (!fs.existsSync(filePath)) continue
        const buffer = await fs.readFile(filePath)
        const decoded = this.decodeStickerBuffer(buffer, aesKey)
        if (decoded) return this.toDataUrl(decoded.buffer, decoded.ext)
      }
    }
    return null
  }

  private async readWechatEmoticonCache(md5: string, aesKey: string): Promise<string | null> {
    const accountRoot = this.wcdb4Client?.getAccountRoot()
    if (!accountRoot) return null

    const prefix = md5.slice(0, 2)
    const businessRoot = path.join(accountRoot, 'business', 'emoticon')
    const persistedCandidates = [
      path.join(businessRoot, 'Persist', prefix, md5),
      path.join(businessRoot, 'PersistStore', prefix, md5),
      path.join(businessRoot, 'ThumbStore', prefix, md5),
      path.join(businessRoot, 'ThumbStore', prefix, `${md5}.icon`),
      path.join(businessRoot, 'Thumb', prefix, `${md5}.thumb`)
    ]
    for (const filePath of persistedCandidates) {
      if (!fs.existsSync(filePath)) continue
      const buffer = await fs.readFile(filePath)
      const decoded = this.decodeStickerBuffer(buffer, aesKey)
      if (decoded) return this.toDataUrl(decoded.buffer, decoded.ext)
    }

    const cacheRoot = path.join(accountRoot, 'cache')
    if (!fs.existsSync(cacheRoot)) return null
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
      const decoded = this.decodeStickerBuffer(buffer, aesKey)
      if (decoded) return this.toDataUrl(decoded.buffer, decoded.ext)
    }

    return null
  }

  private downloadToDataUrl(
    url: string,
    cacheKey: string,
    aesKey = '',
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
            'User-Agent': 'Mozilla/5.0 MicroMessenger WechatExplorer',
            Referer: 'https://weixin.qq.com/'
          }
        },
        (response) => {
          const redirectUrl = response.headers.location
          if (redirectUrl && [301, 302, 303, 307, 308].includes(Number(response.statusCode || 0))) {
            const nextUrl = new URL(redirectUrl, url).toString()
            this.downloadToDataUrl(nextUrl, cacheKey, aesKey, redirectCount + 1).then(resolve)
            return
          }

          if (response.statusCode !== 200) {
            console.warn(
              `[StickerService] download failed: HTTP ${response.statusCode}; md5=${cacheKey}; url=${url}`
            )
            resolve({ success: false, error: `表情包下载失败: HTTP ${response.statusCode}` })
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

            const decoded = this.decodeStickerBuffer(buffer, aesKey)
            if (!decoded) {
              resolve({ success: false, error: '下载到的表情包不是受支持的图片，或解密失败' })
              return
            }
            try {
              await fs.ensureDir(this.cacheDir)
              await fs.writeFile(
                path.join(this.cacheDir, `${cacheKey}${decoded.ext}`),
                decoded.buffer
              )
            } catch {
              // Cache is best effort; the data URL can still be displayed.
            }
            resolve({ success: true, data: this.toDataUrl(decoded.buffer, decoded.ext) })
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

  private decodeStickerBuffer(
    buffer: Buffer,
    aesKey: string
  ): { buffer: Buffer; ext: string } | null {
    const directExt = this.detectExtension(buffer)
    if (directExt) return { buffer, ext: directExt }
    if (!aesKey) return null

    const decryptedCandidates: Buffer[] = []
    const asciiKey = Buffer.from(aesKey, 'utf8')
    if (asciiKey.length === 32 && buffer.length > 28) {
      try {
        const nonce = buffer.subarray(buffer.length - 28, buffer.length - 16)
        const authTag = buffer.subarray(buffer.length - 16)
        const decipher = crypto.createDecipheriv('aes-256-gcm', asciiKey, nonce)
        decipher.setAuthTag(authTag)
        decryptedCandidates.push(
          Buffer.concat([decipher.update(buffer.subarray(0, buffer.length - 28)), decipher.final()])
        )
      } catch {
        // Older sticker payloads use different AES layouts; try them below.
      }
    }

    const ecbKeys: Buffer[] = []
    if (/^[a-f0-9]{32}$/i.test(aesKey)) ecbKeys.push(Buffer.from(aesKey, 'hex'))
    if (asciiKey.length === 16 || asciiKey.length === 32) ecbKeys.push(asciiKey)
    for (const key of ecbKeys) {
      try {
        const decipher = crypto.createDecipheriv(
          key.length === 32 ? 'aes-256-ecb' : 'aes-128-ecb',
          key,
          null
        )
        decryptedCandidates.push(Buffer.concat([decipher.update(buffer), decipher.final()]))
      } catch {
        // Continue with the next known layout.
      }
    }

    for (const decrypted of decryptedCandidates) {
      const normalized = this.normalizeDecodedBuffer(decrypted)
      if (normalized) return normalized
    }
    return null
  }

  private normalizeDecodedBuffer(buffer: Buffer): { buffer: Buffer; ext: string } | null {
    const directExt = this.detectExtension(buffer)
    if (directExt) return { buffer, ext: directExt }
    for (const inflate of [zlib.inflateSync, zlib.inflateRawSync, zlib.gunzipSync]) {
      try {
        const inflated = inflate(buffer)
        const ext = this.detectExtension(inflated)
        if (ext) return { buffer: inflated, ext }
      } catch {
        // Some encrypted sticker variants are not compressed.
      }
    }
    return null
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

  private uniq(values: Array<string | undefined>): string[] {
    return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)))
  }
}
