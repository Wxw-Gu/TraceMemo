import { app } from 'electron'
import fs from 'fs-extra'
import path from 'path'
import os from 'os'

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

export interface AppSettings {
  dbRoot: string
  apiEnabled: boolean
  apiHost: string
  apiPort: number
  imageKeyRoot: string
  imageXorKey: string
  imageAesKey: string
  imageKeyFallbackDisabled: boolean
  recallProtectionEnabled: boolean
  autoLogin: boolean
  autoLoginPreferenceSet: boolean
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
    ...getWeflowDbPathCandidates(home),
    path.join(home, 'Documents', 'xwechat_files'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'Tencent', 'xwechat_files')
  ]

  return unique(candidates)
}

function getWeflowDbPathCandidates(home: string): string[] {
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

function unique(values: string[]): string[] {
  return Array.from(new Set(values))
}

function isUsableDbRoot(candidate?: string): boolean {
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
  recallProtectionEnabled: false,
  autoLogin: ['1', 'true', 'yes', 'on'].includes(
    String(import.meta.env.VITE_AUTO_LOGIN || '')
      .trim()
      .toLowerCase()
  ),
  autoLoginPreferenceSet: false
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
      const raw = fs.readJsonSync(SETTINGS_FILE) as Partial<AppSettings>
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
      return cache
    }
  } catch (error) {
    console.warn('[Settings] failed to load, fallback to defaults:', error)
  }
  cache = { ...DEFAULT_SETTINGS }
  return cache
}

export function saveSettings(next: AppSettings): AppSettings {
  cache = { ...next }
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
