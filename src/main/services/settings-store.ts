import { app } from 'electron'
import fs from 'fs-extra'
import path from 'path'
import os from 'os'
import type { TextToSpeechModel } from '../../shared/text-to-speech'
import type { MacKeyHelperMode } from '../../shared/database-key'

/**
 * 把 V3 时代的 "...\\Documents\\WeChat Files" 路径重定向到
 * "...\\Documents\\xwechat_files"（V4）。如果 xwechat_files 不存在则保留原值。
 * 仅支持 WeChat 4.0：自动纠正用户机器上残留的旧路径。
 */
function redirectLegacyWeChatFilesToXwechat(candidate: string): string {
  if (!candidate) return candidate
  const normalized = candidate.replace(/[\\/]+$/, '')
  const lowered = normalized.toLowerCase()
  const legacyMarker = `${path.sep}wechat files`
  if (!lowered.endsWith(legacyMarker)) return candidate
  const redirected = `${normalized.slice(0, -legacyMarker.length)}${path.sep}xwechat_files`
  if (fs.existsSync(redirected)) return redirected
  return candidate
}

export type CloseAction = 'ask' | 'tray' | 'quit'

export interface AppSettings {
  dbRoot: string
  apiEnabled: boolean
  apiHost: string
  apiPort: number
  imageKeyRoot: string
  imageXorKey: string
  imageAesKey: string
  imageKeyFallbackDisabled: boolean
  ffmpegPath: string
  recallProtectionEnabled: boolean
  debugEnabled: boolean
  autoLogin: boolean
  autoLoginPreferenceSet: boolean
  appearanceTheme: 'system' | 'light' | 'dark'
  compactMode: boolean
  showStartupProgress: boolean
  ttsSelectedVoiceId: string
  ttsModel: TextToSpeechModel
  windowsWechatPort: string
  /**
   * macOS Apple Silicon 密钥捕获工具覆盖。默认 `auto` 按微信版本选择；
   * 微信外壳版本与实际内核不一致时可显式指定。
   */
  macKeyHelperMode: MacKeyHelperMode
  /** 自定义 helper 可执行文件绝对路径；空串表示使用内置资源。 */
  macKeyHelperPath: string
  /** 新版 helper 的 `--profile`；空串表示 `wechat-4.1.13`。 */
  macKeyHelperProfile: string
  reportImagePostfixText: string
  /**
   * Query Agent 是否为桌面「问问微信」与 Agent Hub 查询类问题的主路径。
   * 默认开启；关闭后回退到 Legacy AI Search Pipeline（仅作 runtime regression 时的回退开关，
   * 不在用户界面暴露实验性名称）。
   */
  queryAgentEnabled: boolean
  /**
   * 关闭主窗口时的行为。
   *
   * - `ask`：每次弹窗询问（默认，保持既有行为）
   * - `tray`：直接最小化到系统托盘，应用继续在后台跑
   * - `quit`：直接退出整个进程
   *
   * 只有用户在关闭弹窗里勾了"记住我的选择"才会离开 `ask`；
   * 设置页随时可以改回来。
   */
  closeAction: CloseAction
  /**
   * 用户点过「忽略此版本」的更新版本号（不含 `v` 前缀）。
   *
   * 只影响**启动时的自动弹窗**：同一版本不再打扰。手动检查更新与「设置 → 关于」
   * 始终展示最新版本 —— 忽略的是提示，不是版本本身。空串表示没有忽略任何版本。
   */
  skippedUpdateVersion: string
}

/** 只接受 `1.2.3` / `1.2.3-beta.1` 这类版本号；其它输入一律按"没有忽略"处理。 */
const UPDATE_VERSION_PATTERN = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,32})?$/

export function normalizeSkippedUpdateVersion(value: unknown): string {
  const text = String(value ?? '').trim()
  return UPDATE_VERSION_PATTERN.test(text) ? text : ''
}

/** 非法/历史值一律收敛为 `auto`，避免把无效模式传给 helper 选择逻辑。 */
export function normalizeMacKeyHelperMode(value: unknown): MacKeyHelperMode {
  return value === 'legacy' || value === 'wechat-4.1.13' ? value : 'auto'
}

function normalizeTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function getDefaultDbRoot(): string {
  const home = os.homedir()
  const candidates = getDefaultDbRootCandidates(home)
  return candidates.find((candidate) => isUsableDbRoot(candidate)) || candidates[0]
}

function getDefaultDbRootCandidates(home: string): string[] {
  if (process.platform !== 'win32') {
    // macOS 仅支持 WeChat 4.0 路径（xwechat_files）
    return [
      path.join(home, 'Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files')
    ]
  }

  // 仅支持 WeChat 4.0：剔除 V3 时代的 "WeChat Files" 目录，
  // 只认 xwechat_files（含 Documents\ 和 AppData\Roaming\Tencent\ 两种合法位置）。
  const candidates = [
    path.join(home, 'Documents', 'xwechat_files'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'Tencent', 'xwechat_files')
  ]

  return unique(candidates)
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values))
}

export function isUsableDbRoot(candidate?: string): boolean {
  if (!candidate || !fs.existsSync(candidate)) return false
  if (fs.existsSync(path.join(candidate, 'db_storage'))) return true
  try {
    return fs
      .readdirSync(candidate)
      .some((name) => fs.existsSync(path.join(candidate, name, 'db_storage')))
  } catch {
    return false
  }
}

export function validateDbRoot(candidate?: string): { valid: boolean; error?: string } {
  const root = String(candidate || '').trim()
  if (!root) return { valid: false, error: '微信数据目录为空，请重新选择目录' }
  if (!fs.existsSync(root)) {
    return { valid: false, error: '微信数据目录不存在，请检查路径或重新选择目录' }
  }
  if (!isUsableDbRoot(root)) {
    return {
      valid: false,
      error: '所选目录中未找到微信 4.x 数据库（db_storage），请选择 xwechat_files 或账号目录'
    }
  }
  return { valid: true }
}

const defaultDbRoot = getDefaultDbRoot()

const DEFAULT_SETTINGS: AppSettings = {
  dbRoot: defaultDbRoot,
  apiEnabled: true,
  apiHost: '127.0.0.1',
  apiPort: 6131,
  imageKeyRoot: defaultDbRoot,
  imageXorKey: '',
  imageAesKey: '',
  imageKeyFallbackDisabled: false,
  ffmpegPath: '',
  recallProtectionEnabled: false,
  debugEnabled: false,
  autoLogin: ['1', 'true', 'yes', 'on'].includes(
    String(import.meta.env.VITE_AUTO_LOGIN || '')
      .trim()
      .toLowerCase()
  ),
  autoLoginPreferenceSet: false,
  appearanceTheme: 'system',
  compactMode: false,
  showStartupProgress: true,
  ttsSelectedVoiceId: '',
  ttsModel: 's2.1-pro-free',
  windowsWechatPort: '',
  macKeyHelperMode: 'auto',
  macKeyHelperPath: '',
  macKeyHelperProfile: '',
  reportImagePostfixText: '今日日报',
  queryAgentEnabled: true,
  closeAction: 'ask',
  skippedUpdateVersion: ''
}

const SETTINGS_FILE = path.join(
  process.env['WE_SETTINGS_DIR'] || app.getPath('userData'),
  'settings.json'
)

let cache: AppSettings | null = null

function ensureDir(): void {
  fs.ensureDirSync(path.dirname(SETTINGS_FILE))
}

export function loadSettings(): AppSettings {
  if (cache) return cache
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const stored = fs.readJsonSync(SETTINGS_FILE) as Partial<AppSettings> & {
        keepPersonalWechatProcess?: unknown
      }
      const { keepPersonalWechatProcess: retiredKeepProcess, ...raw } = stored
      cache = { ...DEFAULT_SETTINGS, ...raw }
      if (raw.autoLogin === undefined) {
        const hasSavedDatabaseKey = fs.existsSync(
          path.join(app.getPath('userData'), 'wechat-db-key.bin')
        )
        if (hasSavedDatabaseKey) cache.autoLogin = true
      }
      if (process.platform === 'win32' && !isUsableDbRoot(cache.dbRoot)) {
        cache.dbRoot = getDefaultDbRoot()
      }
      // 同步：imageKeyRoot 必须跟随 dbRoot 更新，
      // 否则自动获取会扫错目录（旧 bug：状态面板显示 D 盘，自动获取扫 C 盘）。
      if (!cache.imageKeyRoot || !isUsableDbRoot(cache.imageKeyRoot)) {
        cache.imageKeyRoot = cache.dbRoot
      }
      // V4-only 兜底：如果 imageKeyRoot 指向旧的 "WeChat Files"（V3 路径），
      // 重定向到同一父目录下的 xwechat_files（V4）。
      if (cache.imageKeyRoot) {
        cache.imageKeyRoot = redirectLegacyWeChatFilesToXwechat(cache.imageKeyRoot)
      }
      if (cache.dbRoot) {
        cache.dbRoot = redirectLegacyWeChatFilesToXwechat(cache.dbRoot)
      }
      // 关闭行为可能来自旧版本或手改过的 settings.json —— 非法值一律收敛回 `ask`。
      // 放任非法值会造成最难排查的一种表现：点关闭窗口什么也不发生。
      if (
        cache.closeAction !== 'ask' &&
        cache.closeAction !== 'tray' &&
        cache.closeAction !== 'quit'
      ) {
        cache.closeAction = 'ask'
      }
      // 版本号是拿来逐字比对的：脏值会让「忽略」永远命中不了同一条记录。
      cache.skippedUpdateVersion = normalizeSkippedUpdateVersion(cache.skippedUpdateVersion)
      cache.macKeyHelperMode = normalizeMacKeyHelperMode(cache.macKeyHelperMode)
      cache.macKeyHelperPath = normalizeTrimmedString(cache.macKeyHelperPath)
      cache.macKeyHelperProfile = normalizeTrimmedString(cache.macKeyHelperProfile)
      // 防撤回已下线（设置入口已隐藏）：历史版本可能把它持久化为 true。
      // 这里强制收敛为 false 并回写磁盘，确保旧的撤回监听与撤回日志不会继续运行。
      if (cache.recallProtectionEnabled || retiredKeepProcess !== undefined) {
        cache.recallProtectionEnabled = false
        saveSettings(cache)
      }
      return cache
    }
  } catch (error) {
    console.warn('[Settings] failed to load, fallback to defaults:', error)
  }
  cache = { ...DEFAULT_SETTINGS }
  return cache
}

export function saveSettings(next: AppSettings): AppSettings {
  // 防撤回已下线：所有写入路径（含 settings:set 补丁）统一收敛为 false，
  // 避免遗留入口或旧版本把它重新打开。
  const sanitized = { ...next } as AppSettings & {
    keepPersonalWechatProcess?: unknown
  }
  delete sanitized.keepPersonalWechatProcess
  sanitized.macKeyHelperMode = normalizeMacKeyHelperMode(sanitized.macKeyHelperMode)
  sanitized.macKeyHelperPath = normalizeTrimmedString(sanitized.macKeyHelperPath)
  sanitized.macKeyHelperProfile = normalizeTrimmedString(sanitized.macKeyHelperProfile)
  cache = { ...sanitized, recallProtectionEnabled: false }
  try {
    ensureDir()
    fs.writeJsonSync(SETTINGS_FILE, cache, { spaces: 2 })
  } catch (error) {
    console.error('[Settings] failed to save:', error)
  }
  return cache
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  return saveSettings({ ...loadSettings(), ...patch })
}

export function resetSettings(): AppSettings {
  cache = null
  try {
    if (fs.existsSync(SETTINGS_FILE)) fs.unlinkSync(SETTINGS_FILE)
  } catch {
    // best effort
  }
  return loadSettings()
}

export function getSettingsPath(): string {
  return SETTINGS_FILE
}
