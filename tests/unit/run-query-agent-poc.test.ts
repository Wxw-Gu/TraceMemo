import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { afterAll, describe, expect, it } from 'vitest'

const repoRoot = process.cwd()
const sandboxes: string[] = []

/** 搭一个最小"仓库"：只放 runner 脚本，可选放假的构建产物。 */
function sandbox(withBuild: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'wxe-poc-run-'))
  sandboxes.push(dir)
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  copyFileSync(join(repoRoot, 'scripts', 'run-query-agent-poc.cjs'), join(dir, 'scripts', 'run-query-agent-poc.cjs'))
  if (withBuild) {
    mkdirSync(join(dir, 'out', 'main'), { recursive: true })
    writeFileSync(
      join(dir, 'out', 'main', 'queryAgentPoc.js'),
      'process.stdout.write(JSON.stringify({ ranEntry: true, argv: process.argv.slice(2) }) + "\\n")\n'
    )
  }
  return dir
}

function run(dir: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [join(dir, 'scripts', 'run-query-agent-poc.cjs'), ...args], {
    encoding: 'utf8',
    cwd: dir,
    env: { ...process.env, ...env }
  })
}

describe('poc:query-agent:run 快速入口', () => {
  afterAll(() => {
    for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true })
  })

  it('构建缺失时给出明确提示并退出码 1，不触发构建', () => {
    const result = run(sandbox(false), ['问题'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('POC build 不存在')
    expect(result.stderr).toContain('pnpm poc:query-agent')
    expect(result.stderr).toContain('不自动构建')
    expect(result.stdout).toBe('')
  })

  it('构建存在时直接执行，且原样转发参数（分隔符交给 entry 处理）', () => {
    const dir = sandbox(true)
    const result = run(dir, ['--', '我和BOBO第一次聊了什么'], { TRACEMEMO_POC_ELECTRON: process.execPath })
    expect(result.status).toBe(0)
    const payload = JSON.parse(result.stdout.trim()) as { ranEntry: boolean; argv: string[] }
    expect(payload.ranEntry).toBe(true)
    // runner 不修改参数：leading `--` 保留，由 POC entry 决定是否移除。
    expect(payload.argv).toEqual(['--', '我和BOBO第一次聊了什么'])
  })

  it('构建存在但启动器失败时返回非 0 退出码并给出提示', () => {
    const result = run(sandbox(true), ['问题'], { TRACEMEMO_POC_ELECTRON: '/nonexistent/electron-binary' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('启动 Electron 失败')
  })
})
