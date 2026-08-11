import { join, dirname, delimiter } from 'path'
import { existsSync, copyFileSync, mkdirSync } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import os from 'os'
import crypto from 'crypto'
import { getResourceRoots as getSharedResourceRoots } from './resource-paths'

const execFileAsync = promisify(execFile)

type DbKeyResult = { success: boolean; key?: string; error?: string; logs?: string[] }
type ImageKeyResult = {
  success: boolean
  xorKey?: number
  aesKey?: string
  verified?: boolean
  error?: string
}
type DbKeyPollResult =
  | { status: 'success'; key: string; loginRequiredDetected: boolean }
  | { status: 'process-ended'; loginRequiredDetected: boolean }
  | { status: 'timeout'; loginRequiredDetected: boolean }

export class KeyService {
  private koffi: any = null
  private lib: any = null
  private initialized = false
  private initHook: any = null
  private pollKeyData: any = null
  private getStatusMessage: any = null
  private cleanupHook: any = null
  private getLastErrorMsg: any = null
  private lastLoadError = ''

  // Win32 APIs
  private kernel32: any = null
  private user32: any = null

  // Kernel32
  private OpenProcess: any = null
  private CloseHandle: any = null

  // User32
  private EnumWindows: any = null
  private GetWindowTextW: any = null
  private GetWindowTextLengthW: any = null
  private GetClassNameW: any = null
  private GetWindowThreadProcessId: any = null
  private IsWindowVisible: any = null
  private EnumChildWindows: any = null
  private WNDENUMPROC_PTR: any = null

  // Constants
  private readonly DB_KEY_PROCESS_CHECK_INTERVAL_MS = 1000

  private getResourceRoots(): string[] {
    return getSharedResourceRoots()
  }

  private getDllPath(): string {
    const archDir = process.arch === 'arm64' ? 'arm64' : 'x64'
    const candidates: string[] = []

    if (process.env.WX_KEY_DLL_PATH) {
      candidates.push(process.env.WX_KEY_DLL_PATH)
    }

    for (const root of this.getResourceRoots()) {
      candidates.push(join(root, 'key', 'win32', archDir, 'wx_key.dll'))
      candidates.push(join(root, 'key', 'win32', 'x64', 'wx_key.dll'))
      candidates.push(join(root, 'key', 'win32', 'wx_key.dll'))
      candidates.push(join(root, 'wx_key.dll'))
    }

    for (const path of candidates) {
      if (existsSync(path)) return path
    }

    return candidates[0]
  }

  private prependDllSearchPaths(dllPath: string): void {
    if (process.platform !== 'win32') return

    const archDir = process.arch === 'arm64' ? 'arm64' : 'x64'
    const dirs = [
      dirname(dllPath),
      ...this.getResourceRoots().flatMap((root) => [
        root,
        join(root, 'runtime', 'win32'),
        join(root, 'key', 'win32', archDir),
        join(root, 'key', 'win32', 'x64')
      ])
    ].filter((dir, index, list) => dir && list.indexOf(dir) === index && existsSync(dir))

    const existing = process.env.PATH || ''
    process.env.PATH = `${dirs.join(delimiter)}${delimiter}${existing}`
    process.env.Path = process.env.PATH
  }

  private isNetworkPath(path: string): boolean {
    if (path.startsWith('\\\\')) return true
    return false
  }

  private localizeNetworkDll(originalPath: string): string {
    try {
      const tempDir = join(os.tmpdir(), 'weflow_dll_cache')
      if (!existsSync(tempDir)) {
        mkdirSync(tempDir, { recursive: true })
      }
      const localPath = join(tempDir, 'wx_key.dll')
      if (existsSync(localPath)) return localPath

      copyFileSync(originalPath, localPath)
      return localPath
    } catch (e) {
      console.error('DLL 本地化失败:', e)
      return originalPath
    }
  }

  private ensureLoaded(): boolean {
    if (this.initialized) return true

    let dllPath = ''
    try {
      this.koffi = require('koffi')
      dllPath = this.getDllPath()

      if (!existsSync(dllPath)) {
        console.error(`wx_key.dll 不存在于路径: ${dllPath}`)
        return false
      }

      if (this.isNetworkPath(dllPath)) {
        dllPath = this.localizeNetworkDll(dllPath)
      }

      this.prependDllSearchPaths(dllPath)
      this.lib = this.koffi.load(dllPath)
      this.initHook = this.lib.func('bool InitializeHook(uint32 targetPid)')
      this.pollKeyData = this.lib.func('bool PollKeyData(_Out_ char *keyBuffer, int bufferSize)')
      this.getStatusMessage = this.lib.func(
        'bool GetStatusMessage(_Out_ char *msgBuffer, int bufferSize, _Out_ int *outLevel)'
      )
      this.cleanupHook = this.lib.func('bool CleanupHook()')
      this.getLastErrorMsg = this.lib.func('const char* GetLastErrorMsg()')
      this.initialized = true
      return true
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e)
      this.lastLoadError = `wx_key.dll 加载失败\n路径: ${dllPath}\n错误: ${errorMsg}`
      console.error(`加载 wx_key.dll 失败\n  路径: ${dllPath}\n  错误: ${errorMsg}`)
      return false
    }
  }

  private ensureWin32(): boolean {
    return process.platform === 'win32'
  }

  private getLoadError(): string {
    return this.lastLoadError || 'wx_key.dll 未加载'
  }

  private ensureKernel32(): boolean {
    if (this.kernel32) return true
    try {
      this.koffi = require('koffi')
      this.kernel32 = this.koffi.load('kernel32.dll')
      this.OpenProcess = this.kernel32.func('OpenProcess', 'void*', ['uint32', 'bool', 'uint32'])
      this.CloseHandle = this.kernel32.func('CloseHandle', 'bool', ['void*'])

      return true
    } catch (e) {
      console.error('初始化 kernel32 失败:', e)
      return false
    }
  }

  private decodeUtf8(buf: Buffer): string {
    const nullIdx = buf.indexOf(0)
    return buf.toString('utf8', 0, nullIdx > -1 ? nullIdx : undefined).trim()
  }

  private ensureUser32(): boolean {
    if (this.user32) return true
    try {
      this.koffi = require('koffi')
      this.user32 = this.koffi.load('user32.dll')

      const WNDENUMPROC = this.koffi.proto('bool __stdcall (void *hWnd, intptr_t lParam)')
      this.WNDENUMPROC_PTR = this.koffi.pointer(WNDENUMPROC)

      this.EnumWindows = this.user32.func('EnumWindows', 'bool', [this.WNDENUMPROC_PTR, 'intptr_t'])
      this.EnumChildWindows = this.user32.func('EnumChildWindows', 'bool', [
        'void*',
        this.WNDENUMPROC_PTR,
        'intptr_t'
      ])
      this.GetWindowTextW = this.user32.func('GetWindowTextW', 'int', [
        'void*',
        this.koffi.out('uint16*'),
        'int'
      ])
      this.GetWindowTextLengthW = this.user32.func('GetWindowTextLengthW', 'int', ['void*'])
      this.GetClassNameW = this.user32.func('GetClassNameW', 'int', [
        'void*',
        this.koffi.out('uint16*'),
        'int'
      ])
      this.GetWindowThreadProcessId = this.user32.func('GetWindowThreadProcessId', 'uint32', [
        'void*',
        this.koffi.out('uint32*')
      ])
      this.IsWindowVisible = this.user32.func('IsWindowVisible', 'bool', ['void*'])

      return true
    } catch (e) {
      console.error('初始化 user32 失败:', e)
      return false
    }
  }

  private decodeCString(ptr: any): string {
    try {
      if (typeof ptr === 'string') return ptr
      return this.koffi.decode(ptr, 'char', -1)
    } catch {
      return ''
    }
  }

  private async findPidsByImageName(imageName: string): Promise<number[]> {
    try {
      const { stdout } = await execFileAsync('tasklist', [
        '/FI',
        `IMAGENAME eq ${imageName}`,
        '/FO',
        'CSV',
        '/NH'
      ])
      const lines = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
      const pids: number[] = []
      for (const line of lines) {
        if (line.startsWith('INFO:')) continue
        const parts = line.split('","').map((p) => p.replace(/^"|"$/g, ''))
        if (parts[0]?.toLowerCase() === imageName.toLowerCase()) {
          const pid = Number(parts[1])
          if (!Number.isNaN(pid)) pids.push(pid)
        }
      }
      return pids
    } catch (e) {
      return []
    }
  }

  private async findWeChatPids(): Promise<number[]> {
    const pids: number[] = []
    const pushUnique = (pid: number | null | undefined) => {
      if (!pid || pids.includes(pid)) return
      pids.push(pid)
    }

    for (const name of ['Weixin.exe', 'WeChat.exe']) {
      const found = await this.findPidsByImageName(name)
      found.forEach(pushUnique)
    }
    return pids
  }

  private async isWeChatPidActive(pid: number): Promise<boolean> {
    const pids = await this.findWeChatPids()
    if (pids.includes(pid)) return true

    const fallbackPid = await this.waitForWeChatWindow(250)
    return fallbackPid === pid
  }

  private async waitForWeChatPid(timeoutMs: number): Promise<number | null> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const pids = await this.findWeChatPids()
      if (pids.length > 0) return pids[0]

      const fallbackPid = await this.waitForWeChatWindow(250)
      if (fallbackPid) return fallbackPid

      await new Promise((r) => setTimeout(r, 500))
    }
    return null
  }

  private getRemainingMs(deadline: number): number {
    return Math.max(0, deadline - Date.now())
  }

  private async pollDbKeyFromHook(
    pid: number,
    deadline: number,
    logs: string[],
    onStatus?: (message: string, level: number) => void
  ): Promise<DbKeyPollResult> {
    const keyBuffer = Buffer.alloc(128)
    let loginRequiredDetected = false
    let nextProcessCheckAt = 0

    while (Date.now() < deadline) {
      const now = Date.now()
      if (now >= nextProcessCheckAt) {
        nextProcessCheckAt = now + this.DB_KEY_PROCESS_CHECK_INTERVAL_MS
        if (!(await this.isWeChatPidActive(pid))) {
          return { status: 'process-ended', loginRequiredDetected }
        }
      }

      if (this.pollKeyData(keyBuffer, keyBuffer.length)) {
        const key = this.decodeUtf8(keyBuffer)
        if (key.length === 64) {
          onStatus?.('密钥获取成功', 1)
          return { status: 'success', key, loginRequiredDetected }
        }
      }

      for (let i = 0; i < 5; i++) {
        const statusBuffer = Buffer.alloc(256)
        const levelOut = [0]
        if (!this.getStatusMessage(statusBuffer, statusBuffer.length, levelOut)) break
        const msg = this.decodeUtf8(statusBuffer)
        const level = levelOut[0] ?? 0
        if (msg) {
          logs.push(msg)
          if (this.isLoginRelatedText(msg)) {
            loginRequiredDetected = true
          }
          onStatus?.(msg, level)
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 120))
    }

    return { status: 'timeout', loginRequiredDetected }
  }

  private cleanupDbKeyHook(): void {
    try {
      this.cleanupHook()
    } catch {}
  }

  private buildInitHookError(): string {
    const error = this.getLastErrorMsg ? this.decodeCString(this.getLastErrorMsg()) : ''
    if (error) {
      if (
        error.includes('0xC0000022') ||
        error.includes('ACCESS_DENIED') ||
        error.includes('打开目标进程失败')
      ) {
        return '权限不足：无法访问微信进程。\n\n解决方法：\n1. 右键 WeFlow 图标，选择"以管理员身份运行"\n2. 关闭可能拦截的安全软件（如360、火绒等）\n3. 确保微信没有以管理员权限运行'
      }
      return error
    }

    const statusBuffer = Buffer.alloc(256)
    const levelOut = [0]
    const status =
      this.getStatusMessage && this.getStatusMessage(statusBuffer, statusBuffer.length, levelOut)
        ? this.decodeUtf8(statusBuffer)
        : ''
    return status || '初始化失败'
  }

  private async waitForNextDbKeyPid(
    deadline: number,
    onStatus?: (message: string, level: number) => void
  ): Promise<number | null> {
    while (this.getRemainingMs(deadline) > 0) {
      onStatus?.('正在查找微信进程...', 0)
      const pid = await this.waitForWeChatPid(Math.min(this.getRemainingMs(deadline), 30_000))
      if (pid) return pid
    }
    return null
  }

  private shouldRetryAfterProcessLost(deadline: number): boolean {
    return this.getRemainingMs(deadline) > 1000
  }

  private async delayBeforeRetry(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  private async waitForProcessRestart(
    deadline: number,
    onStatus?: (message: string, level: number) => void
  ): Promise<number | null> {
    if (!this.shouldRetryAfterProcessLost(deadline)) return null
    onStatus?.('检测到微信已退出，已清理 Hook，等待重新打开微信...', 0)
    await this.delayBeforeRetry()
    return this.waitForNextDbKeyPid(deadline, onStatus)
  }

  private async detectLoginRequiredForLastPid(
    pid: number | null,
    loginRequiredDetected: boolean
  ): Promise<boolean> {
    if (loginRequiredDetected) return true
    if (!pid) return false
    if (!(await this.isWeChatPidActive(pid))) return false
    return await this.detectWeChatLoginRequired(pid)
  }

  private async findWeChatPid(): Promise<number | null> {
    const pids = await this.findWeChatPids()
    if (pids.length > 0) return pids[0]
    const fallbackPid = await this.waitForWeChatWindow(5000)
    return fallbackPid ?? null
  }

  // --- Window Detection ---

  private getWindowTitle(hWnd: any): string {
    const len = this.GetWindowTextLengthW(hWnd)
    if (len === 0) return ''
    const buf = Buffer.alloc((len + 1) * 2)
    this.GetWindowTextW(hWnd, buf, len + 1)
    return buf.toString('ucs2', 0, len * 2)
  }

  private getClassName(hWnd: any): string {
    const buf = Buffer.alloc(512)
    const len = this.GetClassNameW(hWnd, buf, 256)
    return buf.toString('ucs2', 0, len * 2)
  }

  private isWeChatWindowTitle(title: string): boolean {
    const normalized = title.trim()
    if (!normalized) return false
    const lower = normalized.toLowerCase()
    return normalized === '微信' || lower === 'wechat' || lower === 'weixin'
  }

  private async waitForWeChatWindow(timeoutMs = 25000): Promise<number | null> {
    if (!this.ensureUser32()) return null
    const startTime = Date.now()
    while (Date.now() - startTime < timeoutMs) {
      let foundPid: number | null = null

      const enumWindowsCallback = this.koffi.register((hWnd: any, _lParam: any) => {
        if (!this.IsWindowVisible(hWnd)) return true
        const title = this.getWindowTitle(hWnd)
        if (!this.isWeChatWindowTitle(title)) return true

        const pidBuf = Buffer.alloc(4)
        this.GetWindowThreadProcessId(hWnd, pidBuf)
        const pid = pidBuf.readUInt32LE(0)
        if (pid) {
          foundPid = pid
          return false
        }
        return true
      }, this.WNDENUMPROC_PTR)

      this.EnumWindows(enumWindowsCallback, 0)
      this.koffi.unregister(enumWindowsCallback)

      if (foundPid) return foundPid
      await new Promise((r) => setTimeout(r, 500))
    }
    return null
  }

  private collectChildWindowInfos(parent: any): Array<{ title: string; className: string }> {
    const children: Array<{ title: string; className: string }> = []
    const enumChildCallback = this.koffi.register((hChild: any, _lp: any) => {
      const title = this.getWindowTitle(hChild).trim()
      const className = this.getClassName(hChild).trim()
      children.push({ title, className })
      return true
    }, this.WNDENUMPROC_PTR)
    this.EnumChildWindows(parent, enumChildCallback, 0)
    this.koffi.unregister(enumChildCallback)
    return children
  }

  private hasReadyComponents(children: Array<{ title: string; className: string }>): boolean {
    if (children.length === 0) return false

    const readyTexts = ['聊天', '登录', '账号']
    const readyClassMarkers = [
      'WeChat',
      'Weixin',
      'TXGuiFoundation',
      'Qt5',
      'ChatList',
      'MainWnd',
      'BrowserWnd',
      'ListView'
    ]
    const readyChildCountThreshold = 14

    let classMatchCount = 0
    let titleMatchCount = 0
    let hasValidClassName = false

    for (const child of children) {
      const normalizedTitle = child.title.replace(/\s+/g, '')
      if (normalizedTitle) {
        if (readyTexts.some((marker) => normalizedTitle.includes(marker))) return true
        titleMatchCount += 1
      }
      const className = child.className
      if (className) {
        if (readyClassMarkers.some((marker) => className.includes(marker))) return true
        if (className.length > 5) {
          classMatchCount += 1
          hasValidClassName = true
        }
      }
    }

    if (classMatchCount >= 3 || titleMatchCount >= 2) return true
    if (children.length >= readyChildCountThreshold) return true
    if (hasValidClassName && children.length >= 5) return true
    return false
  }

  private isLoginRelatedText(value: string): boolean {
    const normalized = String(value || '')
      .replace(/\s+/g, '')
      .toLowerCase()
    if (!normalized) return false
    const keywords = [
      '登录',
      '扫码',
      '二维码',
      '请在手机上确认',
      '手机确认',
      '切换账号',
      'wechatlogin',
      'qrcode',
      'scan'
    ]
    return keywords.some((keyword) => normalized.includes(keyword))
  }

  private async detectWeChatLoginRequired(pid: number): Promise<boolean> {
    if (!this.ensureUser32()) return false
    let loginRequired = false

    const enumWindowsCallback = this.koffi.register((hWnd: any, _lParam: any) => {
      if (!this.IsWindowVisible(hWnd)) return true
      const title = this.getWindowTitle(hWnd)
      if (!this.isWeChatWindowTitle(title)) return true

      const pidBuf = Buffer.alloc(4)
      this.GetWindowThreadProcessId(hWnd, pidBuf)
      const windowPid = pidBuf.readUInt32LE(0)
      if (windowPid !== pid) return true

      if (this.isLoginRelatedText(title)) {
        loginRequired = true
        return false
      }

      const children = this.collectChildWindowInfos(hWnd)
      for (const child of children) {
        if (this.isLoginRelatedText(child.title) || this.isLoginRelatedText(child.className)) {
          loginRequired = true
          return false
        }
      }
      return true
    }, this.WNDENUMPROC_PTR)

    this.EnumWindows(enumWindowsCallback, 0)
    this.koffi.unregister(enumWindowsCallback)

    return loginRequired
  }

  private async waitForWeChatWindowComponents(pid: number, timeoutMs = 15000): Promise<boolean> {
    if (!this.ensureUser32()) return true
    const startTime = Date.now()
    while (Date.now() - startTime < timeoutMs) {
      let ready = false
      const enumWindowsCallback = this.koffi.register((hWnd: any, _lParam: any) => {
        if (!this.IsWindowVisible(hWnd)) return true
        const title = this.getWindowTitle(hWnd)
        if (!this.isWeChatWindowTitle(title)) return true

        const pidBuf = Buffer.alloc(4)
        this.GetWindowThreadProcessId(hWnd, pidBuf)
        const windowPid = pidBuf.readUInt32LE(0)
        if (windowPid !== pid) return true

        const children = this.collectChildWindowInfos(hWnd)
        if (this.hasReadyComponents(children)) {
          ready = true
          return false
        }
        return true
      }, this.WNDENUMPROC_PTR)

      this.EnumWindows(enumWindowsCallback, 0)
      this.koffi.unregister(enumWindowsCallback)

      if (ready) return true
      await new Promise((r) => setTimeout(r, 500))
    }
    return true
  }

  // --- DB Key Logic (core hook/poll flow unchanged) ---

  async autoGetDbKey(
    timeoutMs = 60_000,
    onStatus?: (message: string, level: number) => void
  ): Promise<DbKeyResult> {
    if (!this.ensureWin32()) return { success: false, error: '仅支持 Windows' }
    if (!this.ensureLoaded()) return { success: false, error: this.getLoadError() }
    if (!this.ensureKernel32()) return { success: false, error: 'Kernel32 Init Failed' }

    const logs: string[] = []
    const deadline = Date.now() + timeoutMs
    onStatus?.('正在查找微信进程...', 0)
    let pid = await this.findWeChatPid()
    if (!pid) {
      const err = '未找到微信进程，请先启动微信'
      onStatus?.(err, 2)
      return { success: false, error: err }
    }
    let lastAttemptLoginRequiredDetected = false

    while (pid && this.getRemainingMs(deadline) > 0) {
      onStatus?.(`检测到微信窗口 (PID: ${pid})，正在获取...`, 0)
      onStatus?.('正在检测微信界面组件...', 0)
      await this.waitForWeChatWindowComponents(pid, Math.min(15000, this.getRemainingMs(deadline)))

      if (!(await this.isWeChatPidActive(pid))) {
        pid = await this.waitForProcessRestart(deadline, onStatus)
        continue
      }

      const ok = this.initHook(pid)
      if (!ok) {
        if (!(await this.isWeChatPidActive(pid))) {
          this.cleanupDbKeyHook()
          pid = await this.waitForProcessRestart(deadline, onStatus)
          continue
        }
        return { success: false, error: this.buildInitHookError(), logs }
      }

      let pollResult: DbKeyPollResult
      try {
        pollResult = await this.pollDbKeyFromHook(pid, deadline, logs, onStatus)
      } finally {
        this.cleanupDbKeyHook()
      }

      lastAttemptLoginRequiredDetected = pollResult.loginRequiredDetected
      if (pollResult.status === 'success') {
        return { success: true, key: pollResult.key, logs }
      }
      if (pollResult.status === 'process-ended') {
        lastAttemptLoginRequiredDetected = false
        pid = await this.waitForProcessRestart(deadline, onStatus)
        continue
      }
      break
    }

    const loginRequired = await this.detectLoginRequiredForLastPid(
      pid,
      lastAttemptLoginRequiredDetected
    )
    if (loginRequired) {
      return {
        success: false,
        error: '微信已启动但尚未完成登录，请先在微信客户端完成登录后再重试自动获取密钥。',
        logs
      }
    }

    return { success: false, error: '获取密钥超时', logs }
  }

  async autoGetImageKey(
    manualDir?: string,
    onProgress?: (message: string) => void,
    wxidParam?: string
  ): Promise<ImageKeyResult> {
    void wxidParam
    return this.autoGetImageKeyByMemoryScan(manualDir || '', onProgress)
  }

  // --- 内存扫描备选方案（融合 Dart+Python 优点）---
  // 只扫 RW 可写区域（更快），同时支持 ASCII 和 UTF-16LE 两种密钥格式
  // 验证支持 JPEG/PNG/WEBP/WXGF/GIF 多种格式

  async autoGetImageKeyByMemoryScan(
    userDir: string,
    onProgress?: (message: string) => void
  ): Promise<ImageKeyResult> {
    if (!this.ensureWin32()) return { success: false, error: '仅支持 Windows' }

    try {
      // 1. 查找模板文件获取密文和 XOR 密钥
      onProgress?.('正在查找模板文件...')
      let result = await this._findTemplateData(userDir, 32)
      let { ciphertext, xorKey } = result
      const firstDiag = (
        this as {
          _imageTemplateDiag?: {
            userDir: string
            totalTFiles: number
            v2Count: number
            nonV2Count: number
          }
        }
      )._imageTemplateDiag

      // 如果找不到密钥，尝试扫描更多文件
      if (ciphertext && xorKey === null) {
        onProgress?.('未找到有效密钥，尝试扫描更多文件...')
        result = await this._findTemplateData(userDir, 100)
        xorKey = result.xorKey
      }

      if (!ciphertext) {
        // 用诊断信息给具体提示
        const diag =
          (
            this as {
              _imageTemplateDiag?: {
                userDir: string
                totalTFiles: number
                v2Count: number
                nonV2Count: number
              }
            }
          )._imageTemplateDiag || firstDiag
        if (!diag || diag.totalTFiles === 0) {
          return {
            success: false,
            error:
              '在账号目录下未找到任何 _t.dat 图片文件。\n' +
              `扫描路径：${diag?.userDir || userDir || '(空)'}\n` +
              '原因：微信没在本地生成缩略图。\n' +
              '请让用户在微信里打开任意聊天的图片大图（等"原图"按钮可点击），然后再试。'
          }
        }
        if (diag.v2Count === 0 && diag.nonV2Count > 0) {
          return {
            success: false,
            error:
              `找到 ${diag.totalTFiles} 个 _t.dat，但都不是 V2 头（可能图片尚未解密到本地，或微信版本不同）。\n` +
              `扫描路径：${diag.userDir}\n` +
              '请让用户在微信里打开 2-3 张不同的图片大图，等"原图"按钮可点击后再试。'
          }
        }
        return {
          success: false,
          error:
            `找到 ${diag.totalTFiles} 个 _t.dat，其中 ${diag.v2Count} 个是 V2 头，但没有长度 ≥ 0x1F 的有效模板。\n` +
            `扫描路径：${diag.userDir}\n` +
            '请在微信中查看更多图片后再试。'
        }
      }
      if (xorKey === null)
        return {
          success: false,
          error: '未能从模板文件中计算出有效的 XOR 密钥，请确保在微信中查看了多张不同的图片'
        }

      onProgress?.(`XOR 密钥: 0x${xorKey.toString(16).padStart(2, '0')}，正在查找微信进程...`)

      // 2. 找微信 PID
      const pid = await this.findWeChatPid()
      if (!pid) return { success: false, error: '微信进程未运行，请先启动微信' }

      onProgress?.(`已找到微信进程 PID=${pid}，正在扫描内存...`)

      // 3. 持续轮询内存扫描，最多 60 秒
      const deadline = Date.now() + 60_000
      let scanCount = 0
      while (Date.now() < deadline) {
        scanCount++
        onProgress?.(`第 ${scanCount} 次扫描内存，请在微信中打开图片大图...`)
        const aesKey = await this._scanMemoryForAesKey(pid, ciphertext, onProgress)
        if (aesKey) {
          onProgress?.('密钥获取成功')
          return { success: true, xorKey, aesKey }
        }
        // 等 5 秒再试
        await new Promise((r) => setTimeout(r, 5000))
      }

      return {
        success: false,
        error: '60 秒内未找到 AES 密钥。\n请确保已在微信中打开 2-3 张图片大图后再试。'
      }
    } catch (e) {
      return { success: false, error: `内存扫描失败: ${e}` }
    }
  }

  private async _findTemplateData(
    userDir: string,
    limit: number = 32
  ): Promise<{ ciphertext: Buffer | null; xorKey: number | null }> {
    const { readdirSync, readFileSync, statSync } = await import('fs')
    const { join } = await import('path')
    const V2_MAGIC = Buffer.from([0x07, 0x08, 0x56, 0x32, 0x08, 0x07])

    // 递归收集 *_t.dat 文件
    const collect = (dir: string, results: string[], maxFiles: number) => {
      if (results.length >= maxFiles) return
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (results.length >= maxFiles) break
          const full = join(dir, entry.name)
          if (entry.isDirectory()) collect(full, results, maxFiles)
          else if (entry.isFile() && entry.name.endsWith('_t.dat')) results.push(full)
        }
      } catch {
        /* 忽略无权限目录 */
      }
    }

    const files: string[] = []
    collect(userDir, files, limit)

    // 按修改时间降序
    files.sort((a, b) => {
      try {
        return statSync(b).mtimeMs - statSync(a).mtimeMs
      } catch {
        return 0
      }
    })

    let ciphertext: Buffer | null = null
    const tailCounts: Record<string, number> = {}
    let v2Count = 0
    let nonV2Count = 0

    for (const f of files.slice(0, 32)) {
      try {
        const data = readFileSync(f)
        if (data.length < 8) continue

        // 统计末尾两字节用于 XOR 密钥
        if (data.subarray(0, 6).equals(V2_MAGIC) && data.length >= 2) {
          v2Count++
          const key = `${data[data.length - 2]}_${data[data.length - 1]}`
          tailCounts[key] = (tailCounts[key] ?? 0) + 1
        } else {
          nonV2Count++
        }

        // 提取密文（取第一个有效的）
        if (!ciphertext && data.subarray(0, 6).equals(V2_MAGIC) && data.length >= 0x1f) {
          ciphertext = data.subarray(0xf, 0x1f)
        }
      } catch {
        /* 忽略 */
      }
    }

    // 计算 XOR 密钥
    let xorKey: number | null = null
    let maxCount = 0
    for (const [key, count] of Object.entries(tailCounts)) {
      if (count > maxCount) {
        maxCount = count
        const [x, y] = key.split('_').map(Number)
        const k = x ^ 0xff
        if (k === (y ^ 0xd9)) xorKey = k
      }
    }

    // 诊断信息：远程排查时让 UI 直接告诉用户搜到了什么
    const diag = {
      userDir,
      totalTFiles: files.length,
      v2Count,
      nonV2Count
    }
    ;(this as { _imageTemplateDiag?: unknown })._imageTemplateDiag = diag

    return { ciphertext, xorKey }
  }

  private async _scanMemoryForAesKey(
    pid: number,
    ciphertext: Buffer,
    onProgress?: (msg: string) => void
  ): Promise<string | null> {
    if (!this.ensureKernel32()) return null

    // 直接用已加载的 kernel32 实例，用 uintptr 传地址
    const VirtualQueryEx = this.kernel32.func('VirtualQueryEx', 'size_t', [
      'void*',
      'uintptr',
      'void*',
      'size_t'
    ])
    const ReadProcessMemory = this.kernel32.func('ReadProcessMemory', 'bool', [
      'void*',
      'uintptr',
      'void*',
      'size_t',
      this.koffi.out('size_t*')
    ])

    // RW 保护标志（只扫可写区域，速度更快）
    const RW_FLAGS = 0x04 | 0x08 | 0x40 | 0x80 // PAGE_READWRITE | PAGE_WRITECOPY | PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY
    const MEM_COMMIT = 0x1000
    const PAGE_NOACCESS = 0x01
    const PAGE_GUARD = 0x100
    const MBI_SIZE = 48 // MEMORY_BASIC_INFORMATION size on x64

    const hProcess = this.OpenProcess(0x1f0fff, false, pid)
    if (!hProcess) return null

    try {
      // 枚举 RW 内存区域
      const regions: Array<[number, number]> = []
      let addr = 0
      const mbi = Buffer.alloc(MBI_SIZE)

      while (addr < 0x7fffffffffff) {
        const ret = VirtualQueryEx(hProcess, addr, mbi, MBI_SIZE)
        if (ret === 0) break
        // MEMORY_BASIC_INFORMATION x64 布局:
        // 0:  BaseAddress (8)
        // 8:  AllocationBase (8)
        // 16: AllocationProtect (4) + 4 padding
        // 24: RegionSize (8)
        // 32: State (4)
        // 36: Protect (4)
        // 40: Type (4) + 4 padding = 48 total
        const base = Number(mbi.readBigUInt64LE(0))
        const size = Number(mbi.readBigUInt64LE(24))
        const state = mbi.readUInt32LE(32)
        const protect = mbi.readUInt32LE(36)

        if (
          state === MEM_COMMIT &&
          protect !== PAGE_NOACCESS &&
          (protect & PAGE_GUARD) === 0 &&
          (protect & RW_FLAGS) !== 0 &&
          size <= 50 * 1024 * 1024
        ) {
          regions.push([base, size])
        }
        const next = base + size
        if (next <= addr) break
        addr = next
      }

      const totalMB = regions.reduce((s, [, sz]) => s + sz, 0) / 1024 / 1024
      onProgress?.(`扫描 ${regions.length} 个 RW 区域 (${totalMB.toFixed(0)} MB)...`)

      const CHUNK = 4 * 1024 * 1024
      const OVERLAP = 65

      for (let i = 0; i < regions.length; i++) {
        const [base, size] = regions[i]
        if (i % 20 === 0) {
          onProgress?.(`扫描进度 ${i}/${regions.length}...`)
          await new Promise((r) => setTimeout(r, 1)) // 让出事件循环
        }

        let offset = 0
        let trailing: Buffer | null = null

        while (offset < size) {
          const chunkSize = Math.min(CHUNK, size - offset)
          const buf = Buffer.alloc(chunkSize)
          const bytesReadOut = [0]
          const ok = ReadProcessMemory(hProcess, base + offset, buf, chunkSize, bytesReadOut)
          if (!ok || bytesReadOut[0] === 0) {
            offset += chunkSize
            trailing = null
            continue
          }

          const data: Buffer = trailing
            ? Buffer.concat([trailing, buf.subarray(0, bytesReadOut[0])])
            : buf.subarray(0, bytesReadOut[0])

          // 搜索 ASCII 32字节密钥
          const key = this._searchAsciiKey(data, ciphertext)
          if (key) {
            this.CloseHandle(hProcess)
            return key
          }

          // 搜索 UTF-16LE 32字节密钥
          const key16 = this._searchUtf16Key(data, ciphertext)
          if (key16) {
            this.CloseHandle(hProcess)
            return key16
          }

          trailing = data.subarray(Math.max(0, data.length - OVERLAP))
          offset += chunkSize
        }
      }

      return null
    } finally {
      this.CloseHandle(hProcess)
    }
  }

  private _searchAsciiKey(data: Buffer, ciphertext: Buffer): string | null {
    for (let i = 0; i < data.length - 34; i++) {
      if (this._isAlphaNum(data[i])) continue
      let valid = true
      for (let j = 1; j <= 32; j++) {
        if (!this._isAlphaNum(data[i + j])) {
          valid = false
          break
        }
      }
      if (!valid) continue
      if (i + 33 < data.length && this._isAlphaNum(data[i + 33])) continue
      const keyBytes = data.subarray(i + 1, i + 33)
      if (this._verifyAesKey(keyBytes, ciphertext))
        return keyBytes.toString('ascii').substring(0, 16)
    }
    return null
  }

  private _searchUtf16Key(data: Buffer, ciphertext: Buffer): string | null {
    for (let i = 0; i < data.length - 65; i++) {
      let valid = true
      for (let j = 0; j < 32; j++) {
        if (data[i + j * 2 + 1] !== 0x00 || !this._isAlphaNum(data[i + j * 2])) {
          valid = false
          break
        }
      }
      if (!valid) continue
      const keyBytes = Buffer.alloc(32)
      for (let j = 0; j < 32; j++) keyBytes[j] = data[i + j * 2]
      if (this._verifyAesKey(keyBytes, ciphertext))
        return keyBytes.toString('ascii').substring(0, 16)
    }
    return null
  }

  private _isAlphaNum(b: number): boolean {
    return (b >= 0x61 && b <= 0x7a) || (b >= 0x41 && b <= 0x5a) || (b >= 0x30 && b <= 0x39)
  }

  private _verifyAesKey(keyBytes: Buffer, ciphertext: Buffer): boolean {
    try {
      const decipher = crypto.createDecipheriv('aes-128-ecb', keyBytes.subarray(0, 16), null)
      decipher.setAutoPadding(false)
      const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()])
      // 支持 JPEG / PNG / WEBP / WXGF / GIF
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
