import { basename, dirname, extname, join } from 'path'
import { existsSync, readFileSync, statSync, readdirSync } from 'fs'
import crypto from 'crypto'
import os from 'os'
import { Wcdb4Client } from './wcdb4-client'

const imageDecryptDebugEnabled = process.env['WECHATEXPLORER_DEBUG_IMAGE'] === '1'
const imageDecryptLog = (...args: unknown[]): void => {
  if (imageDecryptDebugEnabled) console.log(...args)
}

export class ImageDecryptService {
  private xorKey: number = 0
  private aesKey: string = ''
  private wcdb4Client: Wcdb4Client | null = null

  constructor(xorKey: string, aesKey: string, wcdb4Client?: Wcdb4Client | null) {
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
  }

  /**
   * 获取账号目录
   */
  private getAccountDir(): string | null {
    const wcdbAccountRoot = this.wcdb4Client?.getAccountRoot()
    if (wcdbAccountRoot && existsSync(wcdbAccountRoot)) {
      return wcdbAccountRoot
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
    return join(accountRoot, accounts[0].name)
  }

  /**
   * 根据 md5 查找图片文件 (WechatExplorer 风格)
   */
  findImageFile(
    md5?: string,
    imageDatName?: string,
    options?: { allowThumbnail?: boolean; accountDir?: string }
  ): string | null {
    // 测试场景下可显式指定根目录；不传则维持原 getAccountDir() 行为
    const accountDir =
      options?.accountDir && existsSync(options.accountDir) ? options.accountDir : this.getAccountDir()
    if (!accountDir) return null
    const allowThumbnail = options?.allowThumbnail !== false

    const normalizedMd5 = this.normalizeDatBase(md5 || '')
    const normalizedDatName = this.normalizeDatBase(imageDatName || '')
    imageDecryptLog('[ImageDecrypt] findImageFile:', {
      md5: normalizedMd5,
      imageDatName: normalizedDatName,
      accountDir,
      allowThumbnail
    })

    for (const key of this.uniq([normalizedMd5, normalizedDatName])) {
      const hardlink = this.wcdb4Client?.resolveImageHardlink(key)
      const fullPath = typeof hardlink?.full_path === 'string' ? hardlink.full_path : ''
      if (fullPath && existsSync(fullPath)) {
        const selected = this.getPreferredDatVariantPath(fullPath, allowThumbnail)
        if (allowThumbnail || !this.isThumbnailName(basename(selected))) {
          imageDecryptLog('[ImageDecrypt] hardlink hit:', selected)
          return selected
        }
      }
    }

    // 尝试 WechatExplorer 的目录结构: msg/attach/{hash}/{YYYY-MM}/Img/
    const attachDir = join(accountDir, 'msg', 'attach')
    if (!existsSync(attachDir)) {
      imageDecryptLog('[ImageDecrypt] attach dir not found:', attachDir)
      return this.findImageFileInLegacyDirs(accountDir, normalizedMd5 || normalizedDatName)
    }

    const searchKeys = this.uniq([normalizedMd5, normalizedDatName])
    if (searchKeys.length === 0) return null

    for (const key of searchKeys) {
      const directHit = this.fastProbabilisticSearch(attachDir, key, allowThumbnail)
      if (directHit) return directHit
    }

    const legacyHit = this.findImageFileInLegacyDirs(accountDir, searchKeys[0], allowThumbnail)
    if (legacyHit) return legacyHit

    imageDecryptLog('[ImageDecrypt] findImageFile miss for:', searchKeys)
    return null
  }

  private fastProbabilisticSearch(
    attachDir: string,
    datName: string,
    allowThumbnail = true
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
        const found = this.getLargestExistingPath(candidates, allowThumbnail)
        if (found) {
          imageDecryptLog('[ImageDecrypt] prefix path hit:', found)
          return found
        }
      }
    }

    try {
      const sessionDirs = readdirSync(attachDir).filter(
        (name) => name.length === 32 && /^[a-f0-9]+$/i.test(name)
      )

      const now = new Date()
      const months: string[] = []
      for (let i = 0; i < 24; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
        months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
      }

      for (const sessDir of sessionDirs) {
        for (const month of months) {
          for (const sub of ['Img', 'Image', 'image']) {
            const imgDir = join(attachDir, sessDir, month, sub)
            if (!existsSync(imgDir)) continue

            const found = this.getLargestExistingPath(
              variants.map((variant) => join(imgDir, variant)),
              allowThumbnail
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
    allowThumbnail = true
  ): string | null {
    const normalized = this.normalizeDatBase(datName)
    if (!normalized) return null

    const roots = [
      join(accountDir, 'FileStorage', 'Image'),
      join(accountDir, 'FileStorage', 'Image2'),
      join(accountDir, 'FileStorage', 'MsgImg')
    ].filter((root) => existsSync(root))

    for (const root of roots) {
      const found = this.recursiveFindDat(root, normalized, 5, allowThumbnail)
      if (found) return found
    }

    return null
  }

  private recursiveFindDat(
    dir: string,
    datName: string,
    depth: number,
    allowThumbnail = true
  ): string | null {
    if (depth < 0) return null

    try {
      const variants = new Set(
        this.buildPreferredDatNames(datName).filter(
          (name) => allowThumbnail || !this.isThumbnailName(name)
        )
      )
      const entries = readdirSync(dir)
      for (const entry of entries) {
        const fullPath = join(dir, entry)
        const stat = statSync(fullPath)
        if (stat.isFile() && variants.has(entry.toLowerCase())) {
          imageDecryptLog('[ImageDecrypt] legacy path hit:', fullPath)
          return fullPath
        }
      }

      for (const entry of entries) {
        const fullPath = join(dir, entry)
        if (!statSync(fullPath).isDirectory()) continue
        const found = this.recursiveFindDat(fullPath, datName, depth - 1, allowThumbnail)
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
      return null
    }

    try {
      const version = this.getDatVersion(datPath)
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
          return null
        }
        const key = Buffer.from(this.aesKey, 'ascii').slice(0, 16)
        decrypted = this.decryptDatV4(datPath, key)
      } else {
        // 仅支持 WeChat 4.0：版本不匹配直接返回 null，不做 V3/老版本兜底。
        imageDecryptLog('[ImageDecrypt] unsupported dat version (WeChat 4.0 only):', version)
        return null
      }

      return decrypted
    } catch (error) {
      imageDecryptLog('[ImageDecrypt] decrypt error:', error)
      return null
    }
  }

  /**
   * 将解密后的图片转换为 base64
   */
  decryptImageToBase64(datPath: string): string | null {
    if (!extname(datPath).toLowerCase().includes('dat')) {
      const data = readFileSync(datPath)
      const ext = this.detectImageExtension(data) || extname(datPath).toLowerCase()
      const mimeType = this.getMimeType(ext)
      return `data:${mimeType};base64,${data.toString('base64')}`
    }

    const decrypted = this.decryptImage(datPath)
    if (!decrypted) return null

    const unwrapped = this.unwrapWxgf(decrypted)
    const ext = this.detectImageExtension(unwrapped)
    if (!ext) {
      imageDecryptLog('[ImageDecrypt] unknown image format')
      return null
    }

    const mimeType = this.getMimeType(ext)
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
    return withoutDat.replace(/(_thumb|\.thumb|_hd|\.hd|_h|\.h|_t|\.t|_c|\.c)$/i, '').toLowerCase()
  }

  private buildPreferredDatNames(baseName: string): string[] {
    const base = this.normalizeDatBase(baseName)
    if (!base) return []
    return [
      `${base}.dat`,
      `${base}_hd.dat`,
      `${base}_h.dat`,
      `${base}_b.dat`,
      `${base}_w.dat`,
      `${base}_c.dat`,
      `${base}_t.dat`,
      `${base}.thumb.dat`,
      `${base}_thumb.dat`
    ]
  }

  private getPreferredDatVariantPath(inputPath: string, allowThumbnail: boolean): string {
    const actualDir = dirname(inputPath)
    const base = this.normalizeDatBase(basename(inputPath))
    const variants = this.buildPreferredDatNames(base)
    const ordered = allowThumbnail
      ? variants
      : variants.filter((name) => !this.isThumbnailName(name))
    const largest = this.getLargestExistingPath(
      ordered.map((variant) => join(actualDir, variant)),
      allowThumbnail
    )
    if (largest) return largest
    return inputPath
  }

  private getLargestExistingPath(paths: string[], allowThumbnail: boolean): string | null {
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

    const nonThumb = toSized(
      paths.filter((candidate) => !this.isThumbnailName(basename(candidate)))
    )
    if (nonThumb[0]) return nonThumb[0].candidate
    if (!allowThumbnail) return null

    const existing = toSized(paths)
    return existing[0]?.candidate || null
  }

  private isThumbnailName(fileName: string): boolean {
    const lower = fileName.toLowerCase()
    return lower.includes('_t.dat') || lower.includes('_thumb.dat') || lower.includes('.thumb.dat')
  }

  isThumbnailFile(filePath: string): boolean {
    return this.isThumbnailName(basename(filePath))
  }

  private unwrapWxgf(buffer: Buffer): Buffer {
    if (
      buffer.length < 20 ||
      buffer[0] !== 0x77 ||
      buffer[1] !== 0x78 ||
      buffer[2] !== 0x67 ||
      buffer[3] !== 0x66
    ) {
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
    if (lastByte <= 16 && lastByte > 0) {
      const paddingLength = lastByte
      let valid = true
      for (let i = buffer.length - paddingLength; i < buffer.length; i++) {
        if (buffer[i] !== lastByte) {
          valid = false
          break
        }
      }
      if (valid) {
        return buffer.subarray(0, buffer.length - paddingLength)
      }
    }
    return buffer
  }
}
