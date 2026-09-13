import { app } from 'electron'
import { execFile } from 'child_process'
import fs from 'fs-extra'
import path from 'path'
import { promisify } from 'util'
import { isValidDatabaseKey } from './database-key-store'
import crypto from 'crypto'
import { findResource } from './resource-paths'

const execFileAsync = promisify(execFile)

export interface DatabaseKeyResult {
  success: boolean
  key?: string
  error?: string
  code?: string
}

export interface ImageKeyResult {
  success: boolean
  xorKey?: number
  aesKey?: string
  verified?: boolean
  error?: string
}

export const MAC_INTEL_HELPER_RESOURCE_PATH = 'macos/mac-key-helper/mac_key_helper'

const MAC_INTEL_HELPER_ERRORS: Record<string, string> = {
  WECHAT_NOT_RUNNING: '请先启动并登录微信，然后重试',
  NO_DATABASE_SALTS: '未找到可用的数据文件，请重新选择账号目录',
  CONNECTION_TIMEOUT: '等待本地连接超时，请打开聊天窗口后重试'
}

export function parseMacKeyHelperOutput(output: string): DatabaseKeyResult {
  const payloads: Record<string, unknown>[] = []
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const payload = JSON.parse(trimmed) as unknown
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        payloads.push(payload as Record<string, unknown>)
      }
    } catch {
      // Ignore non-JSON diagnostics written to stdout by older helpers.
    }
  }

  const payload = payloads.find(
    (item) => item.type === 'result' && item.success === true && typeof item.key === 'string'
  )
  const rawKey = typeof payload?.key === 'string' ? payload.key.trim().replace(/^0x/i, '') : ''
  if (!isValidDatabaseKey(rawKey)) {
    const errorPayload = payloads.find(
      (item) =>
        item.type === 'error' || typeof item.code === 'string' || typeof item.error === 'string'
    )
    const rawError = typeof errorPayload?.error === 'string' ? errorPayload.error.trim() : ''
    const code = typeof errorPayload?.code === 'string' ? errorPayload.code : undefined
    return {
      success: false,
      code,
      error:
        rawError || (code ? MAC_INTEL_HELPER_ERRORS[code] : undefined) || '连接组件未返回有效结果'
    }
  }
  return { success: true, key: rawKey }
}

export class KeyServiceMac {
  private getHelperPath(): string {
    const helperPath = findResource(MAC_INTEL_HELPER_RESOURCE_PATH)
    if (!helperPath) throw new Error('自动获取组件尚未安装')
    return helperPath
  }

  private parseHelperOutput(output: string): DatabaseKeyResult {
    return parseMacKeyHelperOutput(output)
  }

  async autoGetDbKey(
    onStatus?: (message: string) => void,
    timeoutMs = 60_000,
    accountRoot?: string
  ): Promise<DatabaseKeyResult> {
    if (process.platform !== 'darwin') {
      return { success: false, error: '自动获取密钥目前仅支持 macOS' }
    }
    try {
      const helperPath = this.getHelperPath()
      const waitMs = Math.max(30_000, timeoutMs)
      onStatus?.('正在准备连接组件...')
      const { stdout } = await execFileAsync(
        helperPath,
        ['capture', '--account-root', String(accountRoot || ''), '--timeout-ms', String(waitMs)],
        { timeout: waitMs + 20_000, maxBuffer: 2 * 1024 * 1024 }
      )
      const result = this.parseHelperOutput(String(stdout))
      onStatus?.(result.success ? '密钥获取成功' : '密钥获取失败')
      return result
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const output =
        typeof error === 'object' && error !== null && 'stdout' in error
          ? String((error as { stdout?: unknown }).stdout || '')
          : ''
      const parsed = output ? this.parseHelperOutput(output) : undefined
      return parsed?.code ? parsed : { success: false, code: 'HELPER_FAILED', error: detail }
    }
  }

  async autoGetImageKey(
    accountPath?: string,
    onStatus?: (message: string) => void,
    wxid?: string
  ): Promise<ImageKeyResult> {
    try {
      onStatus?.('正在从缓存目录扫描图片密钥...')
      const codes = this.collectKvcommCodes(accountPath)
      if (codes.length === 0) {
        return { success: false, error: '未找到有效的密钥码（kvcomm 缓存为空）' }
      }

      const wxidCandidates = this.collectWxidCandidates(accountPath, wxid)
      const accountPathCandidates = this.collectAccountPathCandidates(accountPath)

      for (const candidateAccountPath of accountPathCandidates) {
        if (!fs.existsSync(candidateAccountPath)) continue
        const template = this.findTemplateData(candidateAccountPath, 32)
        if (!template.ciphertext) continue

        const orderedWxids: string[] = []
        this.pushAccountIdCandidates(orderedWxids, path.basename(candidateAccountPath))
        for (const candidate of wxidCandidates)
          this.pushAccountIdCandidates(orderedWxids, candidate)

        onStatus?.(`正在校验候选 wxid（${orderedWxids.length} 个）...`)
        for (const candidateWxid of orderedWxids) {
          for (const code of codes) {
            const { xorKey, aesKey } = this.deriveImageKeys(code, candidateWxid)
            if (!this.verifyDerivedAesKey(aesKey, template.ciphertext)) continue
            onStatus?.(`图片密钥获取成功 (wxid: ${candidateWxid})`)
            return { success: true, xorKey, aesKey, verified: true }
          }
        }
      }

      const fallbackWxid = wxidCandidates[0]
      const fallbackCode = codes[0]
      const { xorKey, aesKey } = this.deriveImageKeys(fallbackCode, fallbackWxid)
      onStatus?.(`图片密钥已计算 (wxid: ${fallbackWxid})`)
      return { success: true, xorKey, aesKey, verified: false }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  private collectKvcommCodes(accountPath?: string): number[] {
    const codeSet = new Set<number>()
    const pattern = /^key_(\d+)_.+\.statistic$/i
    for (const kvcommDir of this.getKvcommCandidates(accountPath)) {
      if (!fs.existsSync(kvcommDir)) continue
      try {
        for (const file of fs.readdirSync(kvcommDir)) {
          const match = file.match(pattern)
          if (!match) continue
          const code = Number(match[1])
          if (Number.isFinite(code) && code > 0 && code <= 0xffffffff) codeSet.add(code)
        }
      } catch {
        // Try the next candidate.
      }
    }
    return Array.from(codeSet)
  }

  private getKvcommCandidates(accountPath?: string): string[] {
    const home = app.getPath('home')
    const candidates = new Set<string>([
      path.join(
        home,
        'Library/Containers/com.tencent.xinWeChat/Data/Documents/app_data/net/kvcomm'
      ),
      path.join(
        home,
        'Library/Containers/com.tencent.xinWeChat/Data/Library/Application Support/com.tencent.xinWeChat/xwechat/net/kvcomm'
      ),
      path.join(
        home,
        'Library/Containers/com.tencent.xinWeChat/Data/Library/Application Support/com.tencent.xinWeChat/net/kvcomm'
      ),
      path.join(home, 'Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat/net/kvcomm')
    ])

    const normalized = String(accountPath || '')
      .replace(/\\/g, '/')
      .replace(/\/+$/, '')
    const marker = '/xwechat_files'
    const markerIndex = normalized.indexOf(marker)
    if (markerIndex >= 0) {
      candidates.add(`${normalized.slice(0, markerIndex)}/app_data/net/kvcomm`)
    }

    const newPathMatch = normalized.match(
      /^(.*\/com\.tencent\.xinWeChat\/(?:\d+\.\d+b\d+\.\d+|\d+\.\d+\.\d+))/
    )
    if (newPathMatch) {
      candidates.add(`${newPathMatch[1]}/net/kvcomm`)
      candidates.add(`${newPathMatch[1]}/xwechat/net/kvcomm`)
    }

    return Array.from(candidates)
  }

  private collectWxidCandidates(accountPath?: string, wxidParam?: string): string[] {
    const candidates: string[] = []
    this.pushAccountIdCandidates(candidates, wxidParam)

    const normalized = String(accountPath || '')
      .replace(/\\/g, '/')
      .replace(/\/+$/, '')
    if (normalized) {
      this.pushAccountIdCandidates(candidates, path.basename(normalized))
      const root = this.resolveXwechatRootFromPath(normalized)
      if (root && fs.existsSync(root)) {
        try {
          for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue
            const entryPath = path.join(root, entry.name)
            if (this.isAccountDirPath(entryPath))
              this.pushAccountIdCandidates(candidates, entry.name)
          }
        } catch {
          // Ignore unreadable directories.
        }
      }
    }

    if (candidates.length === 0) candidates.push('unknown')
    return candidates
  }

  private collectAccountPathCandidates(accountPath?: string): string[] {
    const candidates: string[] = []
    const push = (value?: string): void => {
      const normalized = String(value || '').trim()
      if (normalized && !candidates.includes(normalized)) candidates.push(normalized)
    }

    push(accountPath)
    const root = this.resolveXwechatRootFromPath(accountPath)
    if (root && fs.existsSync(root)) {
      try {
        for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue
          const entryPath = path.join(root, entry.name)
          if (this.isAccountDirPath(entryPath) && this.isReasonableAccountId(entry.name))
            push(entryPath)
        }
      } catch {
        // Ignore unreadable directories.
      }
    }
    return candidates
  }

  private resolveXwechatRootFromPath(accountPath?: string): string | null {
    const normalized = String(accountPath || '')
      .replace(/\\/g, '/')
      .replace(/\/+$/, '')
    if (!normalized) return null
    const marker = '/xwechat_files'
    const markerIndex = normalized.indexOf(marker)
    if (markerIndex >= 0) return normalized.slice(0, markerIndex + marker.length)
    const newPathMatch = normalized.match(
      /^(.*\/com\.tencent\.xinWeChat\/(?:\d+\.\d+b\d+\.\d+|\d+\.\d+\.\d+))(\/|$)/
    )
    return newPathMatch ? newPathMatch[1] : null
  }

  private isAccountDirPath(entryPath: string): boolean {
    return (
      fs.existsSync(path.join(entryPath, 'db_storage')) ||
      fs.existsSync(path.join(entryPath, 'msg')) ||
      fs.existsSync(path.join(entryPath, 'FileStorage', 'Image')) ||
      fs.existsSync(path.join(entryPath, 'FileStorage', 'Image2'))
    )
  }

  private pushAccountIdCandidates(candidates: string[], value?: string): void {
    const raw = String(value || '').trim()
    if (!this.isReasonableAccountId(raw)) return
    for (const candidate of [raw, this.normalizeAccountId(raw)]) {
      if (candidate && !candidates.includes(candidate) && this.isReasonableAccountId(candidate)) {
        candidates.push(candidate)
      }
    }
  }

  private normalizeAccountId(value: string): string {
    const trimmed = String(value || '').trim()
    if (!trimmed) return ''
    if (trimmed.toLowerCase().startsWith('wxid_')) {
      const match = trimmed.match(/^(wxid_[^_]+)/i)
      return match?.[1] || trimmed
    }
    const suffixMatch = trimmed.match(/^(.+)_([a-zA-Z0-9]{4})$/)
    return suffixMatch ? suffixMatch[1] : trimmed
  }

  private isReasonableAccountId(value: string): boolean {
    const lowered = String(value || '')
      .trim()
      .toLowerCase()
    if (!lowered || lowered.includes('/') || lowered.includes('\\')) return false
    return !['xwechat_files', 'all_users', 'backup', 'wmpf', 'app_data'].includes(lowered)
  }

  private deriveImageKeys(code: number, wxid: string): { xorKey: number; aesKey: string } {
    const xorKey = code & 0xff
    const aesKey = crypto
      .createHash('md5')
      .update(`${code}${this.normalizeAccountId(wxid)}`)
      .digest('hex')
      .substring(0, 16)
    return { xorKey, aesKey }
  }

  private findTemplateData(userDir: string, limit = 32): { ciphertext: Buffer | null } {
    const magic = Buffer.from([0x07, 0x08, 0x56, 0x32, 0x08, 0x07])
    const files: string[] = []
    const collect = (dir: string): void => {
      if (files.length >= limit) return
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (files.length >= limit) break
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) collect(full)
          else if (entry.isFile() && entry.name.endsWith('_t.dat')) files.push(full)
        }
      } catch {
        // Ignore unreadable directories.
      }
    }
    collect(userDir)
    files.sort((a, b) => {
      try {
        return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs
      } catch {
        return 0
      }
    })

    for (const file of files) {
      try {
        const data = fs.readFileSync(file)
        if (data.length >= 0x1f && data.subarray(0, 6).equals(magic)) {
          return { ciphertext: data.subarray(0x0f, 0x1f) }
        }
      } catch {
        // Try the next file.
      }
    }
    return { ciphertext: null }
  }

  private verifyDerivedAesKey(aesKey: string, ciphertext: Buffer): boolean {
    try {
      if (!aesKey || aesKey.length < 16 || ciphertext.length !== 16) return false
      const decipher = crypto.createDecipheriv(
        'aes-128-ecb',
        Buffer.from(aesKey, 'ascii').subarray(0, 16),
        null
      )
      decipher.setAutoPadding(false)
      const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()])
      if (dec[0] === 0xff && dec[1] === 0xd8 && dec[2] === 0xff) return true
      if (dec[0] === 0x89 && dec[1] === 0x50 && dec[2] === 0x4e && dec[3] === 0x47) return true
      if (dec[0] === 0x52 && dec[1] === 0x49 && dec[2] === 0x46 && dec[3] === 0x46) return true
      if (dec[0] === 0x77 && dec[1] === 0x78 && dec[2] === 0x67 && dec[3] === 0x66) return true
      if (dec[0] === 0x47 && dec[1] === 0x49 && dec[2] === 0x46) return true
      return false
    } catch {
      return false
    }
  }
}
