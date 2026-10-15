import { createHash } from 'crypto'
import { app, shell } from 'electron'
import { existsSync, readFileSync, promises as fs, statSync } from 'fs'
import { dirname, join } from 'path'
import { isPackagedRuntime } from '../runtime-mode'

const SKILL_RELATIVE_PATHS = [
  join('skill', 'tracememo-reader', 'SKILL.md'),
  join('skill', 'wechatexplorer-reader', 'SKILL.md')
]
const GITHUB_URL = 'https://github.com/Wxw-Gu/TraceMemo/tree/main/docs/skill/tracememo-reader'

export const READER_SKILL_NAME = 'tracememo-reader'

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
  name?: string
  version?: string
  contentHash?: string
  filePath?: string
  directoryPath?: string
  source: SkillResourceSource
  githubUrl: string
  error?: string
}

export interface SkillDocument {
  name: string
  version?: string
  contentHash: string
  modifiedAt: string
  markdown: string
  filePath: string
}

export interface SkillFrontmatter {
  name?: string
  version?: string
}

interface SkillDocumentCacheEntry {
  filePath: string
  mtimeMs: number
  size: number
  document: SkillDocument
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

/**
 * 版本号只认 SKILL.md frontmatter 的 `version`，不再维护源码常量：
 * 常量与文档分离必然漂移，曾经出现过文档改了两轮而版本号纹丝不动的情况。
 */
export function parseSkillFrontmatter(content: string): SkillFrontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)
  if (!match) return {}
  const block = match[1]
  if (!block) return {}

  const frontmatter: SkillFrontmatter = {}
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim().toLowerCase()
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^["']/, '')
      .replace(/["']$/, '')
    if (!value) continue
    if (key === 'name') frontmatter.name = value
    else if (key === 'version') frontmatter.version = value
  }
  return frontmatter
}

function hashSkillContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

let cachedDocument: SkillDocumentCacheEntry | null = null

/**
 * 同步读取 Skill 文档。`/health` 属于高频接口，因此按 mtime + size 缓存，
 * 文件被替换（版本升级）后缓存自动失效。
 */
export function readSkillDocument(filePath: string): SkillDocument | null {
  try {
    const stats = statSync(filePath)
    if (
      cachedDocument &&
      cachedDocument.filePath === filePath &&
      cachedDocument.mtimeMs === stats.mtimeMs &&
      cachedDocument.size === stats.size
    ) {
      return cachedDocument.document
    }

    const markdown = readFileSync(filePath, 'utf-8')
    const frontmatter = parseSkillFrontmatter(markdown)
    const document: SkillDocument = {
      name: frontmatter.name || READER_SKILL_NAME,
      contentHash: hashSkillContent(markdown),
      modifiedAt: stats.mtime.toISOString(),
      markdown,
      filePath
    }
    if (frontmatter.version) document.version = frontmatter.version

    cachedDocument = {
      filePath,
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      document
    }
    return document
  } catch {
    cachedDocument = null
    return null
  }
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
  let candidates: SkillCandidate[] = []
  let source: SkillResourceSource = environment?.packaged ? 'bundled' : 'development'
  try {
    candidates = getSkillCandidates(environment)
    const resolved = candidates.find((candidate) => existsSync(candidate.path))
    if (resolved) {
      const filePath = resolved.path
      const status: SkillResourceStatus = {
        available: true,
        filePath,
        directoryPath: dirname(filePath),
        source: resolved.source,
        githubUrl: GITHUB_URL
      }
      const document = readSkillDocument(filePath)
      if (document) {
        status.name = document.name
        status.contentHash = document.contentHash
        if (document.version) status.version = document.version
      }
      return status
    }
    const fallback = candidates[0]
    if (fallback) source = fallback.source
  } catch {
    // 环境探测失败（例如非 Electron 进程）时退化成“不可用”：
    // /health 是外部 Agent 的自检入口，不能因为 Skill 读不到就整条挂掉。
  }

  return {
    available: false,
    source,
    githubUrl: GITHUB_URL,
    error: `未找到 TraceMemo Reader Skill 文件（已检查：${candidates.map((item) => item.path).join('；')}）`
  }
}

function getStatus(): SkillResourceStatus {
  return resolveSkillResourceStatus()
}

export const skillResourceService = {
  getStatus,

  getDocument(): SkillDocument | null {
    const status = this.getStatus()
    if (!status.available || !status.filePath) return null
    return readSkillDocument(status.filePath)
  },

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
