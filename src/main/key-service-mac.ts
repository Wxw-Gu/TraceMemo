import { app } from 'electron'
import { execFile } from 'child_process'
import fs from 'fs-extra'
import path from 'path'
import { promisify } from 'util'
import { isValidDatabaseKey } from './database-key-store'
import crypto from 'crypto'
import { findResource, getResourceCandidates } from './resource-paths'

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

export class KeyServiceMac {
  private getHelperPath(): string {
    const helperPath = findResource('xkey_helper')
    if (!helperPath) {
      throw new Error(
        `找不到 xkey_helper（已检查：${getResourceCandidates('xkey_helper').join('；')}）`
      )
    }
    return helperPath
  }

  private async isSipEnabled(): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('/usr/bin/csrutil', ['status'])
      return stdout.toLowerCase().includes('enabled')
    } catch {
      return false
    }
  }

  private async getWeChatPid(): Promise<number> {
    const commands: [string, string[]][] = [
      ['/usr/bin/pgrep', ['-x', 'WeChat']],
      ['/usr/bin/pgrep', ['-f', 'WeChat.app/Contents/MacOS/WeChat']]
    ]
    for (const [command, args] of commands) {
      try {
        const { stdout } = await execFileAsync(command, args)
        const pids = stdout
          .split(/\r?\n/)
          .map((value) => Number.parseInt(value.trim(), 10))
          .filter((value) => Number.isFinite(value) && value > 0)
        if (pids.length) return Math.max(...pids)
      } catch {
        // Try the next process lookup strategy.
      }
    }
    throw new Error('未找到微信主进程，请先启动并登录微信')
  }

  private parseHelperOutput(output: string): DatabaseKeyResult {
    const payloads: Record<string, unknown>[] = []
    for (const match of output.matchAll(/\{[^{}]*\}/g)) {
      try {
        payloads.push(JSON.parse(match[0]) as Record<string, unknown>)
      } catch {
        // Ignore helper progress that is not JSON.
      }
    }
    const payload = payloads.find((item) => item.success === true && typeof item.key === 'string')
    const rawKey = typeof payload?.key === 'string' ? payload.key.trim().replace(/^0x/i, '') : ''
    if (!isValidDatabaseKey(rawKey)) {
      const errorPayload = payloads.find((item) => typeof item.result === 'string')
      const rawError = typeof errorPayload?.result === 'string' ? errorPayload.result.trim() : ''
      const parsedError = rawError.match(/^ERROR:([^:]+):?(.*)$/i)
      const code = parsedError?.[1]?.toUpperCase()
      const detail = parsedError?.[2]?.trim() || ''
      if (code === 'SCAN_FAILED' && detail.toLowerCase().includes('sink pattern not found')) {
        return {
          success: false,
          code,
          error:
            '内存扫描失败：未匹配到目标函数特征（Sink pattern not found），当前微信版本可能暂未适配。\n' +
            '建议步骤：降级微信到 4.1.8 (点击顶部"上手教程"获取下载链接) -> 重启电脑（冷启动） -> 自动获取密钥 -> 成功后再升级微信。\n' +
            '请不要连续重试，以免触发微信安全模式或系统内存保护。'
        }
      }
      if (code === 'SCAN_FAILED') {
        return {
          success: false,
          code,
          error: `内存扫描失败：${detail || '未匹配到可用特征，当前微信版本可能暂未适配。'}`
        }
      }
      return {
        success: false,
        code,
        error: rawError || '密钥工具未返回有效的 64 位密钥'
      }
    }
    return { success: true, key: rawKey }
  }

  async autoGetDbKey(
    onStatus?: (message: string) => void,
    timeoutMs = 60_000
  ): Promise<DatabaseKeyResult> {
    if (process.platform !== 'darwin') {
      return { success: false, error: '自动获取密钥目前仅支持 macOS' }
    }
    if (await this.isSipEnabled()) {
      return {
        success: false,
        error: 'macOS 系统完整性保护（SIP）已开启，自动获取不可用，请使用手动粘贴。'
      }
    }

    try {
      onStatus?.('正在查找微信进程...')
      const pid = await this.getWeChatPid()
      const helperPath = this.getHelperPath()
      const waitMs = Math.max(30_000, timeoutMs)
      const timeoutSeconds = Math.ceil(waitMs / 1000) + 30
      onStatus?.('正在请求管理员授权...')
      const scriptLines = [
        `set helperPath to ${JSON.stringify(helperPath)}`,
        `set cmd to quoted form of helperPath & " ${pid} ${waitMs}"`,
        `set timeoutSec to ${timeoutSeconds}`,
        'try',
        'with timeout of timeoutSec seconds',
        'set outText to do shell script cmd with administrator privileges',
        'end timeout',
        'return "OK::" & outText',
        'on error errMsg number errNum',
        'return "ERR::" & errNum & "::" & errMsg',
        'end try'
      ]
      onStatus?.('授权后 需要在微信登录界面 点击登录微信')
      const { stdout } = await execFileAsync(
        '/usr/bin/osascript',
        scriptLines.flatMap((line) => ['-e', line]),
        { timeout: waitMs + 20_000 }
      )
      const output = String(stdout).trim()
      if (output.startsWith('ERR::-128')) return { success: false, error: '已取消管理员授权' }
      if (output.startsWith('ERR::')) {
        return {
          success: false,
          error: output.split('::').slice(2).join('::') || '密钥工具执行失败'
        }
      }
      const result = this.parseHelperOutput(output.startsWith('OK::') ? output.slice(4) : output)
      onStatus?.(result.success ? '密钥获取成功' : '密钥获取失败')
      return result
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
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
