import { app } from 'electron'
import fs from 'fs-extra'
import path from 'path'
import os from 'os'

export interface AppSettings {
  dbRoot: string
  apiEnabled: boolean
  apiHost: string
  apiPort: number
  imageKeyRoot: string
  imageXorKey: string
  imageAesKey: string
  imageKeyFallbackDisabled: boolean
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
    return [
      path.join(home, 'Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files')
    ]
  }

  const candidates = [
    ...getWeflowDbPathCandidates(home),
    path.join(home, 'Documents', 'WeChat Files'),
    path.join(home, 'Documents', 'xwechat_files'),
    path.join(home, 'WeChat Files'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'Tencent', 'xwechat_files')
  ]

  for (const drive of getWindowsDrives()) {
    candidates.push(path.join(`${drive}:\\`, 'xwechat_files'))
    candidates.push(path.join(`${drive}:\\`, 'WeChat Files'))
    for (const child of listDirectories(`${drive}:\\`)) {
      candidates.push(path.join(child, 'xwechat_files'))
      candidates.push(path.join(child, 'WeChat Files'))
    }
  }

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

function getWindowsDrives(): string[] {
  const drives: string[] = []
  for (let code = 67; code <= 90; code += 1) {
    const drive = String.fromCharCode(code)
    if (fs.existsSync(`${drive}:\\`)) drives.push(drive)
  }
  return drives
}

function listDirectories(root: string): string[] {
  try {
    return fs
      .readdirSync(root)
      .map((name) => path.join(root, name))
      .filter((candidate) => {
        try {
          return fs.statSync(candidate).isDirectory()
        } catch {
          return false
        }
      })
  } catch {
    return []
  }
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
      if (!cache.imageKeyRoot) {
        cache.imageKeyRoot = cache.dbRoot
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
