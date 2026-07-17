import fs from 'fs-extra'
import path from 'path'

const DB_ROOT_NAMES = new Set(['xwechat_files', 'wechat files'])
const SKIPPED_DIRECTORY_NAMES = new Set([
  '$recycle.bin',
  'system volume information',
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
  'recovery'
])
const MAX_VISITED_DIRECTORIES_PER_DRIVE = 20_000
let cachedDiscoveredRoots: string[] | null = null

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => path.normalize(value))))
}

export function getWindowsDrives(): string[] {
  if (process.platform !== 'win32') return []
  const drives: string[] = []
  for (let code = 67; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`
    if (fs.existsSync(root)) drives.push(root)
  }
  return drives
}

export function scanWindowsDbRoots(driveRoots: string[], maxDepth = 3): string[] {
  const results: string[] = []

  for (const driveRoot of driveRoots) {
    const queue: Array<{ directory: string; depth: number }> = [{ directory: driveRoot, depth: 0 }]
    let visited = 0

    while (queue.length > 0 && visited < MAX_VISITED_DIRECTORIES_PER_DRIVE) {
      const current = queue.shift()
      if (!current || current.depth >= maxDepth) continue

      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(current.directory, { withFileTypes: true })
      } catch {
        continue
      }

      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue
        const lowered = entry.name.toLowerCase()
        const fullPath = path.join(current.directory, entry.name)
        const depth = current.depth + 1
        visited += 1

        if (DB_ROOT_NAMES.has(lowered)) {
          results.push(fullPath)
          continue
        }
        if (depth < maxDepth && !SKIPPED_DIRECTORY_NAMES.has(lowered)) {
          queue.push({ directory: fullPath, depth })
        }
        if (visited >= MAX_VISITED_DIRECTORIES_PER_DRIVE) break
      }
    }
  }

  return unique(results)
}

export function discoverWindowsDbRoots(): string[] {
  if (!cachedDiscoveredRoots) {
    cachedDiscoveredRoots = scanWindowsDbRoots(getWindowsDrives(), 3)
  }
  return [...cachedDiscoveredRoots]
}
