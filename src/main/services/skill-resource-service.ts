import { app, shell } from 'electron'
import { existsSync, promises as fs } from 'fs'
import { dirname, join } from 'path'
import { isPackagedRuntime } from '../runtime-mode'

const SKILL_RELATIVE_PATHS = [
  join('skill', 'tracememo-reader', 'SKILL.md'),
  join('skill', 'wechatexplorer-reader', 'SKILL.md')
]
const GITHUB_URL = 'https://github.com/Wxw-Gu/WechatExplorer/tree/main/docs/skill/tracememo-reader'
const SKILL_VERSION = 'v1.2'

type SkillResourceSource = 'development' | 'bundled'

interface SkillPathEnvironment {
  appPath: string
  cwd: string
  resourcesPath: string
  execPath: string
  packaged: boolean
}

interface SkillCandidate {
  path: string
  source: SkillResourceSource
}

export interface SkillResourceStatus {
  available: boolean
  version?: string
  filePath?: string
  directoryPath?: string
  source: SkillResourceSource
  githubUrl: string
  error?: string
}

function currentEnvironment(): SkillPathEnvironment {
  return {
    appPath: app.getAppPath(),
    cwd: process.cwd(),
    resourcesPath: process.resourcesPath || '',
    execPath: process.execPath,
    packaged: isPackagedRuntime()
  }
}

function uniqueCandidates(candidates: SkillCandidate[]): SkillCandidate[] {
  const seen = new Set<string>()
  return candidates.filter((candidate) => {
    if (!candidate.path || seen.has(candidate.path)) return false
    seen.add(candidate.path)
    return true
  })
}

export function getSkillCandidates(environment?: SkillPathEnvironment): SkillCandidate[] {
  const runtime = environment || currentEnvironment()
  const developmentPaths = SKILL_RELATIVE_PATHS.flatMap((relativePath) => [
    join(runtime.appPath, 'docs', relativePath),
    join(runtime.cwd, 'docs', relativePath),
    join(dirname(runtime.appPath), 'docs', relativePath)
  ])
  const execDirectory = dirname(runtime.execPath)
  const bundledPaths = SKILL_RELATIVE_PATHS.flatMap((relativePath) => [
    join(runtime.resourcesPath, relativePath),
    join(runtime.resourcesPath, 'resources', relativePath),
    join(dirname(runtime.appPath), relativePath),
    join(execDirectory, 'resources', relativePath),
    join(dirname(execDirectory), 'Resources', relativePath)
  ])
  return uniqueCandidates(
    runtime.packaged
      ? bundledPaths.map((path) => ({ path, source: 'bundled' }))
      : [
          ...developmentPaths.map((path) => ({ path, source: 'development' as const })),
          ...bundledPaths.map((path) => ({ path, source: 'bundled' as const }))
        ]
  )
}

export function resolveSkillResourceStatus(
  environment?: SkillPathEnvironment
): SkillResourceStatus {
  const candidates = getSkillCandidates(environment)
  const resolved = candidates.find((candidate) => existsSync(candidate.path))
  const filePath = resolved?.path || candidates[0].path
  const source = resolved?.source || candidates[0].source
  const directoryPath = dirname(filePath)
  if (!resolved) {
    return {
      available: false,
      source,
      githubUrl: GITHUB_URL,
      error: `未找到 TraceMemo Reader Skill 文件（已检查：${candidates.map((item) => item.path).join('；')}）`
    }
  }
  return {
    available: true,
    version: SKILL_VERSION,
    filePath,
    directoryPath,
    source,
    githubUrl: GITHUB_URL
  }
}

function getStatus(): SkillResourceStatus {
  return resolveSkillResourceStatus()
}

export const skillResourceService = {
  getStatus,

  async read(): Promise<{ success: boolean; content?: string; error?: string }> {
    const status = this.getStatus()
    if (!status.available || !status.filePath) return { success: false, error: status.error }
    try {
      return { success: true, content: await fs.readFile(status.filePath, 'utf-8') }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  },

  async reveal(): Promise<{ success: boolean; error?: string }> {
    const status = this.getStatus()
    if (!status.available || !status.directoryPath) return { success: false, error: status.error }
    try {
      const error = await shell.openPath(status.directoryPath)
      if (error) return { success: false, error }
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  },

  async openGithub(): Promise<{ success: boolean; error?: string }> {
    try {
      await shell.openExternal(GITHUB_URL)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}
