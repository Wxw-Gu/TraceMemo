import fs from 'fs'
import path from 'path'

function prependPath(values: string[]): void {
  if (process.platform !== 'win32') return

  const existing = process.env.PATH || ''
  const next = Array.from(new Set(values.filter(Boolean))).join(path.delimiter)
  process.env.PATH = next ? `${next}${path.delimiter}${existing}` : existing
  process.env.Path = process.env.PATH
}

try {
  const archDir = process.arch === 'arm64' ? 'arm64' : 'x64'
  const resourceRoots = [
    path.join(process.cwd(), 'resources'),
    path.join(process.cwd(), 'resources', 'resources'),
    path.join(process.resourcesPath || '', 'resources'),
    process.resourcesPath || ''
  ].filter((value, index, list) => value && list.indexOf(value) === index && fs.existsSync(value))

  const resourcesRoot = resourceRoots[0] || path.join(process.cwd(), 'resources')
  const dllDirs = resourceRoots.flatMap((root) => [
    root,
    path.join(root, 'wcdb', 'win32', archDir),
    path.join(root, 'wcdb', 'win32', 'x64'),
    path.join(root, 'key', 'win32', archDir),
    path.join(root, 'key', 'win32', 'x64'),
    path.join(root, 'runtime', 'win32')
  ])

  process.env.WCDB_RESOURCES_PATH = process.env.WCDB_RESOURCES_PATH || resourcesRoot
  process.env.WEFLOW_PROJECT_NAME = process.env.WEFLOW_PROJECT_NAME || 'WeFlow'
  prependPath(dllDirs.filter((dir) => fs.existsSync(dir)))
} catch (error) {
  console.error('[TraceMemo] failed to enforce local DLL priority:', error)
}
