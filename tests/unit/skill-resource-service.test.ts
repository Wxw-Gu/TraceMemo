import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  getSkillCandidates,
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

function writeSkill(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, '# TraceMemo Reader\n', 'utf8')
}

describe('Reader Skill resource resolution', () => {
  afterEach(() => {
    while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
  })

  it('finds the repository Skill from the current working directory in development', () => {
    const root = fixtureRoot()
    const runtime = environment(root, false)
    const skillPath = join(runtime.cwd, 'docs', 'skill', 'tracememo-reader', 'SKILL.md')
    writeSkill(skillPath)

    expect(resolveSkillResourceStatus(runtime)).toMatchObject({
      available: true,
      source: 'development',
      version: 'v1.2',
      filePath: skillPath,
      directoryPath: dirname(skillPath)
    })
  })

  it('resolves the Reader Skill from this checkout', () => {
    const workspace = resolve(__dirname, '../..')
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
      version: 'v1.2',
      filePath: join(workspace, 'docs', 'skill', 'tracememo-reader', 'SKILL.md')
    })
  })

  it('uses the extraResources Skill directory in a packaged runtime', () => {
    const root = fixtureRoot()
    const runtime = environment(root, true)
    const skillPath = join(runtime.resourcesPath, 'skill', 'tracememo-reader', 'SKILL.md')
    writeSkill(skillPath)

    expect(resolveSkillResourceStatus(runtime)).toMatchObject({
      available: true,
      source: 'bundled',
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
})
