import { app } from 'electron'
import { existsSync } from 'fs'
import { dirname, join } from 'path'

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

export function getResourceRoots(): string[] {
  const appPath = app.getAppPath()
  const appPathDir = dirname(appPath)
  const execDir = dirname(process.execPath)

  return unique([
    process.env.TRACEMEMO_RESOURCES_PATH || '',
    process.env.WECHATEXPLORER_RESOURCES_PATH || '',
    join(process.cwd(), 'resources'),
    join(process.cwd(), 'resources', 'resources'),
    join(process.resourcesPath || '', 'resources'),
    process.resourcesPath || '',
    join(appPath, 'resources'),
    join(appPathDir, 'resources'),
    appPathDir,
    join(execDir, 'resources'),
    join(dirname(execDir), 'Resources', 'resources'),
    join(dirname(execDir), 'Resources')
  ]).filter((root) => existsSync(root))
}

export function getResourceCandidates(relativePath: string): string[] {
  return unique(getResourceRoots().map((root) => join(root, relativePath)))
}

export function findResource(relativePath: string): string | null {
  return getResourceCandidates(relativePath).find((candidate) => existsSync(candidate)) || null
}
