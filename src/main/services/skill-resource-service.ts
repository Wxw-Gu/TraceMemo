import { app, shell } from 'electron'
import { existsSync, promises as fs } from 'fs'
import { dirname, join } from 'path'
import { isPackagedRuntime } from '../runtime-mode'

const SKILL_RELATIVE_PATH = join('skill', 'wechatexplorer-reader', 'SKILL.md')
const GITHUB_URL =
  'https://github.com/Wxw-Gu/WechatExplorer/tree/main/docs/skill/wechatexplorer-reader'

export interface SkillResourceStatus {
  available: boolean
  version?: string
  filePath?: string
  directoryPath?: string
  source: 'development' | 'bundled'
  githubUrl: string
  error?: string
}

function getSkillCandidates(): { path: string; source: 'development' | 'bundled' }[] {
  const developmentPath = join(app.getAppPath(), 'docs', SKILL_RELATIVE_PATH)
  const bundledPaths = [
    join(process.resourcesPath, SKILL_RELATIVE_PATH),
    join(dirname(app.getAppPath()), SKILL_RELATIVE_PATH),
    join(dirname(process.execPath), 'resources', SKILL_RELATIVE_PATH)
  ]
  return isPackagedRuntime()
    ? bundledPaths.map((path) => ({ path, source: 'bundled' as const }))
    : [
        { path: developmentPath, source: 'development' as const },
        ...bundledPaths.map((path) => ({ path, source: 'bundled' as const }))
      ]
}

function getStatus(): SkillResourceStatus {
  const candidates = getSkillCandidates()
  const resolved = candidates.find((candidate) => existsSync(candidate.path))
  const filePath = resolved?.path || candidates[0].path
  const source = resolved?.source || candidates[0].source
  const directoryPath = dirname(filePath)
  if (!resolved) {
    return {
      available: false,
      source,
      githubUrl: GITHUB_URL,
      error: `未找到 WechatExplorer Reader Skill 文件（已检查：${candidates.map((item) => item.path).join('；')}）`
    }
  }
  return {
    available: true,
    version: 'v1.0',
    filePath,
    directoryPath,
    source,
    githubUrl: GITHUB_URL
  }
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
