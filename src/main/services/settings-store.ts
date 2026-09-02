import { app } from 'electron'
import fs from 'fs-extra'
import path from 'path'
import os from 'os'
import type { TextToSpeechModel } from '../../shared/text-to-speech'

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
  ttsModel: 's2.1-pro-free'
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
