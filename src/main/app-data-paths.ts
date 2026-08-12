import fs from 'fs'
import path from 'path'

export const LEGACY_USER_DATA_NAME = 'WechatExplorer'
export const LEGACY_PACKAGE_USER_DATA_NAME = 'wechatexplorer'
export const CURRENT_USER_DATA_NAME = 'TraceMemo'
export const TRACE_MEMO_RUNTIME_NAME = 'TraceMemo'

export interface UserDataRoots {
  legacy: string
  legacyPackage: string
  current: string
}

export interface UserDataSelectionInput extends UserDataRoots {
  isolated?: string
}

export type UserDataRootKind = 'isolated' | 'legacy-display' | 'legacy-package' | 'current'

export type UserDataSelectionReason =
  | 'isolated-override'
  | 'legacy-display-assets'
  | 'legacy-package-assets'
  | 'legacy-shared-assets'
  | 'legacy-conflict-display-preferred'
  | 'current-assets'
  | 'clean-install'

export interface UserDataSelection {
  selected: string
  selectedKind: UserDataRootKind
  reason: UserDataSelectionReason
  directories: {
    legacy: boolean
    legacyPackage: boolean
    current: boolean
  }
  assets: {
    legacy: boolean
    legacyPackage: boolean
    current: boolean
  }
  legacyRootsEquivalent: boolean
  legacyConflict: boolean
}

export interface UserDataSelectionDependencies {
  directoryExists: (root: string) => boolean
  hasAssets: (root: string) => boolean
  areSameDirectory: (first: string, second: string) => boolean
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
      return (
        entry.isFile() &&
        entry.name.endsWith('.bin') &&
        isNonEmptyFile(path.join(directoryPath, entry.name))
      )
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

export function isExistingDirectory(directoryPath: string): boolean {
  try {
    return fs.statSync(directoryPath).isDirectory()
  } catch {
    return false
  }
}

export function areSameExistingDirectory(firstPath: string, secondPath: string): boolean {
  try {
    const first = fs.statSync(firstPath)
    const second = fs.statSync(secondPath)
    if (!first.isDirectory() || !second.isDirectory()) return false
    if (first.ino && first.dev === second.dev && first.ino === second.ino) return true
    return fs.realpathSync.native(firstPath) === fs.realpathSync.native(secondPath)
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
    'wechat-share-service.bin',
    path.join('cache', 'voice-transcripts.sqlite')
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
    legacyPackage: path.join(appDataPath, LEGACY_PACKAGE_USER_DATA_NAME),
    current: path.join(appDataPath, CURRENT_USER_DATA_NAME)
  }
}

/**
 * Select exactly one root. This intentionally does not copy, merge, delete or
 * modify any directory. The visible-name legacy root remains first priority;
 * the lowercase v2.1.9 package-name root is the fallback on case-sensitive
 * filesystems. If both distinct legacy roots contain assets, the visible-name
 * root wins deterministically and the caller receives conflict diagnostics.
 */
export function selectUserDataRoot(
  input: UserDataSelectionInput,
  dependencies: UserDataSelectionDependencies = {
    directoryExists: isExistingDirectory,
    hasAssets: hasValidUserAssets,
    areSameDirectory: areSameExistingDirectory
  }
): UserDataSelection {
  const isolated = input.isolated?.trim()
  if (isolated) {
    return {
      selected: path.resolve(isolated),
      selectedKind: 'isolated',
      reason: 'isolated-override',
      directories: { legacy: false, legacyPackage: false, current: false },
      assets: { legacy: false, legacyPackage: false, current: false },
      legacyRootsEquivalent: false,
      legacyConflict: false
    }
  }

  const directories = {
    legacy: dependencies.directoryExists(input.legacy),
    legacyPackage: dependencies.directoryExists(input.legacyPackage),
    current: dependencies.directoryExists(input.current)
  }
  const assets = {
    legacy: dependencies.hasAssets(input.legacy),
    legacyPackage: dependencies.hasAssets(input.legacyPackage),
    current: dependencies.hasAssets(input.current)
  }
  const legacyRootsEquivalent =
    directories.legacy &&
    directories.legacyPackage &&
    dependencies.areSameDirectory(input.legacy, input.legacyPackage)

  if (assets.legacy) {
    const legacyConflict = assets.legacyPackage && !legacyRootsEquivalent
    return {
      selected: input.legacy,
      selectedKind: 'legacy-display',
      reason: legacyConflict
        ? 'legacy-conflict-display-preferred'
        : legacyRootsEquivalent
          ? 'legacy-shared-assets'
          : 'legacy-display-assets',
      directories,
      assets,
      legacyRootsEquivalent,
      legacyConflict
    }
  }

  if (assets.legacyPackage) {
    return {
      selected: input.legacyPackage,
      selectedKind: 'legacy-package',
      reason: 'legacy-package-assets',
      directories,
      assets,
      legacyRootsEquivalent: false,
      legacyConflict: false
    }
  }

  if (assets.current) {
    return {
      selected: input.current,
      selectedKind: 'current',
      reason: 'current-assets',
      directories,
      assets,
      legacyRootsEquivalent: false,
      legacyConflict: false
    }
  }

  return {
    selected: input.current,
    selectedKind: 'current',
    reason: 'clean-install',
    directories,
    assets,
    legacyRootsEquivalent: false,
    legacyConflict: false
  }
}

export function chooseUserDataRoot(input: UserDataSelectionInput): string {
  return selectUserDataRoot(input).selected
}
