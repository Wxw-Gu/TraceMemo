import { createHash } from 'crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  getSkillCandidates,
  parseSkillFrontmatter,
  readSkillDocument,
  resolveSkillResourceStatus
} from '../../src/main/services/skill-resource-service'

const roots: string[] = []

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'wxe-reader-skill-'))
  roots.push(root)
  return root
}

function environment(root: string, packaged: boolean) {
  return {
    appPath: join(root, 'application'),
    cwd: join(root, 'workspace'),
    resourcesPath: join(root, 'runtime', 'resources'),
    execPath: join(root, 'runtime', 'WechatExplorer.exe'),
    packaged
  }
}

function skillBody(version?: string): string {
  const versionLine = version ? `version: ${version}\n` : ''
  return `---\nname: tracememo-reader\n${versionLine}description: fixture\n---\n\n# TraceMemo Reader\n\n正文内容。\n`
}

function writeSkill(filePath: string, version?: string): void {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, skillBody(version), 'utf8')
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

describe('Reader Skill resource resolution', () => {
  afterEach(() => {
    while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
  })

  it('finds the repository Skill from the current working directory in development', () => {
    const root = fixtureRoot()
    const runtime = environment(root, false)
    const skillPath = join(runtime.cwd, 'docs', 'skill', 'tracememo-reader', 'SKILL.md')
    writeSkill(skillPath, '1.3.0')

    expect(resolveSkillResourceStatus(runtime)).toMatchObject({
      available: true,
      source: 'development',
      name: 'tracememo-reader',
      version: '1.3.0',
      filePath: skillPath,
      directoryPath: dirname(skillPath)
    })
  })

  it('uses the extraResources Skill directory in a packaged runtime', () => {
    const root = fixtureRoot()
    const runtime = environment(root, true)
    const skillPath = join(runtime.resourcesPath, 'skill', 'tracememo-reader', 'SKILL.md')
    writeSkill(skillPath, '1.3.0')

    expect(resolveSkillResourceStatus(runtime)).toMatchObject({
      available: true,
      source: 'bundled',
      version: '1.3.0',
      filePath: skillPath
    })
  })

  it('falls back to the legacy Skill directory for one compatibility release', () => {
    const root = fixtureRoot()
    const runtime = environment(root, true)
    const skillPath = join(runtime.resourcesPath, 'skill', 'wechatexplorer-reader', 'SKILL.md')
    writeSkill(skillPath)

    expect(resolveSkillResourceStatus(runtime)).toMatchObject({
      available: true,
      source: 'bundled',
      filePath: skillPath
    })
  })

  it('reports every checked path without duplicating candidates', () => {
    const root = fixtureRoot()
    const runtime = environment(root, false)
    const candidates = getSkillCandidates(runtime)
    const status = resolveSkillResourceStatus(runtime)

    expect(new Set(candidates.map((candidate) => candidate.path)).size).toBe(candidates.length)
    expect(status).toMatchObject({ available: false, source: 'development' })
    for (const candidate of candidates) expect(status.error).toContain(candidate.path)
  })

  it('omits the version when the frontmatter does not declare one', () => {
    const root = fixtureRoot()
    const runtime = environment(root, false)
    const skillPath = join(runtime.cwd, 'docs', 'skill', 'tracememo-reader', 'SKILL.md')
    writeSkill(skillPath)

    const status = resolveSkillResourceStatus(runtime)
    expect(status.available).toBe(true)
    expect(status.version).toBeUndefined()
  })

  // /health 是外部 Agent 的自检入口：环境探测本身出错时只能降级，不能抛出。
  it('degrades to unavailable instead of throwing when the environment is broken', () => {
    const status = resolveSkillResourceStatus({
      appPath: undefined as unknown as string,
      cwd: undefined as unknown as string,
      resourcesPath: '',
      execPath: undefined as unknown as string,
      packaged: false
    })

    expect(status.available).toBe(false)
    expect(status.error).toContain('未找到 TraceMemo Reader Skill 文件')
    expect(status.githubUrl).toContain('github.com')
  })
})

describe('Reader Skill document identity', () => {
  afterEach(() => {
    while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
  })

  it('exposes markdown, version and a content hash that matches the file bytes', () => {
    const root = fixtureRoot()
    const skillPath = join(root, 'docs', 'skill', 'tracememo-reader', 'SKILL.md')
    writeSkill(skillPath, '1.3.0')
    const content = readFileSync(skillPath, 'utf-8')

    const document = readSkillDocument(skillPath)
    expect(document).not.toBeNull()
    expect(document?.version).toBe('1.3.0')
    expect(document?.name).toBe('tracememo-reader')
    expect(document?.markdown).toBe(content)
    expect(document?.contentHash).toBe(sha256(content))
    expect(document?.filePath).toBe(skillPath)
    expect(Number.isNaN(Date.parse(document?.modifiedAt || ''))).toBe(false)
  })

  it('returns null for a missing file instead of throwing', () => {
    const root = fixtureRoot()
    expect(readSkillDocument(join(root, 'missing', 'SKILL.md'))).toBeNull()
  })

  // 自助更新的正确性依赖这条：Agent 覆盖 SKILL.md 后，health 必须立刻报出新版本。
  it('invalidates the cache once the file on disk is replaced', () => {
    const root = fixtureRoot()
    const skillPath = join(root, 'docs', 'skill', 'tracememo-reader', 'SKILL.md')
    writeSkill(skillPath, '1.3.0')
    expect(readSkillDocument(skillPath)?.version).toBe('1.3.0')

    writeSkill(skillPath, '1.4.0-with-a-longer-body-to-change-the-file-size')
    const updated = readSkillDocument(skillPath)
    expect(updated?.version).toBe('1.4.0-with-a-longer-body-to-change-the-file-size')
    expect(updated?.contentHash).not.toBe(sha256(skillBody('1.3.0')))
  })
})

describe('SKILL.md frontmatter contract', () => {
  it('parses name and version from a plain frontmatter block', () => {
    expect(parseSkillFrontmatter('---\nname: a\nversion: 2.1.0\n---\nbody')).toEqual({
      name: 'a',
      version: '2.1.0'
    })
  })

  it('ignores files without frontmatter and tolerates CRLF, quotes and comments', () => {
    expect(parseSkillFrontmatter('# no frontmatter\n')).toEqual({})
    expect(parseSkillFrontmatter('---\r\n# comment\r\nversion: "3.0.1"\r\n---\r\n')).toEqual({
      version: '3.0.1'
    })
  })

  /**
   * 防漂移契约：版本号只有一个真源，就是 SKILL.md 的 frontmatter。
   * 这里独立地按行正则提取一次，与解析结果逐字比对 —— 任何"把版本写回源码常量"的
   * 回归都会让这条测试变红。
   */
  it('keeps the reader Skill version declared in the repository SKILL.md', () => {
    const workspace = resolve(__dirname, '../..')
    const skillPath = join(workspace, 'docs', 'skill', 'tracememo-reader', 'SKILL.md')
    const content = readFileSync(skillPath, 'utf-8')
    const declared = /^version:[ \t]*(\S+)[ \t]*$/m.exec(content)

    expect(declared).not.toBeNull()
    expect(parseSkillFrontmatter(content).version).toBe(declared![1])
    expect(declared![1]).toMatch(/^\d+\.\d+\.\d+$/)

    const status = resolveSkillResourceStatus({
      appPath: workspace,
      cwd: workspace,
      resourcesPath: join(workspace, 'node_modules', 'electron', 'resources'),
      execPath: join(workspace, 'node_modules', 'electron', 'electron.exe'),
      packaged: false
    })
    expect(status).toMatchObject({
      available: true,
      source: 'development',
      version: declared![1],
      filePath: skillPath
    })
  })
})
