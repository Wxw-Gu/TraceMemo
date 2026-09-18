import { app } from 'electron'
import { execFile, spawn } from 'child_process'
import fs from 'fs-extra'
import path from 'path'
import { promisify } from 'util'
import { isValidDatabaseKey } from './database-key-store'
import crypto from 'crypto'
import { findResource, getResourceCandidates } from './resource-paths'
import { detectWechatVersion } from './services/connection-diagnostics'

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

export type XkeyHelperMode = 'legacy' | 'wechat-4.1.13'

export function resolveXkeyHelperMode(wechatVersion: string): XkeyHelperMode {
  return /^4\.1\.13(?:\.|$)/.test(wechatVersion.trim()) ? 'wechat-4.1.13' : 'legacy'
}

export function buildXkeyHelperArguments(pid: number, timeoutMs: number): string[] {
  return [String(pid), String(timeoutMs), '--profile', 'wechat-4.1.13', '--account']
}

export function buildAppleSiliconXkeyInvocation(
  wechatVersion: string,
  pid: number,
  timeoutMs: number
): {
  mode: XkeyHelperMode
  resourceName: string
  args: string[]
  waitMs: number
  timeoutSeconds: number
  execTimeoutMs: number
} {
  const mode = resolveXkeyHelperMode(wechatVersion)
  const isWechat413 = mode === 'wechat-4.1.13'
  const waitMs = Math.max(isWechat413 ? 120_000 : 30_000, timeoutMs)
  const timeoutSeconds = Math.ceil(waitMs / 1000) + (isWechat413 ? 10 : 30)
  return {
    mode,
    resourceName: isWechat413 ? 'xkey_helper_4_1_13' : 'xkey_helper',
    args: isWechat413 ? buildXkeyHelperArguments(pid, waitMs) : [String(pid), String(waitMs)],
    waitMs,
    timeoutSeconds,
    execTimeoutMs: isWechat413 ? timeoutSeconds * 1000 + 5_000 : waitMs + 20_000
  }
}

export function mapXkeyHelperFailure(
  rawError: string,
  fallbackCode = 'HELPER_RESULT_INVALID'
): DatabaseKeyResult {
  const normalizedError = rawError.trim().toLowerCase()
  const parsedError = rawError.match(/(?:^|[\s"])(?:\\?"?)ERROR:([^:\s"}]+):?([^"}\r\n]*)/i)
  const code = parsedError?.[1]?.toUpperCase()
  const detail = parsedError?.[2]?.trim() || ''

  if (
    code === 'CAPTURE_TIMEOUT' ||
    normalizedError.includes('timeout waiting for breakpoint hit') ||
    normalizedError.includes('timeout waiting for sink hit') ||
    normalizedError.includes('no_breakpoint_hit')
  ) {
    return {
      success: false,
      code: 'CAPTURE_TIMEOUT',
      error:
        '已完成管理员授权，但监听期间微信没有触发账号密钥派生。请先停留在微信登录界面，在 TraceMemo 点击“自动获取密钥”，授权后点击微信“登录”；已有登录凭据时通常不需要扫码。'
    }
  }
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
      error: '内存扫描失败：当前微信版本或运行状态暂未适配。'
    }
  }
  if (normalizedError.includes('permission denied') || code === 'PERMISSION_DENIED') {
    return {
      success: false,
      code: code || 'PERMISSION_DENIED',
      error: '管理员授权不足，无法读取微信进程内存。'
    }
  }
  return {
    success: false,
    code: code || fallbackCode,
    error: code
      ? `密钥工具执行未完成（${code}），请确认微信仍在运行后重试。`
      : '密钥工具未返回有效密钥，请确认微信仍在运行后重试。'
  }
}

export function parseXkeyHelperOutput(output: string): DatabaseKeyResult {
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
  if (isValidDatabaseKey(rawKey)) return { success: true, key: rawKey }

  const errorPayload = payloads.find((item) => typeof item.result === 'string')
  const rawError = typeof errorPayload?.result === 'string' ? errorPayload.result.trim() : ''
  return mapXkeyHelperFailure(rawError)
}

export const SIP_ENABLED_ERROR =
  'macOS 系统完整性保护（SIP）已开启，无法自动获取数据库密钥。请先关闭 SIP，或改用手动粘贴。'

export function parseSipEnabled(statusOutput: string): boolean {
  const status = statusOutput.match(/status:\s*([a-z]+)/i)?.[1]?.toLowerCase()
  if (status) return status === 'enabled'
  return statusOutput.toLowerCase().includes('enabled')
}

export class KeyServiceMac {
  private getMacKeyRuntimeDir(): string {
    return path.join(app.getPath('userData'), 'key-runtime')
  }

  private async runMacKeyTool(
    args: string[],
    timeoutMs: number,
    onStatus?: (message: string) => void
  ): Promise<Record<string, unknown>> {
    const helperPath = findResource('macos-key-tool/intel_mac_key_helper')
    if (!helperPath) {
      return {
        type: 'result',
        success: false,
        code: 'KEY_TOOL_UNAVAILABLE',
        error: '缺少 Intel Mac 工具'
      }
    }

    return await new Promise<Record<string, unknown>>((resolve) => {
      const child = spawn(helperPath, args, {
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let settled = false
      let pending = ''
      let lastError = ''
      let finalPayload: Record<string, unknown> | null = null
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (payload: Record<string, unknown>): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolve(payload)
      }
      const consume = (chunk: Buffer): void => {
        pending += chunk.toString()
        const lines = pending.split(/\r?\n/)
        pending = lines.pop() || ''
        for (const line of lines) {
          try {
            const payload = JSON.parse(line) as Record<string, unknown>
            if (payload.type === 'progress' && typeof payload.message === 'string') {
              onStatus?.(payload.message)
            }
            if (payload.type === 'result' || payload.type === 'status') finalPayload = payload
          } catch {
            // The helper contract is JSONL; ignore interpreter diagnostics.
          }
        }
      }
      child.stdout.on('data', consume)
      child.stderr.on('data', (chunk: Buffer) => {
        lastError = `${lastError}\n${chunk.toString()}`.trim().slice(-1000)
      })
      child.on('error', (error) =>
        finish({
          type: 'result',
          success: false,
          code: 'KEY_TOOL_FAILED',
          error: `无法启动 Intel Mac 密钥工具：${error.message}`
        })
      )
      child.on('close', () => {
        if (pending) consume(Buffer.from('\n'))
        finish(
          finalPayload || {
            type: 'result',
            success: false,
            code: 'KEY_TOOL_FAILED',
            error: lastError || 'Intel Mac 密钥工具未返回结果'
          }
        )
      })
      timer = setTimeout(() => {
        try {
          child.kill('SIGTERM')
        } catch {
          // The child may already have exited.
        }
        finish({
          type: 'result',
          success: false,
          code: 'KEY_TOOL_TIMEOUT',
          error: 'Intel Mac 密钥获取超时，请让微信回到未登录界面后重试'
        })
      }, timeoutMs)
    })
  }

  async getIntelEnvironmentStatus(): Promise<{
    sipDisabled: boolean
    pythonAvailable: boolean
    fridaAvailable: boolean
    wechatAdhocSigned: boolean
  }> {
    const payload = await this.runMacKeyTool(
      ['status', '--runtime-dir', this.getMacKeyRuntimeDir()],
      15_000
    )
    return {
      sipDisabled: payload.sipDisabled === true,
      pythonAvailable: payload.pythonAvailable === true,
      fridaAvailable: payload.fridaAvailable === true,
      wechatAdhocSigned: payload.wechatAdhocSigned === true
    }
  }

  async installIntelKeyRuntime(
    onStatus?: (message: string) => void
  ): Promise<{ success: boolean; error?: string; code?: string }> {
    if (process.platform !== 'darwin' || process.arch !== 'x64') {
      return { success: false, code: 'UNSUPPORTED_PLATFORM', error: '仅 Intel Mac 需要安装此运行环境' }
    }
    onStatus?.('正在准备连接环境，请保持网络连接…')
    const payload = await this.runMacKeyTool(
      ['install', this.getMacKeyRuntimeDir()],
      5 * 60_000,
      onStatus
    )
    return {
      success: payload.success === true,
      code: typeof payload.code === 'string' ? payload.code : undefined,
      error: typeof payload.error === 'string' ? payload.error : undefined
    }
  }

  private async captureIntelDbKey(
    accountRoot: string | undefined,
    timeoutMs: number,
    onStatus?: (message: string) => void
  ): Promise<DatabaseKeyResult> {
    const selectedRoot = String(accountRoot || '').trim()
    if (!selectedRoot) return { success: false, code: 'ACCOUNT_REQUIRED', error: '请先选择微信账号' }
    const waitMs = Math.max(30_000, timeoutMs)
    const payload = await this.runMacKeyTool(
      [
        'capture',
        '--account-root',
        selectedRoot,
        '--runtime-dir',
        this.getMacKeyRuntimeDir(),
        '--diagnostic-log',
        path.join(app.getPath('logs'), 'mac-key-diagnostic.log'),
        '--timeout-ms',
        String(waitMs)
      ],
      waitMs + 15_000,
      onStatus
    )
    const key = typeof payload.key === 'string' ? payload.key.trim().toLowerCase() : ''
    if (payload.success === true && isValidDatabaseKey(key)) return { success: true, key }
    return {
      success: false,
      code: typeof payload.code === 'string' ? payload.code : 'KEY_TOOL_FAILED',
      error: typeof payload.error === 'string' ? payload.error : '未捕获到微信数据库密钥'
    }
  }

  private getHelperPath(resourceName = 'xkey_helper'): string {
    const helperPath = findResource(resourceName)
    if (!helperPath) {
      throw new Error(
        `找不到 ${resourceName}（已检查：${getResourceCandidates(resourceName).join('；')}）`
      )
    }
    return helperPath
  }

  private async isSipEnabled(): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('/usr/bin/csrutil', ['status'])
      return parseSipEnabled(stdout)
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
    throw new Error('未找到微信主进程，请先启动微信并停留在登录界面')
  }

  async autoGetDbKey(
    onStatus?: (message: string) => void,
    timeoutMs = 60_000,
    accountRoot?: string
  ): Promise<DatabaseKeyResult> {
    if (onStatus) {
      const emitStatus = onStatus
      onStatus = (message: string): void =>
        emitStatus(message.replace(/Frida/gi, '连接组件'))
    }
    if (process.platform !== 'darwin') {
      return { success: false, error: '自动获取密钥目前仅支持 macOS' }
    }
    if (await this.isSipEnabled()) {
      return { success: false, code: 'SIP_ENABLED', error: SIP_ENABLED_ERROR }
    }

    try {
      if (process.arch === 'x64') {
        onStatus?.('Intel Mac 将通过 Frida 获取微信主密钥，请让微信停留在未登录界面')
        const result = await this.captureIntelDbKey(accountRoot, timeoutMs, onStatus)
        onStatus?.(result.success ? '密钥获取成功' : '密钥获取失败')
        return result
      }
      const wechatVersion = await detectWechatVersion()
      onStatus?.('正在查找微信进程...')
      const pid = await this.getWeChatPid()
      const invocation = buildAppleSiliconXkeyInvocation(wechatVersion, pid, timeoutMs)
      const isWechat413 = invocation.mode === 'wechat-4.1.13'
      const helperPath = this.getHelperPath(invocation.resourceName)
      onStatus?.('正在请求管理员授权...')
      const scriptLines = [
        `set helperPath to ${JSON.stringify(helperPath)}`,
        `set cmd to quoted form of helperPath & " ${invocation.args.join(' ')}"`,
        `set timeoutSec to ${invocation.timeoutSeconds}`,
        'try',
        'with timeout of timeoutSec seconds',
        'set outText to do shell script cmd with administrator privileges',
        'end timeout',
        'return "OK::" & outText',
        'on error errMsg number errNum',
        'return "ERR::" & errNum & "::" & errMsg',
        'end try'
      ]
      onStatus?.(
        isWechat413
          ? '授权后请在微信登录界面点击“登录”，已有登录凭据时通常不需要扫码'
          : '授权后 需要在微信登录界面 点击登录微信'
      )
      const { stdout } = await execFileAsync(
        '/usr/bin/osascript',
        scriptLines.flatMap((line) => ['-e', line]),
        { timeout: invocation.execTimeoutMs }
      )
      const output = String(stdout).trim()
      if (output.startsWith('ERR::-128')) {
        return { success: false, error: '已取消管理员授权' }
      }
      if (output.startsWith('ERR::')) {
        const [, errorNumber = 'UNKNOWN', ...errorParts] = output.split('::')
        const result = mapXkeyHelperFailure(errorParts.join('::'), `OSASCRIPT_${errorNumber}`)
        onStatus?.('密钥获取失败')
        return result
      }
      const result = parseXkeyHelperOutput(output.startsWith('OK::') ? output.slice(4) : output)
      onStatus?.(result.success ? '密钥获取成功' : '密钥获取失败')
      return result
    } catch (error) {
      const processError = error as NodeJS.ErrnoException & {
        killed?: boolean
        signal?: NodeJS.Signals | null
      }
      if (processError.message?.includes('未找到微信主进程')) {
        return {
          success: false,
          code: 'WECHAT_NOT_RUNNING',
          error: '未找到微信主进程，请先启动微信并停留在登录界面。'
        }
      }
      if (
        processError.killed ||
        processError.code === 'ETIMEDOUT' ||
        processError.signal === 'SIGTERM'
      ) {
        return {
          success: false,
          code: 'AUTH_TIMEOUT',
          error: '管理员授权等待超时，请点击“自动获取密钥”后及时完成系统授权。'
        }
      }
      return {
        success: false,
        code: typeof processError.code === 'string' ? processError.code : 'HELPER_EXEC_FAILED',
        error: '密钥工具执行失败，请确认微信仍在运行后重试。'
      }
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
