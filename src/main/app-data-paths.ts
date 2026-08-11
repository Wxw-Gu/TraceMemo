import fs from 'fs'
import path from 'path'

export const LEGACY_USER_DATA_NAME = 'WechatExplorer'
export const CURRENT_USER_DATA_NAME = 'tracememo'

export interface UserDataRoots {
  legacy: string
  current: string
}

export interface UserDataSelectionInput extends UserDataRoots {
  isolated?: string
}

function isNonEmptyFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath)
    return stat.isFile() && stat.size > 0
  } catch {
    return false
  }
}

function hasPersistentEntries(directoryPath: string): boolean {
  try {
    return fs.readdirSync(directoryPath, { withFileTypes: true }).some((entry) => {
      if (entry.name === '.DS_Store') return false
      if (entry.name === 'LOCK' || entry.name === 'LOG' || entry.name === 'LOG.old') return false
      return entry.isFile() || entry.isDirectory()
    })
  } catch {
    return false
  }
}

function hasDatabaseKey(directoryPath: string): boolean {
  try {
    return fs.readdirSync(directoryPath, { withFileTypes: true }).some((entry) => {
      return entry.isFile() && entry.name.endsWith('.bin') && isNonEmptyFile(path.join(directoryPath, entry.name))
    })
  } catch {
    return false
  }
}

function hasKnowledgeDatabase(root: string): boolean {
  const knowledgeRoot = path.join(root, 'knowledge')
  try {
    return fs.readdirSync(knowledgeRoot, { withFileTypes: true }).some((entry) => {
      if (!entry.isDirectory()) return false
      return isNonEmptyFile(path.join(knowledgeRoot, entry.name, 'knowledge.sqlite'))
    })
  } catch {
    return false
  }
}

/**
 * Runtime-only Chromium files are deliberately excluded. A directory is a
 * valid data root only when it contains at least one user-owned marker.
 */
export function hasValidUserAssets(root: string): boolean {
  const markers = [
    'settings.json',
    'ai-providers.json',
    'ai-provider-keys.bin',
    'local-api-token.bin',
    'wechat-db-key.bin',
    'wechat-image-keys.bin',
    'image-insights.json',
    'wechat-share-service.bin'
  ]
  if (markers.some((marker) => isNonEmptyFile(path.join(root, marker)))) return true
  if (hasKnowledgeDatabase(root)) return true
  if (hasDatabaseKey(path.join(root, 'database-keys'))) return true
  if (hasPersistentEntries(path.join(root, 'reports'))) return true
  if (hasPersistentEntries(path.join(root, 'recall-archive'))) return true
  if (hasPersistentEntries(path.join(root, 'digital-twin'))) return true
  if (hasPersistentEntries(path.join(root, 'group-exit-monitor'))) return true
  if (hasPersistentEntries(path.join(root, 'Local Storage', 'leveldb'))) return true
  return false
}

export function getUserDataRoots(appDataPath: string): UserDataRoots {
  return {
    legacy: path.join(appDataPath, LEGACY_USER_DATA_NAME),
    current: path.join(appDataPath, CURRENT_USER_DATA_NAME)
  }
}

/**
 * Select exactly one root. This intentionally does not copy, merge, delete or
 * modify either directory. Legacy wins when both roots contain user assets so
 * a v2.1.9 upgrade remains deterministic and lossless.
 */
export function chooseUserDataRoot(input: UserDataSelectionInput): string {
  const isolated = input.isolated?.trim()
  if (isolated) return path.resolve(isolated)

  if (hasValidUserAssets(input.legacy)) return input.legacy
  if (hasValidUserAssets(input.current)) return input.current
  return input.current
}
