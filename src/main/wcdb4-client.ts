import fs from 'fs-extra'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { createRequire } from 'module'
import { createConnection, Socket } from 'net'
import { getResourceRoots } from './resource-paths'

export interface Wcdb4Session {
  username: string
  nickname: string
  avatar?: string
  wechatNickname?: string
  remark?: string
  isFolded?: boolean
  isMuted?: boolean
  raw: Record<string, unknown>
}

export interface Wcdb4Message {
  mesLocalID: string
  serverId?: string
  mesDes: number
  messageType: string
  msgCreateTime: string
  msgContent: string
  sender?: string
  senderNickname?: string
  senderAvatar?: string
  raw: Record<string, unknown>
}

export interface Wcdb4MessageQueryOptions {
  limit?: number
}

export interface Wcdb4SessionQueryOptions {
  hydrateDisplayNames?: boolean
  hydrateStatuses?: boolean
}

export interface WindowsNativePathBridgeOptions {
  platform?: NodeJS.Platform
  publicRoot?: string
}

type Wcdb4MessageStore = {
  tableName: string
  dbPath: string
}

export interface Wcdb4GroupMember {
  m_nsUsrName: string
  nickname: string
  groupNickname: string
  wechatNickname: string
  remark: string
  m_nsHeadImgUrl: string
}

/**
 * 联系人表中独立保存的成员名称字段。
 *
 * 群成员接口的 nickname 在部分微信数据版本中会被通讯录备注覆盖，因此不能用它
 * 推断微信昵称或备注。
 */
type Wcdb4ContactMemberNames = {
  wechatNickname: string
  remark: string
}

export interface Wcdb4ImageHardlink {
  file_name?: string
  full_path?: string
  [key: string]: unknown
}

export interface Wcdb4VideoHardlink {
  resolved_md5?: string
  [key: string]: unknown
}

type KoffiModule = {
  load: (libraryPath: string) => KoffiLibrary
  decode: (ptr: unknown, type: string, length: number) => string
}

// Module-level singleton for WCDB native handle. WCDB's Windows runtime
// returns -1006 if wcdb_init is called more than once per process, so we
// perform InitProtection + wcdb_init exactly once and cache the resulting
// library reference for every Wcdb4Client instance.
let wcdbBootstrapLib: KoffiLibrary | null = null

let wcdbBootstrapAsyncPromise: Promise<KoffiLibrary> | null = null

export function bootstrapWcdbNative(libPath?: string, libDirOverride?: string): KoffiLibrary {
  if (wcdbBootstrapLib) return wcdbBootstrapLib

  const koffi = nodeRequire('koffi') as KoffiModule
  const resolvedLibPath = libPath || Wcdb4Client.resolveNativeLibrary()
  const libDir = libDirOverride || path.dirname(resolvedLibPath)
  console.log(
    `[WCDB4] bootstrap koffi.load begin ${resolvedLibPath} cwd=${process.cwd()} resourcesPath=${process.resourcesPath || ''}`
  )
  for (const name of process.platform === 'win32'
    ? ['WCDB.dll', 'SDL2.dll']
    : process.platform === 'darwin'
      ? ['libWCDB.dylib']
      : []) {
    const preloadPath = path.join(libDir, name)
    if (!fs.existsSync(preloadPath)) continue
    try {
      koffi.load(preloadPath)
      console.log(`[WCDB4] bootstrap preload ok ${preloadPath}`)
    } catch {
      console.warn(`[WCDB4] bootstrap preload failed ${preloadPath}`)
    }
  }
  const lib = koffi.load(resolvedLibPath)
  console.log(`[WCDB4] bootstrap koffi.load ok ${resolvedLibPath}`)

  const initProtection = lib.func('int32 InitProtection(const char* resourcePath)') as (
    resourcePath: string
  ) => number
  const resourceRoots = Array.from(
    new Set(
      [
        libDir,
        path.dirname(libDir),
        process.env.WCDB_RESOURCES_PATH || '',
        ...getResourceRoots()
      ].filter(Boolean)
    )
  )
  let lastCode = -1
  let initOk = false
  for (const resourceRoot of resourceRoots) {
    try {
      console.log(`[WCDB4] bootstrap InitProtection call ${resourceRoot}`)
      lastCode = Number(initProtection(resourceRoot))
      console.log(`[WCDB4] bootstrap InitProtection rc=${lastCode} path=${resourceRoot}`)
      if (lastCode === 0) {
        initOk = true
        console.log(`[WCDB4] bootstrap InitProtection ok path=${resourceRoot}`)
        break
      }
    } catch (error) {
      console.warn(`[WCDB4] bootstrap InitProtection exception path=${resourceRoot}`, error)
    }
  }
  if (!initOk) {
    console.warn(
      `[WCDB4] bootstrap InitProtection 返回 ${lastCode}，继续尝试 wcdb_init/open; tried=${resourceRoots.join(' | ')}`
    )
  } else {
    const wcdbInit = lib.func('int32 wcdb_init()') as () => number
    console.log('[WCDB4] bootstrap wcdb_init begin')
    const initRc = Number(wcdbInit())
    console.log(`[WCDB4] bootstrap wcdb_init rc=${initRc}`)
    if (initRc !== 0) {
      console.warn(`[WCDB4] bootstrap wcdb_init 返回 ${initRc}，继续尝试 wcdb_open_account`)
    }
  }

  wcdbBootstrapLib = lib
  return lib
}

export function bootstrapWcdbNativeAsync(
  libPath?: string,
  libDirOverride?: string
): Promise<KoffiLibrary> {
  if (wcdbBootstrapLib) return Promise.resolve(wcdbBootstrapLib)
  if (wcdbBootstrapAsyncPromise) return wcdbBootstrapAsyncPromise

  wcdbBootstrapAsyncPromise = (async () => {
    const koffi = nodeRequire('koffi') as KoffiModule
    const resolvedLibPath = libPath || Wcdb4Client.resolveNativeLibrary()
    const libDir = libDirOverride || path.dirname(resolvedLibPath)
    for (const name of process.platform === 'win32'
      ? ['WCDB.dll', 'SDL2.dll']
      : process.platform === 'darwin'
        ? ['libWCDB.dylib']
        : []) {
      const preloadPath = path.join(libDir, name)
      if (!fs.existsSync(preloadPath)) continue
      try {
        koffi.load(preloadPath)
      } catch {
        // The main library may still resolve its dependencies through the loader.
      }
    }
    const lib = koffi.load(resolvedLibPath)
    const initProtection = lib.func('int32 InitProtection(const char* resourcePath)') as (
      resourcePath: string
    ) => number
    const resourceRoots = Array.from(
      new Set(
        [
          libDir,
          path.dirname(libDir),
          process.env.WCDB_RESOURCES_PATH || '',
          ...getResourceRoots()
        ].filter(Boolean)
      )
    )
    let initOk = false
    for (const resourceRoot of resourceRoots) {
      try {
        if (Number(initProtection(resourceRoot)) === 0) {
          initOk = true
          break
        }
      } catch {
        // Try the next resource root.
      }
    }
    if (initOk) {
      const wcdbInit = lib.func('int32 wcdb_init()') as KoffiAsyncFunction
      await new Promise<void>((resolve, reject) => {
        wcdbInit.async((error: unknown, result: unknown) => {
          if (error) {
            reject(error)
            return
          }
          if (Number(result) !== 0) {
            console.warn(`[WCDB4] async wcdb_init rc=${Number(result)}`)
          }
          resolve()
        })
      })
    }
    wcdbBootstrapLib = lib
    return lib
  })().catch((error) => {
    wcdbBootstrapAsyncPromise = null
    throw error
  })
  return wcdbBootstrapAsyncPromise
}

type KoffiLibrary = {
  func: (signature: string) => KoffiAsyncFunction
}

type KoffiAsyncFunction = ((...args: unknown[]) => unknown) & {
  async: (...args: unknown[]) => void
}

type WcdbVoidOut = [unknown]
type WcdbHandleOut = [number]

const nodeRequire = createRequire(import.meta.url)

function isAsciiPath(value: string): boolean {
  return /^[\x20-\x7e]+$/.test(value)
}

export function resolveWindowsNativeAccountRoot(
  accountRoot: string,
  options: WindowsNativePathBridgeOptions = {}
): string {
  const platform = options.platform || process.platform
  if (platform !== 'win32' || isAsciiPath(accountRoot)) return accountRoot

  const publicRoot = [
    options.publicRoot,
    process.env.PUBLIC,
    path.join(process.env.SystemDrive || 'C:', 'Users', 'Public')
  ]
    .map((candidate) => String(candidate || '').trim())
    .find((candidate) => candidate && isAsciiPath(candidate))
  if (!publicRoot || !isAsciiPath(publicRoot)) return accountRoot

  const bridgeId = crypto
    .createHash('sha256')
    .update(path.resolve(accountRoot).toLowerCase())
    .digest('hex')
    .slice(0, 24)
  const legacyBridgePath = path.join(publicRoot, 'WechatExplorer', 'path-bridges', bridgeId)
  try {
    if (fs.existsSync(legacyBridgePath)) {
      const legacyTarget = fs.realpathSync.native(legacyBridgePath)
      const canonicalAccountRoot = fs.realpathSync.native(accountRoot)
      if (
        path.resolve(legacyTarget).toLowerCase() ===
        path.resolve(canonicalAccountRoot).toLowerCase()
      ) {
        return legacyBridgePath
      }
    }
  } catch {
    // An unreadable legacy junction is left untouched; TraceMemo creates its own bridge below.
  }

  const bridgeRoot = path.join(publicRoot, 'TraceMemo', 'path-bridges')
  const bridgePath = path.join(bridgeRoot, bridgeId)
  try {
    fs.ensureDirSync(bridgeRoot)
    if (fs.existsSync(bridgePath)) {
      const existingTarget = fs.realpathSync.native(bridgePath)
      const canonicalAccountRoot = fs.realpathSync.native(accountRoot)
      if (
        path.resolve(existingTarget).toLowerCase() ===
        path.resolve(canonicalAccountRoot).toLowerCase()
      ) {
        return bridgePath
      }
      fs.removeSync(bridgePath)
    }
    fs.symlinkSync(path.resolve(accountRoot), bridgePath, 'junction')
    return bridgePath
  } catch (error) {
    console.warn('[WCDB4] 无法为中文数据目录建立 native 路径别名:', error)
    return accountRoot
  }
}

export class Wcdb4Client {
  static readonly defaultRoot = Wcdb4Client.findExistingDefaultRoot()

  private readonly key: string
  private readonly accountRoot: string
  private readonly nativeAccountRoot: string
  private readonly wxid: string
  private readonly dbStoragePath: string
  private readonly sessionDbPath: string
  private koffi: KoffiModule | null = null
  private handle: number | null = null
  private displayNameCache = new Map<string, string>()
  private avatarCache = new Map<string, string>()
  private sessionStatusCache = new Map<string, { isFolded: boolean; isMuted: boolean }>()
  private groupNicknameCache = new Map<string, Map<string, string>>()
  private cachedSessions: Wcdb4Session[] | null = null
  private cachedChatTables: { name: string; db_number: string }[] | null = null
  private sessionsInFlight: Promise<Wcdb4Session[]> | null = null
  private sessionDisplayNamesInFlight: Promise<void> | null = null
  private sessionDisplayNamesHydrated = false
  private sessionStatusesInFlight: Promise<void> | null = null
  private sessionStatusesUpdatedAt = 0
  private sessionCacheGeneration = 0
  private closing = false
  private nativeCallsInFlight = new Set<Promise<unknown>>()

  private wcdbShutdown: (() => number) | null = null
  private wcdbOpenAccount:
    | ((sessionDbPath: string, key: string, handleOut: WcdbHandleOut) => number)
    | null = null
  private wcdbOpenAccountAsync: KoffiAsyncFunction | null = null
  private wcdbSetMyWxid: ((handle: number, wxid: string) => number) | null = null
  private wcdbFreeString: ((ptr: unknown) => void) | null = null
  private wcdbGetSessions: ((handle: number, outJson: WcdbVoidOut) => number) | null = null
  private wcdbGetMessages:
    | ((
        handle: number,
        username: string,
        limit: number,
        offset: number,
        outJson: WcdbVoidOut
      ) => number)
    | null = null
  private wcdbGetMessageTableStats:
    | ((handle: number, username: string, outJson: WcdbVoidOut) => number)
    | null = null
  private wcdbGetDisplayNames:
    | ((handle: number, usernamesJson: string, outJson: WcdbVoidOut) => number)
    | null = null
  private wcdbGetAvatarUrls:
    | ((handle: number, usernamesJson: string, outJson: WcdbVoidOut) => number)
    | null = null
  private wcdbGetContactStatus:
    | ((handle: number, usernamesJson: string, outJson: WcdbVoidOut) => number)
    | null = null
  private wcdbGetHeadImageBuffers:
    | ((handle: number, usernamesJson: string, outJson: WcdbVoidOut) => number)
    | null = null
  private wcdbExecQuery:
    | ((handle: number, kind: string, dbPath: string, sql: string, outJson: WcdbVoidOut) => number)
    | null = null
  private wcdbGetGroupMembers:
    | ((handle: number, chatroomId: string, outJson: WcdbVoidOut) => number)
    | null = null
  private wcdbGetGroupNicknames:
    | ((handle: number, chatroomId: string, outJson: WcdbVoidOut) => number)
    | null = null
  private wcdbOpenMessageCursor:
    | ((
        handle: number,
        username: string,
        batchSize: number,
        ascending: number,
        beginTimestamp: number,
        endTimestamp: number,
        cursorOut: WcdbHandleOut
      ) => number)
    | null = null
  private wcdbFetchMessageBatch:
    | ((handle: number, cursor: number, outJson: WcdbVoidOut, outHasMore: [number]) => number)
    | null = null
  private wcdbCloseMessageCursor: ((handle: number, cursor: number) => number) | null = null
  private wcdbGetVoiceData:
    | ((
        handle: number,
        sessionId: string,
        createTime: number,
        localId: number,
        svrId: bigint,
        candidatesJson: string,
        outHex: WcdbVoidOut
      ) => number)
    | null = null
  private wcdbResolveImageHardlink:
    | ((handle: number, md5: string, accountDir: string, outJson: WcdbVoidOut) => number)
    | null = null
  private wcdbResolveVideoHardlink:
    | ((handle: number, md5: string, dbPath: string, outJson: WcdbVoidOut) => number)
    | null = null
  private wcdbGetEmoticonCdnUrl:
    | ((handle: number, dbPath: string, md5: string, outUrl: WcdbVoidOut) => number)
    | null = null
  private wcdbStartMonitorPipe: (() => number) | null = null
  private wcdbStopMonitorPipe: (() => void) | null = null
  private wcdbGetMonitorPipeName: ((outName: WcdbVoidOut) => number) | null = null
  private monitorPipeClient: Socket | null = null
  private monitorCallback: ((type: string, json: string) => void) | null = null
  private monitorConnectTimer: ReturnType<typeof setTimeout> | null = null
  private monitorReconnectTimer: ReturnType<typeof setTimeout> | null = null
  private monitorPipePath = ''
  private monitorStarted = false

  constructor(key: string, accountRoot?: string) {
    this.key = key.replace(/^0x/i, '').trim()
    this.accountRoot = accountRoot
      ? Wcdb4Client.resolveAccountRoot(accountRoot)
      : Wcdb4Client.findLatestAccountRoot()
    this.nativeAccountRoot = resolveWindowsNativeAccountRoot(this.accountRoot)
    this.wxid = Wcdb4Client.cleanAccountDirName(path.basename(this.accountRoot))
    this.dbStoragePath = path.join(this.nativeAccountRoot, 'db_storage')
    this.sessionDbPath = this.findSessionDb()

    if (!this.sessionDbPath) {
      throw new Error(`未找到微信 4.0 session.db: ${this.dbStoragePath}`)
    }
  }

  static resolveAccountRoot(accountRoot: string): string {
    const target = (accountRoot || '').trim().replace(/[\\/]+$/, '')
    if (!target) {
      throw new Error('微信 4.0 账号目录不能为空')
    }
    if (Wcdb4Client.hasDbStorage(target)) {
      return target
    }
    if (!fs.existsSync(target)) {
      throw new Error(`未找到微信 4.0 数据目录: ${target}`)
    }
    const candidates = fs
      .readdirSync(target)
      .map((name) => path.join(target, name))
      .filter((candidate) => Wcdb4Client.hasDbStorage(candidate))
      .sort(Wcdb4Client.compareAccountDirs)
    if (!candidates[0]) {
      throw new Error(`未找到包含 db_storage 的微信 4.0 账号目录: ${target}`)
    }
    return candidates[0]
  }

  static findLatestAccountRoot(): string {
    const root = Wcdb4Client.defaultRoot
    if (!fs.existsSync(root)) {
      throw new Error(`未找到微信 4.0 数据目录: ${root}`)
    }

    if (Wcdb4Client.hasDbStorage(root)) {
      return root
    }

    const candidates = fs
      .readdirSync(root)
      .map((name) => path.join(root, name))
      .filter((candidate) => Wcdb4Client.hasDbStorage(candidate))
      .sort(Wcdb4Client.compareAccountDirs)

    if (!candidates[0]) {
      throw new Error(`未找到包含 db_storage 的微信 4.0 账号目录: ${root}`)
    }

    return candidates[0]
  }

  private static findExistingDefaultRoot(): string {
    const roots = Wcdb4Client.getDefaultRootCandidates()
    return roots.find((root) => Wcdb4Client.isUsableRoot(root)) || roots[0]
  }

  private static getDefaultRootCandidates(): string[] {
    const home = os.homedir()
    if (process.platform === 'win32') {
      // 仅支持 WeChat 4.0：只认 xwechat_files，V3 时代的 "WeChat Files" 不再加入候选
      const candidates = [
        ...Wcdb4Client.getWeflowDbPathCandidates(home),
        path.join(home, 'Documents', 'xwechat_files'),
        path.join(home, 'AppData', 'Roaming', 'Tencent', 'xwechat_files')
      ]
      return Array.from(new Set(candidates))
    }
    return [
      path.join(home, 'Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files')
    ]
  }

  private static getWeflowDbPathCandidates(home: string): string[] {
    const configPaths = [
      path.join(home, 'AppData', 'Roaming', 'weflow', 'WeFlow-config.json'),
      path.join(home, 'AppData', 'Roaming', 'WeFlow', 'WeFlow-config.json')
    ]
    const candidates: string[] = []
    for (const configPath of configPaths) {
      try {
        const config = fs.readJsonSync(configPath) as { dbPath?: unknown }
        if (typeof config.dbPath === 'string' && config.dbPath.trim()) {
          candidates.push(config.dbPath.trim())
        }
      } catch {
        // WeFlow is optional; ignore missing or unreadable config.
      }
    }
    return candidates
  }

  private static hasDbStorage(candidate: string): boolean {
    try {
      return (
        fs.statSync(candidate).isDirectory() && fs.existsSync(path.join(candidate, 'db_storage'))
      )
    } catch {
      return false
    }
  }

  private static isUsableRoot(candidate: string): boolean {
    if (!fs.existsSync(candidate)) return false
    if (Wcdb4Client.hasDbStorage(candidate)) return true
    try {
      return fs
        .readdirSync(candidate)
        .some((name) => Wcdb4Client.hasDbStorage(path.join(candidate, name)))
    } catch {
      return false
    }
  }

  private static hasSessionDb(candidate: string): boolean {
    return (
      fs.existsSync(path.join(candidate, 'db_storage', 'session', 'session.db')) ||
      fs.existsSync(path.join(candidate, 'db_storage', 'session.db'))
    )
  }

  private static compareAccountDirs(a: string, b: string): number {
    const aHasSession = Wcdb4Client.hasSessionDb(a)
    const bHasSession = Wcdb4Client.hasSessionDb(b)
    if (aHasSession !== bHasSession) return aHasSession ? -1 : 1
    try {
      return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs
    } catch {
      return 0
    }
  }

  private static cleanAccountDirName(dirName: string): string {
    const trimmed = dirName.trim()
    if (!trimmed) return trimmed

    if (trimmed.toLowerCase().startsWith('wxid_')) {
      const match = trimmed.match(/^(wxid_[^_]+)/i)
      if (match) return match[1]
      return trimmed
    }

    const suffixMatch = trimmed.match(/^(.+)_([a-zA-Z0-9]{4})$/)
    return suffixMatch ? suffixMatch[1] : trimmed
  }

  open(): void {
    this.loadNativeLibrary()
    if (!this.wcdbOpenAccount) {
      throw new Error('WCDB 4.0 native 接口未就绪')
    }

    let openResult = -1
    const handleOut: WcdbHandleOut = [0]
    openResult = this.wcdbOpenAccount(this.sessionDbPath, this.key, handleOut)

    if (openResult !== 0 || handleOut[0] <= 0) {
      const hint =
        openResult === -1005
          ? '；这通常表示密钥与当前账号数据库不匹配，请确认微信已登录目标账号，并重新自动获取密钥'
          : ''
      throw new Error(
        `wcdb_open_account 失败，错误码: ${openResult}${hint}; sessionDb=${this.sessionDbPath}; accountRoot=${this.accountRoot}; wxid=${this.wxid}; keyLength=${this.key.length}`
      )
    }

    this.handle = handleOut[0]
    if (this.wcdbSetMyWxid) {
      try {
        this.wcdbSetMyWxid(this.handle, this.wxid)
      } catch {
        // Optional helper. Failure does not block message reads.
      }
    }
  }

  async openAsync(): Promise<void> {
    this.loadNativeLibrary()
    if (!this.wcdbOpenAccountAsync) {
      throw new Error('WCDB 4.0 native open async interface unavailable')
    }

    const handleOut: WcdbHandleOut = [0]
    const openResult = await this.callAsyncCode(
      this.wcdbOpenAccountAsync,
      this.sessionDbPath,
      this.key,
      handleOut
    )
    if (openResult !== 0 || handleOut[0] <= 0) {
      throw new Error(
        `wcdb_open_account failed, code=${openResult}; sessionDb=${this.sessionDbPath}; accountRoot=${this.accountRoot}; wxid=${this.wxid}; keyLength=${this.key.length}`
      )
    }
    this.handle = handleOut[0]
    if (this.wcdbSetMyWxid) {
      try {
        await this.callAsyncCode(
          this.wcdbSetMyWxid as unknown as KoffiAsyncFunction,
          this.handle,
          this.wxid
        )
      } catch {
        // Optional helper. Failure does not block message reads.
      }
    }
  }

  close(): void {
    this.closing = true
    this.stopMonitor()
    const canShutdownNative = this.nativeCallsInFlight.size === 0
    if (!canShutdownNative) {
      console.warn(
        `[WCDB4] skip synchronous native shutdown; ${this.nativeCallsInFlight.size} async call(s) still running`
      )
    }
    this.finishClose(canShutdownNative)
  }

  async closeAsync(timeoutMs = 8_000): Promise<boolean> {
    this.closing = true
    this.stopMonitorTransport()
    const drained = await this.waitForNativeCalls(timeoutMs)
    this.stopNativeMonitor()
    if (!drained) {
      console.warn(
        `[WCDB4] native calls did not drain within ${timeoutMs}ms; skip wcdb_shutdown during app quit`
      )
    }
    this.finishClose(drained)
    return drained
  }

  private finishClose(shutdownNative: boolean): void {
    if (
      shutdownNative &&
      this.handle !== null &&
      this.wcdbShutdown &&
      process.platform !== 'win32'
    ) {
      try {
        this.wcdbShutdown()
      } catch {
        // Shutdown is best-effort after all tracked native calls have completed.
      }
    }
    this.handle = null
    this.cachedSessions = null
    this.cachedChatTables = null
    this.sessionsInFlight = null
    this.sessionDisplayNamesInFlight = null
    this.sessionDisplayNamesHydrated = false
    this.sessionStatusesInFlight = null
    this.sessionStatusesUpdatedAt = 0
    this.displayNameCache.clear()
    this.avatarCache.clear()
    this.sessionStatusCache.clear()
    this.groupNicknameCache.clear()
  }

  private waitForNativeCalls(timeoutMs: number): Promise<boolean> {
    const pending = Array.from(this.nativeCallsInFlight)
    if (pending.length === 0) return Promise.resolve(true)

    return new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (drained: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(drained)
      }
      const timer = setTimeout(() => finish(false), timeoutMs)
      void Promise.allSettled(pending).then(() => {
        // Koffi promise resolution can resume higher-level async cleanup (for example,
        // closing a message cursor) in the same event-loop turn. Give those continuations
        // one full turn before shutting down the process-wide WCDB runtime.
        setImmediate(() => finish(this.nativeCallsInFlight.size === 0))
      })
    })
  }

  async startMonitor(callback: (type: string, json: string) => void): Promise<boolean> {
    if (this.closing || !this.wcdbStartMonitorPipe || !this.wcdbGetMonitorPipeName || !this.koffi) {
      return false
    }

    this.stopMonitor()
    this.monitorCallback = callback

    try {
      const startResult = await this.callAsyncCode(
        this.wcdbStartMonitorPipe as unknown as KoffiAsyncFunction
      )
      if (startResult !== 0) {
        this.monitorCallback = null
        console.warn(`[WCDB4] wcdb_start_monitor_pipe 失败，错误码: ${startResult}`)
        return false
      }
      this.monitorStarted = true
      if (this.closing) {
        this.stopMonitor()
        return false
      }

      const outName: WcdbVoidOut = [null]
      const nameResult = await this.callAsyncCode(
        this.wcdbGetMonitorPipeName as unknown as KoffiAsyncFunction,
        outName
      )
      if (nameResult !== 0 || !outName[0]) {
        console.warn(`[WCDB4] wcdb_get_monitor_pipe_name 失败，错误码: ${nameResult}`)
        this.stopMonitor()
        return false
      }

      try {
        this.monitorPipePath = this.koffi.decode(outName[0], 'char', -1).trim()
      } finally {
        this.wcdbFreeString?.(outName[0])
      }

      if (!this.monitorPipePath) {
        this.stopMonitor()
        return false
      }

      this.connectMonitorPipe()
      return true
    } catch (error) {
      console.warn('[WCDB4] 启动数据库监听失败:', error)
      this.stopMonitor()
      return false
    }
  }

  stopMonitor(): void {
    this.stopMonitorTransport()
    this.stopNativeMonitor()
  }

  private stopMonitorTransport(): void {
    this.monitorCallback = null

    if (this.monitorConnectTimer) {
      clearTimeout(this.monitorConnectTimer)
      this.monitorConnectTimer = null
    }
    if (this.monitorReconnectTimer) {
      clearTimeout(this.monitorReconnectTimer)
      this.monitorReconnectTimer = null
    }
    if (this.monitorPipeClient) {
      this.monitorPipeClient.destroy()
      this.monitorPipeClient = null
    }
  }

  private stopNativeMonitor(): void {
    if (this.monitorStarted && this.wcdbStopMonitorPipe) {
      try {
        this.wcdbStopMonitorPipe()
      } catch {
        // Native monitor cleanup is best-effort during reconnect or shutdown.
      }
    }

    this.monitorStarted = false
    this.monitorPipePath = ''
  }

  private connectMonitorPipe(): void {
    if (!this.monitorCallback || !this.monitorPipePath || this.monitorConnectTimer) return

    this.monitorConnectTimer = setTimeout(() => {
      this.monitorConnectTimer = null
      if (!this.monitorCallback || !this.monitorPipePath || this.monitorPipeClient) return

      const socket = createConnection(this.monitorPipePath)
      this.monitorPipeClient = socket
      let buffer = ''

      socket.on('data', (data) => {
        const normalizedChunk = data
          .toString('utf8')
          .split('\0')
          .join('\n')
          .replace(/}\s*{/g, '}\n{')
        buffer += normalizedChunk

        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() || ''
        for (const line of lines) this.emitMonitorPayload(line)

        const tail = buffer.trim()
        if (tail.startsWith('{') && tail.endsWith('}')) {
          try {
            JSON.parse(tail)
            this.emitMonitorPayload(tail)
            buffer = ''
          } catch {
            // Keep the partial payload until the next socket chunk arrives.
          }
        }
      })

      socket.on('error', (error) => {
        console.warn('[WCDB4] 数据库监听管道异常:', error.message)
      })

      socket.on('close', () => {
        if (this.monitorPipeClient === socket) this.monitorPipeClient = null
        this.scheduleMonitorReconnect()
      })
    }, 100)
  }

  private emitMonitorPayload(rawPayload: string): void {
    const payload = rawPayload.trim()
    if (!payload || !this.monitorCallback) return

    try {
      const parsed = JSON.parse(payload) as { action?: string }
      this.monitorCallback(parsed.action || 'update', payload)
    } catch {
      this.monitorCallback('update', payload)
    }
  }

  private scheduleMonitorReconnect(): void {
    if (this.monitorReconnectTimer || !this.monitorCallback || !this.monitorPipePath) return
    this.monitorReconnectTimer = setTimeout(() => {
      this.monitorReconnectTimer = null
      this.connectMonitorPipe()
    }, 3000)
  }

  getSessions(): Wcdb4Session[] {
    if (this.cachedSessions) return this.cachedSessions
    if (!this.wcdbGetSessions) return []

    const rows = this.readSessionRows()
    const sessions = (Array.isArray(rows) ? rows : [])
      .map((row) => this.normalizeSession(row))
      .filter((session) => session.username)

    this.cachedSessions = sessions.map((session) => ({
      ...session,
      nickname: this.displayNameCache.get(session.username) || session.nickname || session.username
    }))
    this.sessionDisplayNamesHydrated = false

    return this.cachedSessions
  }

  async getSessionsAsync(options: Wcdb4SessionQueryOptions = {}): Promise<Wcdb4Session[]> {
    const hydrateDisplayNames = options.hydrateDisplayNames !== false
    if (this.cachedSessions) {
      if (hydrateDisplayNames) await this.ensureSessionDisplayNamesAsync()
      if (options.hydrateStatuses) await this.refreshSessionStatusesAsync()
      return this.cachedSessions
    }
    if (this.sessionsInFlight) {
      await this.sessionsInFlight
      if (hydrateDisplayNames) await this.ensureSessionDisplayNamesAsync()
      if (options.hydrateStatuses) await this.refreshSessionStatusesAsync()
      return this.cachedSessions || []
    }
    if (!this.wcdbGetSessions) return []

    const generation = this.sessionCacheGeneration
    const request = (async (): Promise<Wcdb4Session[]> => {
      const rows = await this.callJsonAsync<Record<string, unknown>[]>(
        this.wcdbGetSessions as unknown as KoffiAsyncFunction
      )
      const sessions = (Array.isArray(rows) ? rows : [])
        .map((row) => this.normalizeSession(row))
        .filter((session) => session.username)
      if (generation === this.sessionCacheGeneration) this.cachedSessions = sessions
      return sessions
    })()
    this.sessionsInFlight = request
    try {
      await request
    } finally {
      if (this.sessionsInFlight === request) this.sessionsInFlight = null
    }
    if (hydrateDisplayNames) await this.ensureSessionDisplayNamesAsync()
    if (options.hydrateStatuses) await this.refreshSessionStatusesAsync()
    return this.cachedSessions || []
  }

  private async refreshSessionStatusesAsync(): Promise<void> {
    if (Date.now() - this.sessionStatusesUpdatedAt < 5 * 60 * 1000) return
    if (this.sessionStatusesInFlight) {
      await this.sessionStatusesInFlight
      return
    }
    const sessions = this.cachedSessions
    if (!sessions?.length || !this.wcdbGetContactStatus) return
    const groupUsernames = sessions
      .map((session) => session.username)
      .filter((username) => username.endsWith('@chatroom'))
    if (!groupUsernames.length) {
      this.sessionStatusesUpdatedAt = Date.now()
      return
    }
    const request = (async (): Promise<void> => {
      try {
        const map = await this.callJsonAsync<
          Record<string, { isFolded?: boolean; isMuted?: boolean }>
        >(
          this.wcdbGetContactStatus as unknown as KoffiAsyncFunction,
          JSON.stringify(groupUsernames)
        )
        for (const username of groupUsernames) {
          const status = map?.[username]
          this.sessionStatusCache.set(username, {
            isFolded: Boolean(status?.isFolded),
            isMuted: Boolean(status?.isMuted)
          })
        }
        if (this.cachedSessions) {
          this.cachedSessions = this.cachedSessions.map((session) => {
            const status = this.sessionStatusCache.get(session.username)
            return status ? { ...session, ...status } : session
          })
        }
        this.sessionStatusesUpdatedAt = Date.now()
      } catch (error) {
        console.warn('[WCDB4] session status lookup failed:', error)
      }
    })()
    this.sessionStatusesInFlight = request
    try {
      await request
    } finally {
      if (this.sessionStatusesInFlight === request) this.sessionStatusesInFlight = null
    }
  }

  invalidateSessionCache(): void {
    this.sessionCacheGeneration += 1
    this.cachedSessions = null
    this.cachedChatTables = null
    this.sessionsInFlight = null
    this.sessionDisplayNamesHydrated = false
  }

  getChatTables(): { name: string; db_number: string }[] {
    if (this.cachedChatTables) return this.cachedChatTables
    const sessions =
      this.cachedSessions ||
      this.readSessionRows()
        .map((row) => this.normalizeSession(row))
        .filter((session) => session.username)
    this.cachedChatTables = sessions.map((session) => ({
      name: `Chat_${this.md5(session.username)}`,
      db_number: session.username
    }))
    return this.cachedChatTables
  }

  getMessages(
    username: string,
    startTime?: number,
    endTime?: number,
    options: Wcdb4MessageQueryOptions = {}
  ): Wcdb4Message[] {
    const startedAt = Date.now()
    const maxRows = this.normalizeMessageLimit(options.limit)
    console.log(
      `[WCDB4] getMessages begin username=${username} start=${startTime || 0} end=${endTime || 0} limit=${maxRows || 0}`
    )
    try {
      const cursorMessages = this.getMessagesByCursor(username, startTime, endTime, maxRows)
      if (cursorMessages && cursorMessages.length > 0) {
        const recoveredMessages = this.readRecallJournal(username, startTime, endTime)
        const mergedMessages = this.mergeMessageRows(cursorMessages, recoveredMessages, maxRows)
        console.log(
          `[WCDB4] getMessages cursor ok username=${username} rows=${mergedMessages.length} recovered=${recoveredMessages.length} cost=${Date.now() - startedAt}ms`
        )
        return mergedMessages
      }
    } catch (error) {
      console.warn(`[WCDB4] cursor messages failed username=${username}:`, error)
    }

    if (maxRows) {
      const tableRows = this.getMessagesByTableScan(username, startTime, endTime, maxRows)
      if (tableRows.length > 0) {
        console.log(
          `[WCDB4] getMessages table scan ok username=${username} rows=${tableRows.length} cost=${Date.now() - startedAt}ms`
        )
        return tableRows
      }
    }

    if (!this.wcdbGetMessages) return []

    const allRows: Record<string, unknown>[] = []
    const limit = 1000
    let offset = 0

    while (true) {
      let rows: Record<string, unknown>[]
      try {
        rows = this.callJson<Record<string, unknown>[]>((handle, outJson) =>
          this.wcdbGetMessages!(handle, username, limit, offset, outJson)
        )
      } catch (error) {
        console.warn(`[WCDB4] get_messages failed username=${username} offset=${offset}:`, error)
        break
      }
      const batch = Array.isArray(rows) ? rows : []
      allRows.push(...batch)
      if (batch.length < limit) break
      if (maxRows && allRows.length >= maxRows) break
      offset += limit
    }

    if (allRows.length === 0) {
      const tableRows = this.getMessagesByTableScan(username, startTime, endTime, maxRows)
      if (tableRows.length > 0) {
        console.log(
          `[WCDB4] getMessages table scan ok username=${username} rows=${tableRows.length} cost=${Date.now() - startedAt}ms`
        )
        return tableRows
      }
    }

    const messages = this.finalizeMessages(username, allRows, startTime, endTime, maxRows)
    console.log(
      `[WCDB4] getMessages direct ok username=${username} rows=${messages.length} cost=${Date.now() - startedAt}ms`
    )
    return messages
  }

  async getMessagesAsync(
    username: string,
    startTime?: number,
    endTime?: number,
    options: Wcdb4MessageQueryOptions = {}
  ): Promise<Wcdb4Message[]> {
    const startedAt = Date.now()
    const maxRows = this.normalizeMessageLimit(options.limit)
    let cursorMessages: Wcdb4Message[] = []
    try {
      cursorMessages = await this.getMessagesByCursorAsync(username, startTime, endTime, maxRows)
    } catch (error) {
      console.warn(`[WCDB4] async cursor messages failed username=${username}:`, error)
    }

    if (endTime && (!this.wcdbGetMessageTableStats || !this.wcdbExecQuery)) {
      throw new Error('当前数据服务无法检查历史消息分片，请更新应用或核对微信数据版本')
    }

    // Older pages may live in message shards that the native cursor does not
    // enumerate. A bounded query must inspect all matching stores so history
    // cannot silently stop at a shard boundary.
    let tableMessages: Wcdb4Message[] = []
    if (endTime || cursorMessages.length === 0) {
      tableMessages = await this.getMessagesByTableScanAsync(username, startTime, endTime, maxRows)
    }
    const messages = this.mergeMessageRows(cursorMessages, tableMessages, maxRows)
    console.log(
      `[WCDB4] getMessages async username=${username} rows=${messages.length} cursor=${cursorMessages.length} tables=${tableMessages.length} cost=${Date.now() - startedAt}ms`
    )
    return messages
  }

  async countVoiceMessagesAsync(
    username: string,
    startTime?: number,
    endTime?: number
  ): Promise<number | null> {
    if (!this.wcdbGetMessageTableStats || !this.wcdbExecQuery) return null

    let tables: Wcdb4MessageStore[]
    try {
      tables = await this.listMessageStoresAsync(username)
    } catch (error) {
      console.warn(`[WCDB4] voice count table stats failed username=${username}:`, error)
      return null
    }

    const begin = this.normalizeTimestamp(startTime || 0)
    const end = this.normalizeTimestamp(endTime || 0)
    const where = [
      '(("local_type" & 65535) = 34)',
      begin > 0 ? `"create_time" >= ${begin}` : '',
      end > 0 ? `"create_time" <= ${end}` : ''
    ].filter(Boolean)

    let total = 0
    for (const table of tables) {
      try {
        const rows = await this.callJsonAsync<Record<string, unknown>[]>(
          this.wcdbExecQuery as unknown as KoffiAsyncFunction,
          'message',
          table.dbPath,
          `SELECT COUNT(*) AS "voice_count" FROM ${this.quoteSqlIdentifier(table.tableName)} WHERE ${where.join(' AND ')}`
        )
        const value = Number(this.pickValue(rows[0] || {}, ['voice_count', 'count', 'COUNT(*)']))
        if (Number.isFinite(value)) total += value
      } catch (error) {
        console.warn(
          `[WCDB4] voice count failed username=${username} db=${table.dbPath} table=${table.tableName}:`,
          error
        )
        return null
      }
    }
    return total
  }

  private readSessionRows(): Record<string, unknown>[] {
    if (!this.wcdbGetSessions) return []
    const rows = this.callJson<Record<string, unknown>[]>((handle, outJson) =>
      this.wcdbGetSessions!(handle, outJson)
    )
    return Array.isArray(rows) ? rows : []
  }

  private getMessagesByTableScan(
    username: string,
    startTime?: number,
    endTime?: number,
    limit?: number
  ): Wcdb4Message[] {
    if (!this.wcdbExecQuery) return []

    let tables: Wcdb4MessageStore[] = []
    try {
      tables = this.listMessageStores(username)
    } catch (error) {
      console.warn(`[WCDB4] message table stats failed username=${username}:`, error)
      return []
    }

    const allRows: Record<string, unknown>[] = []
    const begin = this.normalizeTimestamp(startTime || 0)
    const end = this.normalizeTimestamp(endTime || 0)
    const where = [
      begin > 0 ? `"create_time" >= ${begin}` : '',
      end > 0 ? `"create_time" <= ${end}` : ''
    ].filter(Boolean)
    const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : ''

    for (const table of tables) {
      try {
        const order = limit ? 'DESC' : 'ASC'
        const rowLimit = limit || 5000
        const sql = `SELECT * FROM ${this.quoteSqlIdentifier(table.tableName)}${whereSql} ORDER BY "create_time" ${order} LIMIT ${rowLimit}`
        const rows = this.callJson<Record<string, unknown>[]>((handle, outJson) =>
          this.wcdbExecQuery!(handle, 'message', table.dbPath, sql, outJson)
        )
        if (Array.isArray(rows)) allRows.push(...rows)
      } catch (error) {
        console.warn(
          `[WCDB4] message table scan failed username=${username} db=${table.dbPath} table=${table.tableName}:`,
          error
        )
      }
    }

    return this.finalizeMessages(username, allRows, startTime, endTime, limit)
  }

  private async getMessagesByTableScanAsync(
    username: string,
    startTime?: number,
    endTime?: number,
    limit?: number
  ): Promise<Wcdb4Message[]> {
    if (!this.wcdbExecQuery) return []

    let tables: Wcdb4MessageStore[] = []
    try {
      tables = await this.listMessageStoresAsync(username)
    } catch (error) {
      console.warn(`[WCDB4] async message table stats failed username=${username}:`, error)
      throw new Error(
        `无法读取历史消息分片信息：${error instanceof Error ? error.message : String(error)}`
      )
    }

    const begin = this.normalizeTimestamp(startTime || 0)
    const end = this.normalizeTimestamp(endTime || 0)
    const where = [
      begin > 0 ? `"create_time" >= ${begin}` : '',
      end > 0 ? `"create_time" <= ${end}` : ''
    ].filter(Boolean)
    const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : ''
    const rowLimit = limit || 5000
    const order = limit ? 'DESC' : 'ASC'

    const allRows: Record<string, unknown>[] = []
    let successfulTables = 0
    for (const table of tables) {
      try {
        const sql = `SELECT * FROM ${this.quoteSqlIdentifier(table.tableName)}${whereSql} ORDER BY "create_time" ${order} LIMIT ${rowLimit}`
        const rows = await this.callJsonAsync<Record<string, unknown>[]>(
          this.wcdbExecQuery as unknown as KoffiAsyncFunction,
          'message',
          table.dbPath,
          sql
        )
        successfulTables += 1
        if (Array.isArray(rows)) allRows.push(...rows)
      } catch (error) {
        console.warn(
          `[WCDB4] async message table scan failed username=${username} db=${table.dbPath} table=${table.tableName}:`,
          error
        )
      }
    }

    if (tables.length > 0 && successfulTables === 0) {
      throw new Error('历史消息分片均读取失败，请检查数据目录或微信数据版本')
    }

    return this.finalizeMessages(username, allRows, startTime, endTime, limit)
  }

  installRecallJournal(usernames: string[]): { installed: number; failed: number } {
    const stores = new Map<string, Wcdb4MessageStore>()
    for (const username of this.uniq(usernames)) {
      try {
        for (const store of this.listMessageStores(username)) {
          stores.set(`${store.dbPath}\u0000${store.tableName}`, store)
        }
      } catch (error) {
        console.warn(`[WCDB4] recall journal table discovery failed username=${username}:`, error)
      }
    }

    let installed = 0
    let failed = 0
    for (const store of stores.values()) {
      try {
        const columns = this.readMessageColumns(store)
        if (columns.length === 0) throw new Error('消息表没有可归档列')
        this.ensureRecallJournalTable(store, columns)
        this.createRecallJournalTrigger(store, columns)
        installed += 1
      } catch (error) {
        failed += 1
        console.warn(
          `[WCDB4] recall journal install failed db=${store.dbPath} table=${store.tableName}:`,
          error
        )
      }
    }
    return { installed, failed }
  }

  private listMessageStores(username: string): Wcdb4MessageStore[] {
    let stores: Wcdb4MessageStore[] = []
    if (this.wcdbGetMessageTableStats) {
      try {
        const rows = this.callJson<Record<string, unknown>[]>((handle, outJson) =>
          this.wcdbGetMessageTableStats!(handle, username, outJson)
        )
        stores = this.parseMessageStores(rows)
      } catch (error) {
        if (!username.startsWith('gh_')) throw error
      }
    }
    return stores.length > 0 ? stores : this.listBizMessageStores(username)
  }

  private async listMessageStoresAsync(username: string): Promise<Wcdb4MessageStore[]> {
    let stores: Wcdb4MessageStore[] = []
    if (this.wcdbGetMessageTableStats) {
      try {
        const rows = await this.callJsonAsync<Record<string, unknown>[]>(
          this.wcdbGetMessageTableStats as unknown as KoffiAsyncFunction,
          username
        )
        stores = this.parseMessageStores(rows)
      } catch (error) {
        if (!username.startsWith('gh_')) throw error
      }
    }
    return stores.length > 0 ? stores : this.listBizMessageStoresAsync(username)
  }

  private parseMessageStores(rows: Record<string, unknown>[]): Wcdb4MessageStore[] {
    return (Array.isArray(rows) ? rows : [])
      .map((row) => ({
        tableName: this.pickString(row, ['table_name', 'tableName', 'name']),
        dbPath: this.pickString(row, ['db_path', 'dbPath', 'path'])
      }))
      .filter((row) => row.tableName && row.dbPath)
  }

  private getBizMessageDatabasePaths(): string[] {
    const messageRoot = path.join(this.dbStoragePath, 'message')
    try {
      return fs
        .readdirSync(messageRoot)
        .filter((name) => /^biz_message(?:_\d+)?\.db$/i.test(name))
        .sort()
        .map((name) => path.join(messageRoot, name))
    } catch {
      return []
    }
  }

  private listBizMessageStores(username: string): Wcdb4MessageStore[] {
    if (!this.wcdbExecQuery || !username.startsWith('gh_')) return []
    const tableName = `Msg_${this.md5(username)}`
    const escapedTableName = tableName.replace(/'/g, "''")
    const stores: Wcdb4MessageStore[] = []
    for (const dbPath of this.getBizMessageDatabasePaths()) {
      try {
        const rows = this.callJson<Record<string, unknown>[]>((handle, outJson) =>
          this.wcdbExecQuery!(
            handle,
            'message',
            dbPath,
            `SELECT name FROM sqlite_master WHERE type='table' AND name='${escapedTableName}'`,
            outJson
          )
        )
        if (Array.isArray(rows) && rows.length > 0) stores.push({ tableName, dbPath })
      } catch {
        // Older biz shards may be absent or use a different key; continue scanning.
      }
    }
    return stores
  }

  private async listBizMessageStoresAsync(username: string): Promise<Wcdb4MessageStore[]> {
    if (!this.wcdbExecQuery || !username.startsWith('gh_')) return []
    const tableName = `Msg_${this.md5(username)}`
    const escapedTableName = tableName.replace(/'/g, "''")
    const stores: Wcdb4MessageStore[] = []
    for (const dbPath of this.getBizMessageDatabasePaths()) {
      try {
        const rows = await this.callJsonAsync<Record<string, unknown>[]>(
          this.wcdbExecQuery as unknown as KoffiAsyncFunction,
          'message',
          dbPath,
          `SELECT name FROM sqlite_master WHERE type='table' AND name='${escapedTableName}'`
        )
        if (Array.isArray(rows) && rows.length > 0) stores.push({ tableName, dbPath })
      } catch {
        // Older biz shards may be absent or use a different key; continue scanning.
      }
    }
    return stores
  }

  private executeMessageSql(store: Wcdb4MessageStore, sql: string): Record<string, unknown>[] {
    if (!this.wcdbExecQuery) throw new Error('当前 WCDB 数据服务不支持 SQL 通道')
    const rows = this.callJson<Record<string, unknown>[]>((handle, outJson) =>
      this.wcdbExecQuery!(handle, 'message', store.dbPath, sql, outJson)
    )
    return Array.isArray(rows) ? rows : []
  }

  private readMessageColumns(store: Wcdb4MessageStore): { name: string; declaration: string }[] {
    const rows = this.executeMessageSql(
      store,
      `PRAGMA table_info(${this.quoteSqlIdentifier(store.tableName)})`
    )
    return rows
      .map((row) => {
        const name = this.pickString(row, ['name'])
        const type = this.pickString(row, ['type']).toUpperCase()
        const declaration = /^(INTEGER|REAL|TEXT|BLOB|NUMERIC)$/.test(type) ? type : 'BLOB'
        return { name, declaration }
      })
      .filter((column) => column.name)
  }

  private ensureRecallJournalTable(
    store: Wcdb4MessageStore,
    columns: { name: string; declaration: string }[]
  ): void {
    const journal = this.quoteSqlIdentifier(this.recallJournalTableName(store.tableName))
    const definitions = columns
      .map((column) => `${this.quoteSqlIdentifier(column.name)} ${column.declaration}`)
      .join(', ')
    this.executeMessageSql(
      store,
      `CREATE TABLE IF NOT EXISTS ${journal} (${definitions}, "_wxe_source_table" TEXT NOT NULL, "_wxe_captured_at" INTEGER NOT NULL)`
    )
  }

  private createRecallJournalTrigger(
    store: Wcdb4MessageStore,
    columns: { name: string; declaration: string }[]
  ): void {
    const table = this.quoteSqlIdentifier(store.tableName)
    const triggerName = this.quoteSqlIdentifier(
      `_wxe_capture_${crypto.createHash('sha1').update(store.tableName).digest('hex').slice(0, 16)}`
    )
    const journal = this.quoteSqlIdentifier(this.recallJournalTableName(store.tableName))
    const targetColumns = [
      ...columns.map((column) => this.quoteSqlIdentifier(column.name)),
      '"_wxe_source_table"',
      '"_wxe_captured_at"'
    ].join(', ')
    const sourceValues = [
      ...columns.map((column) => `OLD.${this.quoteSqlIdentifier(column.name)}`),
      `'${store.tableName.replace(/'/g, "''")}'`,
      `CAST(strftime('%s', 'now') AS INTEGER)`
    ].join(', ')
    this.executeMessageSql(
      store,
      `CREATE TRIGGER IF NOT EXISTS ${triggerName} BEFORE DELETE ON ${table} BEGIN INSERT INTO ${journal} (${targetColumns}) VALUES (${sourceValues}); END`
    )
  }

  private readRecallJournal(
    username: string,
    startTime?: number,
    endTime?: number
  ): Wcdb4Message[] {
    const recoveredRows: Record<string, unknown>[] = []
    for (const store of this.listMessageStores(username)) {
      try {
        const begin = this.normalizeTimestamp(startTime || 0)
        const end = this.normalizeTimestamp(endTime || 0)
        const where = [
          `"_wxe_source_table" = '${store.tableName.replace(/'/g, "''")}'`,
          begin > 0 ? `"create_time" >= ${begin}` : '',
          end > 0 ? `"create_time" <= ${end}` : ''
        ].filter(Boolean)
        const rows = this.executeMessageSql(
          store,
          `SELECT *, 1 AS "_wxe_recovered" FROM ${this.quoteSqlIdentifier(this.recallJournalTableName(store.tableName))} WHERE ${where.join(' AND ')} ORDER BY "create_time" ASC LIMIT 500`
        )
        recoveredRows.push(...rows)
      } catch {
        // The journal is optional until installation has completed for this store.
      }
    }
    return this.finalizeMessages(username, recoveredRows, startTime, endTime)
  }

  private mergeMessageRows(
    current: Wcdb4Message[],
    recovered: Wcdb4Message[],
    limit?: number
  ): Wcdb4Message[] {
    const merged = new Map<string, Wcdb4Message>()
    for (const message of [...recovered, ...current]) {
      const recoveredRow = Boolean(message.raw?.['_wxe_recovered'])
      const serverId = String(message.serverId || '').trim()
      const identity =
        serverId && serverId !== '0'
          ? `server:${serverId}`
          : message.mesLocalID
            ? `local:${message.mesLocalID}:${message.msgCreateTime || 0}`
            : `${message.msgCreateTime}:${message.msgContent}`
      const key = recoveredRow ? `recovered:${identity}` : identity
      merged.set(key, message)
    }
    const messages = Array.from(merged.values()).sort(
      (left, right) =>
        Number(left.msgCreateTime || 0) - Number(right.msgCreateTime || 0) ||
        Number(left.mesLocalID || 0) - Number(right.mesLocalID || 0)
    )
    return limit && messages.length > limit ? messages.slice(-limit) : messages
  }

  private recallJournalTableName(messageTableName: string): string {
    return `_wxe_recall_journal_${crypto
      .createHash('sha1')
      .update(messageTableName)
      .digest('hex')
      .slice(0, 16)}`
  }

  getMyAvatarUrl(): string | undefined {
    const candidates = this.getMyUsernameCandidates()
    this.hydrateAvatarUrls(candidates)

    for (const candidate of candidates) {
      const avatar = this.avatarCache.get(candidate)
      if (avatar) return avatar
    }

    return undefined
  }

  getAvatarUrls(usernames: string[]): Record<string, string> {
    const normalized = this.uniq(usernames)
    this.hydrateAvatarUrls(normalized)
    const result: Record<string, string> = {}
    for (const username of normalized) {
      const avatar = this.avatarCache.get(username)
      if (avatar) result[username] = avatar
    }
    return result
  }

  async getAvatarUrlsAsync(usernames: string[]): Promise<Record<string, string>> {
    const normalized = this.uniq(usernames)
    await this.hydrateAvatarUrlsAsync(normalized)
    const localCandidates = normalized.filter((username) => {
      const avatar = this.avatarCache.get(username)
      return !avatar || !avatar.startsWith('data:')
    })
    if (localCandidates.length && this.wcdbGetHeadImageBuffers) {
      try {
        const buffers = await this.callJsonAsync<Record<string, string>>(
          this.wcdbGetHeadImageBuffers as unknown as KoffiAsyncFunction,
          JSON.stringify(localCandidates)
        )
        for (const [username, hex] of Object.entries(buffers || {})) {
          const avatar = this.avatarHexToDataUrl(hex)
          if (avatar) this.avatarCache.set(username, avatar)
        }
      } catch (error) {
        console.warn('[WCDB4] local avatar fallback failed:', error)
      }
    }

    const result: Record<string, string> = {}
    for (const username of normalized) {
      const avatar = this.avatarCache.get(username)
      if (avatar) result[username] = avatar
    }
    return result
  }

  private avatarHexToDataUrl(value: string): string | undefined {
    const hex = String(value || '').trim()
    if (!hex || hex.length % 2 !== 0 || !/^[a-f0-9]+$/i.test(hex)) return undefined
    const buffer = Buffer.from(hex, 'hex')
    let mime = 'image/jpeg'
    if (buffer.length >= 8 && buffer.subarray(1, 4).toString('ascii') === 'PNG') mime = 'image/png'
    if (
      buffer.length >= 12 &&
      buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buffer.subarray(8, 12).toString('ascii') === 'WEBP'
    ) {
      mime = 'image/webp'
    }
    return `data:${mime};base64,${buffer.toString('base64')}`
  }

  getMyGroupNickname(chatroomId: string): string | undefined {
    const groupNicknames = this.getGroupNicknames(chatroomId)
    for (const candidate of this.getMyUsernameCandidates()) {
      const nickname = groupNicknames.get(candidate)
      if (nickname) return nickname
    }
    return undefined
  }

  private getMessagesByCursor(
    username: string,
    startTime?: number,
    endTime?: number,
    limit?: number
  ): Wcdb4Message[] | null {
    if (
      !this.wcdbOpenMessageCursor ||
      !this.wcdbFetchMessageBatch ||
      !this.wcdbCloseMessageCursor
    ) {
      return null
    }

    const handle = this.ensureHandle()
    const batchSize = limit ? Math.min(500, limit) : 1000
    const cursorOut: WcdbHandleOut = [0]
    const begin = this.normalizeTimestamp(startTime || 0)
    const end = this.normalizeTimestamp(endTime || 0)
    const ascending = limit ? 0 : 1
    const openResult = this.wcdbOpenMessageCursor(
      handle,
      username,
      batchSize,
      ascending,
      begin,
      end,
      cursorOut
    )
    if (openResult !== 0 || cursorOut[0] <= 0) {
      return null
    }

    const cursor = cursorOut[0]
    const allRows: Record<string, unknown>[] = []

    try {
      while (true) {
        const outJson: WcdbVoidOut = [null]
        const outHasMore: [number] = [0]
        const fetchResult = this.wcdbFetchMessageBatch!(handle, cursor, outJson, outHasMore)
        if (fetchResult !== 0 || !outJson[0]) break

        try {
          const json = this.koffi!.decode(outJson[0], 'char', -1)
          const batch = JSON.parse(json) as Record<string, unknown>[]
          if (Array.isArray(batch)) allRows.push(...batch)
        } finally {
          this.wcdbFreeString?.(outJson[0])
        }

        if (!outHasMore[0]) break
        if (limit && allRows.length >= limit) break
      }
    } finally {
      try {
        this.wcdbCloseMessageCursor?.(handle, cursor)
      } catch {
        // Best effort cleanup; a stale cursor is less harmful than blocking UI.
      }
    }

    return this.finalizeMessages(username, allRows, startTime, endTime, limit)
  }

  private finalizeMessages(
    username: string,
    rows: Record<string, unknown>[],
    startTime?: number,
    endTime?: number,
    limit?: number
  ): Wcdb4Message[] {
    const messages = rows.map((row) => this.normalizeMessage(row))

    const sorted = messages
      .filter((message) => {
        const createTime = Number(message.msgCreateTime)
        if (startTime && createTime < startTime) return false
        if (endTime && createTime > endTime) return false
        return true
      })
      .sort((a, b) => Number(a.msgCreateTime) - Number(b.msgCreateTime))

    const visibleMessages = limit && sorted.length > limit ? sorted.slice(-limit) : sorted

    return visibleMessages.map((message) => {
      if (!message.sender) return message
      const senderNickname = this.displayNameCache.get(message.sender) || message.senderNickname
      const senderAvatar = this.avatarCache.get(message.sender) || message.senderAvatar
      const shouldPrefixSender =
        username.endsWith('@chatroom') &&
        message.mesDes === 1 &&
        message.sender &&
        message.msgContent &&
        !message.msgContent.startsWith(`${message.sender}:`)
      return {
        ...message,
        senderNickname,
        senderAvatar,
        msgContent: shouldPrefixSender
          ? `${message.sender}:\n${message.msgContent}`
          : message.msgContent
      }
    })
  }

  private normalizeMessageLimit(limit?: number): number | undefined {
    const normalized = Number(limit)
    if (!Number.isFinite(normalized) || normalized <= 0) return undefined
    return Math.max(1, Math.min(5000, Math.floor(normalized)))
  }

  getGroupMembers(chatroomId: string): Wcdb4GroupMember[] {
    if (!this.wcdbGetGroupMembers || !chatroomId) return []

    try {
      const groupNicknames = this.getGroupNicknames(chatroomId)
      const rows = this.callJson<Record<string, unknown>[]>((handle, outJson) =>
        this.wcdbGetGroupMembers!(handle, chatroomId, outJson)
      )
      const memberRows = Array.isArray(rows) ? rows : []
      const contactNames = this.readContactMemberNames(this.groupMemberUsernames(memberRows))
      const members = this.normalizeGroupMembers(memberRows, groupNicknames, contactNames)
      this.hydrateAvatarUrls(
        members
          .filter((member) => !member.m_nsHeadImgUrl)
          .map((member) => member.m_nsUsrName)
          .filter(Boolean)
      )
      return this.withCachedGroupMemberAvatars(members)
    } catch {
      return []
    }
  }

  private async getMessagesByCursorAsync(
    username: string,
    startTime?: number,
    endTime?: number,
    limit?: number
  ): Promise<Wcdb4Message[]> {
    if (!this.wcdbOpenMessageCursor || !this.wcdbFetchMessageBatch) return []

    const handle = this.ensureHandle()
    const batchSize = limit ? Math.min(500, limit) : 1000
    const cursorOut: WcdbHandleOut = [0]
    const begin = this.normalizeTimestamp(startTime || 0)
    const end = this.normalizeTimestamp(endTime || 0)
    const ascending = limit ? 0 : 1
    const openResult = await this.callAsyncCode(
      this.wcdbOpenMessageCursor as unknown as KoffiAsyncFunction,
      handle,
      username,
      batchSize,
      ascending,
      begin,
      end,
      cursorOut
    )
    if (openResult !== 0 || cursorOut[0] <= 0) return []

    const cursor = cursorOut[0]
    const allRows: Record<string, unknown>[] = []
    try {
      while (true) {
        const outJson: WcdbVoidOut = [null]
        const outHasMore: [number] = [0]
        const fetchResult = await this.callAsyncCode(
          this.wcdbFetchMessageBatch as unknown as KoffiAsyncFunction,
          handle,
          cursor,
          outJson,
          outHasMore
        )
        if (fetchResult !== 0 || !outJson[0]) break
        try {
          const json = this.koffi!.decode(outJson[0], 'char', -1)
          const batch = JSON.parse(json) as Record<string, unknown>[]
          if (Array.isArray(batch)) allRows.push(...batch)
        } finally {
          this.wcdbFreeString?.(outJson[0])
        }
        if (!outHasMore[0] || (limit && allRows.length >= limit)) break
      }
    } finally {
      try {
        this.wcdbCloseMessageCursor?.(handle, cursor)
      } catch {
        // Best-effort cursor cleanup.
      }
    }
    return this.finalizeMessages(username, allRows, startTime, endTime, limit)
  }

  async getGroupMembersAsync(chatroomId: string): Promise<Wcdb4GroupMember[]> {
    if (!this.wcdbGetGroupMembers || !chatroomId) return []

    try {
      const groupNicknames = await this.getGroupNicknamesAsync(chatroomId)
      const rows = await this.callJsonAsync<Record<string, unknown>[]>(
        this.wcdbGetGroupMembers as unknown as KoffiAsyncFunction,
        chatroomId
      )
      const memberRows = Array.isArray(rows) ? rows : []
      const contactNames = await this.readContactMemberNamesAsync(
        this.groupMemberUsernames(memberRows)
      )
      const members = this.normalizeGroupMembers(memberRows, groupNicknames, contactNames)
      const missingAvatars = members
        .filter((member) => !member.m_nsHeadImgUrl)
        .map((member) => member.m_nsUsrName)
        .filter(Boolean)
      await this.hydrateAvatarUrlsAsync(missingAvatars)
      return this.withCachedGroupMemberAvatars(members)
    } catch (error) {
      console.warn(`[WCDB4] async group members failed chatroom=${chatroomId}:`, error)
      return []
    }
  }

  /**
   * 将群成员接口与联系人表组装为语义明确的成员快照。
   *
   * 群昵称只接受群聊数据；微信昵称与通讯录备注只接受 contact 表。即使群成员
   * 接口返回了 nickname，也不能作为名称字段的回退，以免把通讯录备注误展示为微信昵称。
   */
  private normalizeGroupMembers(
    rows: Record<string, unknown>[],
    groupNicknames: Map<string, string>,
    contactNames: Map<string, Wcdb4ContactMemberNames>
  ): Wcdb4GroupMember[] {
    return rows.map((row) => {
      const username = this.pickString(row, [
        'username',
        'userName',
        'user_name',
        'member_username',
        'm_nsUsrName'
      ])
      const rowGroupNickname = this.pickString(row, [
        'groupNickname',
        'group_nickname',
        'displayName',
        'display_name'
      ])
      const groupNickname = groupNicknames.get(username) || rowGroupNickname
      const contact = contactNames.get(username)
      const wechatNickname = contact?.wechatNickname || ''
      const remark = contact?.remark || ''
      const avatar = this.pickString(row, [
        'avatarUrl',
        'avatar_url',
        'headImgUrl',
        'm_nsHeadImgUrl'
      ])

      if (username && avatar) this.avatarCache.set(username, avatar)

      return {
        m_nsUsrName: username,
        // nickname 是旧调用方使用的通用显示字段，保持安全的名称优先级。
        nickname: wechatNickname || groupNickname || username,
        groupNickname,
        wechatNickname,
        remark,
        m_nsHeadImgUrl: avatar
      }
    })
  }

  /**
   * 从原始群成员行提取联系人查询键，避免把空值传进 SQL IN 条件。
   */
  private groupMemberUsernames(rows: Record<string, unknown>[]): string[] {
    return rows
      .map((row) =>
        this.pickString(row, [
          'username',
          'userName',
          'user_name',
          'member_username',
          'm_nsUsrName'
        ])
      )
      .filter(Boolean)
  }

  /**
   * 为已标准化的成员补充头像缓存，不参与名称字段的回退。
   */
  private withCachedGroupMemberAvatars(members: Wcdb4GroupMember[]): Wcdb4GroupMember[] {
    return members.map((member) => ({
      ...member,
      m_nsHeadImgUrl: member.m_nsHeadImgUrl || this.avatarCache.get(member.m_nsUsrName) || ''
    }))
  }

  getGroupNicknames(chatroomId: string): Map<string, string> {
    const cached = this.groupNicknameCache.get(chatroomId)
    if (cached) return cached

    const nicknames = new Map<string, string>()
    if (!this.wcdbGetGroupNicknames || !chatroomId) return nicknames

    try {
      const rows = this.callJson<Record<string, string> | Record<string, unknown>[]>(
        (handle, outJson) => this.wcdbGetGroupNicknames!(handle, chatroomId, outJson)
      )
      this.readStringMap(rows, [
        'nickname',
        'nickName',
        'displayName',
        'display_name',
        'groupNickname',
        'group_nickname',
        'name'
      ]).forEach((nickname, username) => nicknames.set(username, nickname))
      this.groupNicknameCache.set(chatroomId, nicknames)
    } catch (error) {
      console.warn(`[WCDB4] failed to get group nicknames for ${chatroomId}:`, error)
    }

    return nicknames
  }

  private async getGroupNicknamesAsync(chatroomId: string): Promise<Map<string, string>> {
    const cached = this.groupNicknameCache.get(chatroomId)
    if (cached) return cached
    const nicknames = new Map<string, string>()
    if (!this.wcdbGetGroupNicknames || !chatroomId) return nicknames

    const rows = await this.callJsonAsync<Record<string, string> | Record<string, unknown>[]>(
      this.wcdbGetGroupNicknames as unknown as KoffiAsyncFunction,
      chatroomId
    )
    this.readStringMap(rows, [
      'nickname',
      'nickName',
      'displayName',
      'display_name',
      'groupNickname',
      'group_nickname',
      'name'
    ]).forEach((nickname, username) => nicknames.set(username, nickname))
    this.groupNicknameCache.set(chatroomId, nicknames)
    return nicknames
  }

  async getVoiceData(
    sessionId: string,
    createTime: number,
    candidates: string[],
    localId: number = 0,
    svrId: string | number = 0
  ): Promise<{ success: boolean; hex?: string; error: string }> {
    if (!this.wcdbGetVoiceData) {
      return { success: false, error: '当前 DLL 版本不支持获取语音数据' }
    }

    const handle = this.ensureHandle()
    const outHex: WcdbVoidOut = [null]

    try {
      const result = this.wcdbGetVoiceData(
        handle,
        sessionId,
        createTime,
        localId,
        BigInt(svrId || 0),
        JSON.stringify(candidates),
        outHex
      )

      if (result !== 0 || !outHex[0]) {
        return { success: false, error: `获取语音数据失败: ${result}` }
      }

      const hex = this.decodeHexPtr(outHex[0])
      if (hex === null) {
        return { success: false, error: '解析语音数据失败' }
      }

      return { success: true, hex, error: '' }
    } finally {
      this.wcdbFreeString?.(outHex[0])
    }
  }

  private decodeHexPtr(ptr: unknown): string | null {
    if (!ptr || !this.koffi) return null
    try {
      const hex = this.koffi.decode(ptr, 'char', -1)
      return typeof hex === 'string' ? hex : null
    } catch {
      return null
    }
  }

  getUsernameByMd5(md5: string): string | undefined {
    return this.getSessions().find((session) => this.md5(session.username) === md5)?.username
  }

  getAccountRoot(): string {
    return this.accountRoot
  }

  getKey(): string {
    return this.key
  }

  resolveImageHardlink(md5: string): Wcdb4ImageHardlink | null {
    if (!this.wcdbResolveImageHardlink) return null
    const normalizedMd5 = String(md5 || '')
      .trim()
      .toLowerCase()
    if (!normalizedMd5) return null

    try {
      return this.callJson<Wcdb4ImageHardlink>((handle, outJson) =>
        this.wcdbResolveImageHardlink!(handle, normalizedMd5, this.nativeAccountRoot, outJson)
      )
    } catch (error) {
      console.warn('[WCDB4] resolve image hardlink failed:', error)
      return null
    }
  }

  async resolveImageHardlinkAsync(md5: string): Promise<Wcdb4ImageHardlink | null> {
    if (!this.wcdbResolveImageHardlink) return null
    const normalizedMd5 = String(md5 || '')
      .trim()
      .toLowerCase()
    if (!normalizedMd5) return null

    try {
      return await this.callJsonAsync<Wcdb4ImageHardlink>(
        this.wcdbResolveImageHardlink as unknown as KoffiAsyncFunction,
        normalizedMd5,
        this.nativeAccountRoot
      )
    } catch (error) {
      console.warn('[WCDB4] async image hardlink resolve failed:', error)
      return null
    }
  }

  resolveVideoHardlink(md5: string, dbPath: string): Wcdb4VideoHardlink | null {
    if (!this.wcdbResolveVideoHardlink) return null
    const normalizedMd5 = String(md5 || '')
      .trim()
      .toLowerCase()
    if (!/^[a-f0-9]{32}$/.test(normalizedMd5) || !dbPath) return null

    try {
      return this.callJson<Wcdb4VideoHardlink>((handle, outJson) =>
        this.wcdbResolveVideoHardlink!(handle, normalizedMd5, dbPath, outJson)
      )
    } catch (error) {
      console.warn('[WCDB4] resolve video hardlink failed:', error)
      return null
    }
  }

  resolveEmoticonCdnUrl(md5: string): string | undefined {
    if (!this.wcdbGetEmoticonCdnUrl) {
      console.warn(`[WCDB4] wcdb_get_emoticon_cdn_url unavailable for md5=${md5}`)
      return undefined
    }
    const normalizedMd5 = String(md5 || '')
      .trim()
      .toLowerCase()
    if (!/^[a-f0-9]{32}$/.test(normalizedMd5)) return undefined

    const dbPath = this.findEmoticonDb()
    if (!dbPath) {
      console.warn(`[WCDB4] emoticon.db not found for md5=${normalizedMd5}`)
      return undefined
    }

    const outUrl: WcdbVoidOut = [null]
    try {
      const result = this.wcdbGetEmoticonCdnUrl(this.ensureHandle(), dbPath, normalizedMd5, outUrl)
      if (result !== 0 || !outUrl[0] || !this.koffi) {
        console.warn(
          `[WCDB4] emoticon CDN URL lookup miss: result=${result}; md5=${normalizedMd5}; db=${dbPath}`
        )
        return undefined
      }
      const url = this.koffi.decode(outUrl[0], 'char', -1).trim()
      return url || undefined
    } catch (error) {
      console.warn('[WCDB4] resolve emoticon CDN URL failed:', error)
      return undefined
    } finally {
      this.wcdbFreeString?.(outUrl[0])
    }
  }

  md5(value: string): string {
    return crypto.createHash('md5').update(value).digest('hex')
  }

  private loadNativeLibrary(): void {
    if (this.koffi) return

    const koffi = nodeRequire('koffi') as KoffiModule
    this.koffi = koffi

    const libPath = this.findNativeLibrary()
    const libDir = path.dirname(libPath)
    console.log(
      `[WCDB4] loadNativeLibrary platform=${process.platform} arch=${process.arch} libPath=${libPath} cwd=${process.cwd()} resourcesPath=${process.resourcesPath || ''} WCDB_RESOURCES_PATH=${process.env.WCDB_RESOURCES_PATH || ''}`
    )

    // Reuse the module-level bootstrap if main.ts already performed
    // InitProtection + wcdb_init; WCDB returns -1006 if wcdb_init is called
    // twice in the same process.
    let lib: KoffiLibrary
    if (wcdbBootstrapLib) {
      console.log('[WCDB4] reusing bootstrap lib, skip koffi.load and wcdb_init')
      lib = wcdbBootstrapLib
    } else {
      const preloadLibraries =
        process.platform === 'win32'
          ? ['WCDB.dll', 'SDL2.dll']
          : process.platform === 'darwin'
            ? ['libWCDB.dylib']
            : []
      for (const name of preloadLibraries) {
        const preloadPath = path.join(libDir, name)
        if (!fs.existsSync(preloadPath)) continue
        try {
          koffi.load(preloadPath)
          console.log(`[WCDB4] preload ok ${preloadPath}`)
        } catch {
          console.warn(`[WCDB4] preload failed ${preloadPath}`)
          // Some builds resolve dependencies through the platform loader path.
        }
      }

      console.log(`[WCDB4] koffi.load begin ${libPath}`)
      lib = koffi.load(libPath)
      console.log(`[WCDB4] koffi.load ok ${libPath}`)
      this.initProtection(lib, libDir)
      const wcdbInit = lib.func('int32 wcdb_init()') as () => number
      console.log('[WCDB4] wcdb_init begin')
      const initResult = wcdbInit()
      console.log(`[WCDB4] wcdb_init rc=${initResult}`)
      if (initResult !== 0) {
        console.warn(`[WCDB4] wcdb_init 返回 ${initResult}，继续尝试 wcdb_open_account`)
      }
    }

    this.wcdbShutdown = lib.func('int32 wcdb_shutdown()') as () => number
    const openAccount = lib.func(
      'int32 wcdb_open_account(const char* path, const char* key, _Out_ int64* handle)'
    ) as (sessionDbPath: string, key: string, handleOut: WcdbHandleOut) => number
    this.wcdbOpenAccount = openAccount
    this.wcdbOpenAccountAsync = openAccount as unknown as KoffiAsyncFunction
    this.wcdbFreeString = lib.func('void wcdb_free_string(void* ptr)') as (ptr: unknown) => void
    this.wcdbGetSessions = lib.func(
      'int32 wcdb_get_sessions(int64 handle, _Out_ void** outJson)'
    ) as (handle: number, outJson: WcdbVoidOut) => number
    this.wcdbGetMessages = lib.func(
      'int32 wcdb_get_messages(int64 handle, const char* username, int32 limit, int32 offset, _Out_ void** outJson)'
    ) as (
      handle: number,
      username: string,
      limit: number,
      offset: number,
      outJson: WcdbVoidOut
    ) => number
    try {
      this.wcdbGetMessageTableStats = lib.func(
        'int32 wcdb_get_message_table_stats(int64 handle, const char* sessionId, _Out_ void** outJson)'
      ) as (handle: number, username: string, outJson: WcdbVoidOut) => number
    } catch {
      this.wcdbGetMessageTableStats = null
    }
    this.wcdbGetDisplayNames = lib.func(
      'int32 wcdb_get_display_names(int64 handle, const char* usernamesJson, _Out_ void** outJson)'
    ) as (handle: number, usernamesJson: string, outJson: WcdbVoidOut) => number

    try {
      this.wcdbSetMyWxid = lib.func('int32 wcdb_set_my_wxid(int64 handle, const char* wxid)') as (
        handle: number,
        wxid: string
      ) => number
    } catch {
      this.wcdbSetMyWxid = null
    }

    try {
      this.wcdbGetAvatarUrls = lib.func(
        'int32 wcdb_get_avatar_urls(int64 handle, const char* usernamesJson, _Out_ void** outJson)'
      ) as (handle: number, usernamesJson: string, outJson: WcdbVoidOut) => number
    } catch {
      this.wcdbGetAvatarUrls = null
    }

    try {
      this.wcdbGetContactStatus = lib.func(
        'int32 wcdb_get_contact_status(int64 handle, const char* usernamesJson, _Out_ void** outJson)'
      ) as (handle: number, usernamesJson: string, outJson: WcdbVoidOut) => number
    } catch {
      this.wcdbGetContactStatus = null
    }

    try {
      this.wcdbGetHeadImageBuffers = lib.func(
        'int32 wcdb_get_head_image_buffers(int64 handle, const char* usernamesJson, _Out_ void** outJson)'
      ) as (handle: number, usernamesJson: string, outJson: WcdbVoidOut) => number
    } catch {
      this.wcdbGetHeadImageBuffers = null
    }

    try {
      this.wcdbExecQuery = lib.func(
        'int32 wcdb_exec_query(int64 handle, const char* kind, const char* path, const char* sql, _Out_ void** outJson)'
      ) as (
        handle: number,
        kind: string,
        dbPath: string,
        sql: string,
        outJson: WcdbVoidOut
      ) => number
    } catch {
      this.wcdbExecQuery = null
    }

    try {
      this.wcdbGetGroupMembers = lib.func(
        'int32 wcdb_get_group_members(int64 handle, const char* chatroomId, _Out_ void** outJson)'
      ) as (handle: number, chatroomId: string, outJson: WcdbVoidOut) => number
    } catch {
      this.wcdbGetGroupMembers = null
    }

    try {
      this.wcdbGetGroupNicknames = lib.func(
        'int32 wcdb_get_group_nicknames(int64 handle, const char* chatroomId, _Out_ void** outJson)'
      ) as (handle: number, chatroomId: string, outJson: WcdbVoidOut) => number
    } catch {
      this.wcdbGetGroupNicknames = null
    }

    try {
      this.wcdbOpenMessageCursor = lib.func(
        'int32 wcdb_open_message_cursor(int64 handle, const char* sessionId, int32 batchSize, int32 ascending, int32 beginTimestamp, int32 endTimestamp, _Out_ int64* outCursor)'
      ) as (
        handle: number,
        username: string,
        batchSize: number,
        ascending: number,
        beginTimestamp: number,
        endTimestamp: number,
        cursorOut: WcdbHandleOut
      ) => number
      this.wcdbFetchMessageBatch = lib.func(
        'int32 wcdb_fetch_message_batch(int64 handle, int64 cursor, _Out_ void** outJson, _Out_ int32* outHasMore)'
      ) as (handle: number, cursor: number, outJson: WcdbVoidOut, outHasMore: [number]) => number
      this.wcdbCloseMessageCursor = lib.func(
        'int32 wcdb_close_message_cursor(int64 handle, int64 cursor)'
      ) as (handle: number, cursor: number) => number
    } catch {
      this.wcdbOpenMessageCursor = null
      this.wcdbFetchMessageBatch = null
      this.wcdbCloseMessageCursor = null
    }

    try {
      this.wcdbGetVoiceData = lib.func(
        'int32 wcdb_get_voice_data(int64 handle, const char* sessionId, int32 createTime, int32 localId, int64 svrId, const char* candidatesJson, _Out_ void** outHex)'
      ) as (
        handle: number,
        sessionId: string,
        createTime: number,
        localId: number,
        svrId: bigint,
        candidatesJson: string,
        outHex: WcdbVoidOut
      ) => number
    } catch {
      this.wcdbGetVoiceData = null
    }

    try {
      this.wcdbResolveImageHardlink = lib.func(
        'int32 wcdb_resolve_image_hardlink(int64 handle, const char* md5, const char* accountDir, _Out_ void** outJson)'
      ) as (handle: number, md5: string, accountDir: string, outJson: WcdbVoidOut) => number
    } catch {
      this.wcdbResolveImageHardlink = null
    }

    try {
      this.wcdbResolveVideoHardlink = lib.func(
        'int32 wcdb_resolve_video_hardlink_md5(int64 handle, const char* md5, const char* dbPath, _Out_ void** outJson)'
      ) as (handle: number, md5: string, dbPath: string, outJson: WcdbVoidOut) => number
    } catch {
      this.wcdbResolveVideoHardlink = null
    }

    try {
      this.wcdbGetEmoticonCdnUrl = lib.func(
        'int32 wcdb_get_emoticon_cdn_url(int64 handle, const char* dbPath, const char* md5, _Out_ void** outUrl)'
      ) as (handle: number, dbPath: string, md5: string, outUrl: WcdbVoidOut) => number
    } catch {
      console.warn('[WCDB4] wcdb_get_emoticon_cdn_url symbol unavailable')
      this.wcdbGetEmoticonCdnUrl = null
    }

    try {
      this.wcdbStartMonitorPipe = lib.func('int32 wcdb_start_monitor_pipe()') as () => number
      this.wcdbStopMonitorPipe = lib.func('void wcdb_stop_monitor_pipe()') as () => void
      this.wcdbGetMonitorPipeName = lib.func(
        'int32 wcdb_get_monitor_pipe_name(_Out_ void** outName)'
      ) as (outName: WcdbVoidOut) => number
    } catch {
      console.warn('[WCDB4] monitor pipe symbols unavailable')
      this.wcdbStartMonitorPipe = null
      this.wcdbStopMonitorPipe = null
      this.wcdbGetMonitorPipeName = null
    }
  }

  private initProtection(lib: KoffiLibrary, libDir: string): void {
    const initProtection = lib.func('int32 InitProtection(const char* resourcePath)') as (
      resourcePath: string
    ) => number

    const resourceRoots = Array.from(
      new Set(
        [
          libDir,
          path.dirname(libDir),
          process.env.WCDB_RESOURCES_PATH || '',
          ...getResourceRoots()
        ].filter(Boolean)
      )
    )

    let lastCode = -1
    for (const resourceRoot of resourceRoots) {
      try {
        console.log(`[WCDB4] InitProtection call ${resourceRoot}`)
        lastCode = initProtection(resourceRoot)
        console.log(`[WCDB4] InitProtection rc=${lastCode} path=${resourceRoot}`)
        if (lastCode === 0) {
          console.log(`[WCDB4] InitProtection ok path=${resourceRoot}`)
          return
        }
      } catch (error) {
        console.warn(`[WCDB4] InitProtection exception path=${resourceRoot}`, error)
        // Try next candidate.
      }
    }

    console.warn(
      `[WCDB4] InitProtection 返回 ${lastCode}，继续尝试 wcdb_init/open; tried=${resourceRoots.join(' | ')}`
    )
  }

  private findNativeLibrary(): string {
    return Wcdb4Client.resolveNativeLibrary()
  }

  static resolveNativeLibrary(): string {
    const libName =
      process.platform === 'darwin'
        ? 'libwcdb_api.dylib'
        : process.platform === 'linux'
          ? 'libwcdb_api.so'
          : 'wcdb_api.dll'
    const platformDir =
      process.platform === 'darwin'
        ? 'macos'
        : process.platform === 'win32'
          ? 'win32'
          : process.platform
    const archDir = process.arch === 'arm64' ? 'arm64' : 'x64'
    const resourceRoots = getResourceRoots()
    const candidates = [
      process.env.WCDB_DLL_PATH,
      ...resourceRoots.flatMap((root) => [
        path.join(root, 'wcdb', platformDir, archDir, libName),
        path.join(root, 'wcdb', platformDir, 'x64', libName),
        path.join(root, platformDir, libName),
        path.join(root, libName)
      ])
    ].filter(Boolean) as string[]

    const found = candidates.find((candidate) => fs.existsSync(candidate))
    if (!found) {
      throw new Error(`找不到 WCDB native 库: ${candidates.join(', ')}`)
    }
    if (process.platform === 'win32') {
      const runtimeDir = resourceRoots
        .map((root) => path.join(root, 'runtime', 'win32'))
        .find((candidate) => fs.existsSync(candidate))
      const dllDir = path.dirname(found)
      process.env.PATH = [dllDir, runtimeDir || '', process.env.PATH || '']
        .filter(Boolean)
        .join(path.delimiter)
    }
    return found
  }

  private findSessionDb(): string {
    const direct = path.join(this.dbStoragePath, 'session', 'session.db')
    if (fs.existsSync(direct)) return direct
    return this.findFile(this.dbStoragePath, 'session.db') || ''
  }

  private findEmoticonDb(): string {
    const candidates = [
      path.join(this.dbStoragePath, 'emoticon', 'emoticon.db'),
      path.join(this.dbStoragePath, 'emotion', 'emoticon.db'),
      path.join(this.nativeAccountRoot, this.wxid, 'db_storage', 'emoticon', 'emoticon.db'),
      path.join(this.nativeAccountRoot, this.wxid, 'db_storage', 'emotion', 'emoticon.db')
    ]
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate
    }
    return this.findFile(this.dbStoragePath, 'emoticon.db') || ''
  }

  private findFile(dir: string, filename: string, depth = 0): string | null {
    if (!fs.existsSync(dir) || depth > 5) return null

    const entries = fs.readdirSync(dir)
    for (const entry of entries) {
      const fullPath = path.join(dir, entry)
      if (entry.toLowerCase() === filename.toLowerCase() && fs.statSync(fullPath).isFile()) {
        return fullPath
      }
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry)
      if (fs.statSync(fullPath).isDirectory()) {
        const found = this.findFile(fullPath, filename, depth + 1)
        if (found) return found
      }
    }

    return null
  }

  private callJson<T>(call: (handle: number, outJson: WcdbVoidOut) => number): T {
    const handle = this.ensureHandle()
    const outJson: WcdbVoidOut = [null]
    const result = call(handle, outJson)
    if (result !== 0 || !outJson[0]) {
      throw new Error(`WCDB 调用失败，错误码: ${result}`)
    }

    try {
      const json = this.koffi!.decode(outJson[0], 'char', -1)
      return JSON.parse(json) as T
    } finally {
      this.wcdbFreeString?.(outJson[0])
    }
  }

  private callJsonAsync<T>(fn: KoffiAsyncFunction, ...args: unknown[]): Promise<T> {
    const handle = this.ensureHandle()
    const outJson: WcdbVoidOut = [null]
    return this.createTrackedNativeCall<T>((resolve, reject) => {
      fn.async(handle, ...args, outJson, (error: unknown, result: unknown) => {
        if (error) {
          reject(error)
          return
        }
        const code = Number(result)
        if (code !== 0 || !outJson[0]) {
          reject(new Error(`WCDB async call failed, code: ${code}`))
          return
        }
        try {
          const json = this.koffi!.decode(outJson[0], 'char', -1)
          resolve(JSON.parse(json) as T)
        } catch (decodeError) {
          reject(decodeError)
        } finally {
          this.wcdbFreeString?.(outJson[0])
        }
      })
    })
  }

  private callAsyncCode(fn: KoffiAsyncFunction, ...args: unknown[]): Promise<number> {
    return this.createTrackedNativeCall<number>((resolve, reject) => {
      fn.async(...args, (error: unknown, result: unknown) => {
        if (error) reject(error)
        else resolve(Number(result))
      })
    })
  }

  private createTrackedNativeCall<T>(
    executor: (resolve: (value: T) => void, reject: (reason?: unknown) => void) => void
  ): Promise<T> {
    if (this.closing) return Promise.reject(new Error('微信数据库正在关闭'))
    const promise = new Promise<T>(executor)
    this.nativeCallsInFlight.add(promise)
    void promise.then(
      () => this.nativeCallsInFlight.delete(promise),
      () => this.nativeCallsInFlight.delete(promise)
    )
    return promise
  }

  private ensureHandle(): number {
    if (this.closing) throw new Error('微信数据库正在关闭')
    if (!this.handle) throw new Error('微信 4.0 数据库未打开')
    return this.handle
  }

  private normalizeSession(row: Record<string, unknown>): Wcdb4Session {
    const username = this.pickString(row, [
      'username',
      'user_name',
      'userName',
      'usrName',
      'UsrName',
      'talker',
      'talker_id',
      'talkerId',
      'sessionId',
      'session_id'
    ])
    const nickname = this.pickString(row, [
      'nickname',
      'nickName',
      'displayName',
      'display_name',
      'remark',
      'name'
    ])
    const wechatNickname = this.pickString(row, [
      'wechatNickname',
      'wechat_nickname',
      'nickname',
      'nickName',
      'name'
    ])
    const remark = this.pickString(row, [
      'remark',
      'remarkName',
      'remark_name',
      'contactRemark',
      'contact_remark'
    ])
    const status = this.sessionStatusCache.get(username)
    return {
      username,
      nickname,
      wechatNickname,
      remark,
      isFolded: status?.isFolded,
      isMuted: status?.isMuted,
      raw: row
    }
  }

  private normalizeMessage(row: Record<string, unknown>): Wcdb4Message {
    const contentRaw = this.pickValue(row, [
      'message_content',
      'messageContent',
      'content',
      'msg_content',
      'msgContent',
      'WCDB_CT_message_content'
    ])
    const compressRaw = this.pickValue(row, [
      'compress_content',
      'compressContent',
      'compressed_content',
      'msg_compress_content',
      'msgCompressContent',
      'WCDB_CT_compress_content',
      'WCDB_CT_compressContent'
    ])
    const content = this.decodeMessageContent(contentRaw, compressRaw)
    const sender = this.pickString(row, [
      'sender_username',
      'senderUsername',
      'sender',
      'fromUsername',
      'from_username',
      'WCDB_CT_sender_username'
    ])
    const createTime = this.pickNumber(row, [
      'create_time',
      'createTime',
      'msg_create_time',
      'msgCreateTime',
      'time',
      'WCDB_CT_create_time'
    ])
    const localId = this.pickString(row, [
      'local_id',
      'localId',
      'msg_local_id',
      'msgLocalId',
      'mesLocalID',
      'id'
    ])
    const serverId = this.pickString(row, [
      'server_id',
      'serverId',
      'svr_id',
      'svrId',
      'msg_svr_id',
      'msgSvrId',
      'message_id',
      'messageId',
      'new_msg_id',
      'newMsgId',
      'WCDB_CT_server_id'
    ])
    const messageType = this.pickString(row, [
      'local_type',
      'localType',
      'message_type',
      'messageType',
      'msg_type',
      'msgType',
      'type',
      'WCDB_CT_local_type'
    ])
    const isSend = this.pickBoolean(row, [
      'computed_is_send',
      'computedIsSend',
      'is_send',
      'isSend',
      'mesDes',
      'WCDB_CT_is_send'
    ])

    return {
      mesLocalID: localId || `${createTime}-${this.md5(JSON.stringify(row))}`,
      serverId: serverId || undefined,
      mesDes: isSend ? 0 : 1,
      messageType: messageType || '1',
      msgCreateTime: String(createTime),
      msgContent: content,
      sender,
      senderNickname: sender ? this.displayNameCache.get(sender) : undefined,
      senderAvatar: sender ? this.avatarCache.get(sender) : undefined,
      raw: row
    }
  }

  private shouldHydrateSessionDisplayName(session: Wcdb4Session): boolean {
    const username = String(session.username || '').trim()
    const nickname = String(session.nickname || '').trim()
    if (!username) return false
    if (!nickname) return true
    if (nickname === username) return true
    if (nickname.endsWith('@chatroom')) return true
    if (nickname.startsWith('Group_') || nickname.startsWith('Unknown_')) return true
    return false
  }

  private async hydrateDisplayNamesAsync(usernames: string[]): Promise<void> {
    if (!this.wcdbGetDisplayNames) return
    const missing = this.uniq(usernames).filter((username) => !this.displayNameCache.has(username))
    if (missing.length === 0) return
    try {
      const rows = await this.callJsonAsync<Record<string, string> | Record<string, unknown>[]>(
        this.wcdbGetDisplayNames as unknown as KoffiAsyncFunction,
        JSON.stringify(missing)
      )
      this.readStringMap(rows, [
        'nickname',
        'displayName',
        'display_name',
        'remark',
        'name'
      ]).forEach((name, username) => this.displayNameCache.set(username, name))
    } catch {
      // Names are optional; usernames remain usable.
    }
  }

  private async ensureSessionDisplayNamesAsync(): Promise<void> {
    if (this.sessionDisplayNamesHydrated || !this.cachedSessions) return
    if (this.sessionDisplayNamesInFlight) return this.sessionDisplayNamesInFlight

    const generation = this.sessionCacheGeneration
    const sessions = this.cachedSessions
    const request = (async (): Promise<void> => {
      await this.hydrateDisplayNamesAsync(
        sessions
          .filter((session) => this.shouldHydrateSessionDisplayName(session))
          .map((session) => session.username)
      )
      if (generation !== this.sessionCacheGeneration || this.cachedSessions !== sessions) return
      this.cachedSessions = sessions.map((session) => ({
        ...session,
        nickname:
          this.displayNameCache.get(session.username) || session.nickname || session.username
      }))
      this.sessionDisplayNamesHydrated = true
    })()
    this.sessionDisplayNamesInFlight = request
    try {
      await request
    } finally {
      if (this.sessionDisplayNamesInFlight === request) this.sessionDisplayNamesInFlight = null
    }
  }

  private hydrateAvatarUrls(usernames: string[]): void {
    const missing = this.uniq(usernames).filter((username) => !this.avatarCache.has(username))
    if (missing.length === 0) return

    if (this.wcdbGetAvatarUrls) {
      try {
        const rows = this.callJson<Record<string, string> | Record<string, unknown>[]>(
          (handle, outJson) => this.wcdbGetAvatarUrls!(handle, JSON.stringify(missing), outJson)
        )
        this.readStringMap(rows, [
          'avatarUrl',
          'avatar_url',
          'headImgUrl',
          'm_nsHeadImgUrl',
          'big_head_img_url',
          'small_head_img_url'
        ]).forEach((avatar, username) => this.avatarCache.set(username, avatar))
      } catch {
        // Try the contact database below.
      }
    }

    const stillMissing = missing.filter((username) => !this.avatarCache.has(username))
    if (stillMissing.length === 0) return

    try {
      this.readContactAvatarUrls(stillMissing).forEach((avatar, username) =>
        this.avatarCache.set(username, avatar)
      )
    } catch {
      // Avatars are optional.
    }
  }

  private async hydrateAvatarUrlsAsync(usernames: string[]): Promise<void> {
    if (!this.wcdbGetAvatarUrls) return
    const missing = this.uniq(usernames).filter((username) => !this.avatarCache.has(username))
    if (missing.length === 0) return
    try {
      const rows = await this.callJsonAsync<Record<string, string> | Record<string, unknown>[]>(
        this.wcdbGetAvatarUrls as unknown as KoffiAsyncFunction,
        JSON.stringify(missing)
      )
      this.readStringMap(rows, [
        'avatarUrl',
        'avatar_url',
        'headImgUrl',
        'm_nsHeadImgUrl',
        'big_head_img_url',
        'small_head_img_url'
      ]).forEach((avatar, username) => this.avatarCache.set(username, avatar))
    } catch {
      // Avatars are optional.
    }
  }

  /**
   * 从 contact 表读取群成员的微信昵称与通讯录备注。
   *
   * 查询失败时返回空映射：群成员快照仍可用，并由调用方回退到群昵称或 wxid；
   * 不得使用群成员接口的 nickname，因为该字段可能实际保存的是通讯录备注。
   */
  private readContactMemberNames(usernames: string[]): Map<string, Wcdb4ContactMemberNames> {
    const result = new Map<string, Wcdb4ContactMemberNames>()
    if (!this.wcdbExecQuery || usernames.length === 0) return result

    const inList = this.uniq(usernames)
      .map((username) => `'${username.replace(/'/g, "''")}'`)
      .join(',')
    if (!inList) return result

    try {
      const rows = this.callJson<Record<string, unknown>[]>((handle, outJson) =>
        this.wcdbExecQuery!(
          handle,
          'contact',
          '',
          `SELECT username, nick_name, remark FROM contact WHERE username IN (${inList})`,
          outJson
        )
      )
      return this.contactMemberNamesFromRows(rows)
    } catch {
      return result
    }
  }

  /**
   * 异步读取 contact 表的成员名称字段，语义与同步路径保持一致。
   */
  private async readContactMemberNamesAsync(
    usernames: string[]
  ): Promise<Map<string, Wcdb4ContactMemberNames>> {
    const result = new Map<string, Wcdb4ContactMemberNames>()
    if (!this.wcdbExecQuery || usernames.length === 0) return result

    const inList = this.uniq(usernames)
      .map((username) => `'${username.replace(/'/g, "''")}'`)
      .join(',')
    if (!inList) return result

    try {
      const rows = await this.callJsonAsync<Record<string, unknown>[]>(
        this.wcdbExecQuery as unknown as KoffiAsyncFunction,
        'contact',
        '',
        `SELECT username, nick_name, remark FROM contact WHERE username IN (${inList})`
      )
      return this.contactMemberNamesFromRows(rows)
    } catch {
      return result
    }
  }

  /**
   * 将 contact 查询行转换为按 wxid 索引的名称映射。
   */
  private contactMemberNamesFromRows(
    rows: Record<string, unknown>[]
  ): Map<string, Wcdb4ContactMemberNames> {
    const result = new Map<string, Wcdb4ContactMemberNames>()
    if (!Array.isArray(rows)) return result

    for (const row of rows) {
      const username = this.pickString(row, ['username', 'user_name', 'userName', 'm_nsUsrName'])
      if (!username) continue
      result.set(username, {
        wechatNickname: this.pickString(row, ['nick_name', 'nickName', 'm_nsNickName']),
        remark: this.pickString(row, ['remark', 'remark_name', 'remarkName'])
      })
    }

    return result
  }

  private readContactAvatarUrls(usernames: string[]): Map<string, string> {
    const result = new Map<string, string>()
    if (!this.wcdbExecQuery || usernames.length === 0) return result

    const inList = this.uniq(usernames)
      .map((username) => `'${username.replace(/'/g, "''")}'`)
      .join(',')
    if (!inList) return result

    const sql = `SELECT * FROM contact WHERE username IN (${inList})`
    const rows = this.callJson<Record<string, unknown>[]>((handle, outJson) =>
      this.wcdbExecQuery!(handle, 'contact', '', sql, outJson)
    )

    if (!Array.isArray(rows)) return result

    for (const row of rows) {
      const username = this.pickString(row, ['username', 'user_name', 'userName'])
      const avatar = this.pickString(row, [
        'big_head_img_url',
        'bigHeadImgUrl',
        'bigHeadUrl',
        'big_head_url',
        'small_head_img_url',
        'smallHeadImgUrl',
        'smallHeadUrl',
        'small_head_url',
        'head_img_url',
        'headImgUrl',
        'avatar_url',
        'avatarUrl'
      ])
      if (username && avatar) result.set(username, avatar)
    }

    return result
  }

  private readStringMap(
    rows: Record<string, string> | Record<string, unknown>[],
    valueKeys: string[]
  ): Map<string, string> {
    const result = new Map<string, string>()

    if (Array.isArray(rows)) {
      for (const row of rows) {
        const username = this.pickString(row, ['username', 'userName', 'user_name', 'm_nsUsrName'])
        const value = this.pickString(row, valueKeys)
        if (username && value) result.set(username, value)
      }
      return result
    }

    for (const [username, value] of Object.entries(rows || {})) {
      if (username && value) result.set(username, String(value))
    }

    return result
  }

  private pickString(row: Record<string, unknown>, keys: string[]): string {
    for (const key of keys) {
      const value = this.pickValue(row, [key])
      if (typeof value === 'string' && value.trim()) return value.trim()
      if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    }
    return ''
  }

  private pickValue(row: Record<string, unknown>, keys: string[]): unknown {
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(row, key)) return row[key]
      const foundKey = Object.keys(row).find(
        (candidate) => candidate.toLowerCase() === key.toLowerCase()
      )
      if (foundKey) return row[foundKey]
    }
    return undefined
  }

  private decodeMessageContent(messageContent: unknown, compressContent: unknown): string {
    const compressed = this.decodeMaybeCompressed(compressContent)
    if (compressed) return compressed
    return this.decodeMaybeCompressed(messageContent)
  }

  private decodeMaybeCompressed(raw: unknown): string {
    if (raw === null || raw === undefined) return ''
    if (Buffer.isBuffer(raw)) return this.decodeBinaryContent(raw)
    if (raw instanceof Uint8Array) return this.decodeBinaryContent(Buffer.from(raw))
    if (Array.isArray(raw)) return this.decodeBinaryContent(Buffer.from(raw))

    if (typeof raw === 'number') return Number.isFinite(raw) ? String(raw) : ''
    if (typeof raw !== 'string') {
      const data = (raw as { data?: unknown })?.data
      if (Array.isArray(data)) return this.decodeBinaryContent(Buffer.from(data))
      return ''
    }

    const trimmed = raw.trim()
    if (!trimmed) return ''
    if (/^[0-9]+$/.test(trimmed)) return trimmed

    if (trimmed.length > 16 && this.looksLikeHex(trimmed)) {
      try {
        const decoded = this.decodeBinaryContent(Buffer.from(trimmed, 'hex'))
        if (decoded) return decoded
      } catch {
        // Fall back to the original string below.
      }
    }

    if (trimmed.length > 16 && this.looksLikeBase64(trimmed)) {
      try {
        const decoded = this.decodeBinaryContent(Buffer.from(trimmed, 'base64'))
        if (decoded) return decoded
      } catch {
        // Fall back to the original string below.
      }
    }

    return trimmed
  }

  private decodeBinaryContent(data: Buffer): string {
    if (data.length === 0) return ''

    try {
      if (data.length >= 4 && data.readUInt32LE(0) === 0xfd2fb528) {
        const fzstd = nodeRequire('fzstd') as { decompress: (input: Buffer) => Uint8Array }
        const decompressed = fzstd.decompress(data)
        return Buffer.from(decompressed).toString('utf-8')
      }
    } catch {
      return ''
    }

    const decoded = data.toString('utf-8')
    const replacementCount = (decoded.match(/\uFFFD/g) || []).length
    if (replacementCount < decoded.length * 0.2 && this.isMostlyReadableText(decoded)) {
      return decoded.replace(/\uFFFD/g, '')
    }
    return ''
  }

  private looksLikeHex(value: string): boolean {
    return value.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(value)
  }

  private looksLikeBase64(value: string): boolean {
    if (value.length % 4 !== 0) return false
    return /^[A-Za-z0-9+/]+={0,2}$/.test(value)
  }

  private isMostlyReadableText(value: string): boolean {
    if (!value) return false
    const readable = Array.from(value).filter((char) => {
      const code = char.charCodeAt(0)
      return code === 0x09 || code === 0x0a || code === 0x0d || code >= 0x20
    }).length
    return readable / value.length > 0.85
  }

  private pickNumber(row: Record<string, unknown>, keys: string[]): number {
    for (const key of keys) {
      const value = this.pickValue(row, [key])
      const parsed =
        typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
      if (Number.isFinite(parsed)) {
        return parsed > 1e12 ? Math.floor(parsed / 1000) : Math.floor(parsed)
      }
    }
    return 0
  }

  private pickBoolean(row: Record<string, unknown>, keys: string[]): boolean {
    for (const key of keys) {
      const value = this.pickValue(row, [key])
      if (typeof value === 'boolean') return value
      if (typeof value === 'number') return value === 1
      if (typeof value === 'string') return value === '1' || value.toLowerCase() === 'true'
    }
    return false
  }

  private uniq(values: string[]): string[] {
    return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
  }

  getMyUsernameCandidates(): string[] {
    const rawAccountName = path.basename(this.accountRoot)
    return this.uniq([this.wxid, rawAccountName, Wcdb4Client.cleanAccountDirName(rawAccountName)])
  }

  private normalizeTimestamp(input: number): number {
    if (!input || input <= 0) return 0
    const normalized = input > 1e12 ? Math.floor(input / 1000) : Math.floor(input)
    return Math.min(Math.max(normalized, 0), 2147483647)
  }

  private quoteSqlIdentifier(identifier: string): string {
    return `"${String(identifier || '').replace(/"/g, '""')}"`
  }
}
