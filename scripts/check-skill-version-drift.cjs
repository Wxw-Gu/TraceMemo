#!/usr/bin/env node
/**
 * 防漂移检查：Reader Skill 的版本号只有一个真源 —— SKILL.md frontmatter 的 `version`。
 *
 * 只要本次变更动了 SKILL.md 的内容，就必须同时提升 version，否则外部 Agent
 * 无法通过 /health 上的 skill.version 发现自己手里的 Skill 已经过期，
 * 会继续按旧契约调用接口（历史上真实发生过：文档改了两轮，版本号没动）。
 *
 * 比较基准依次尝试 SKILL_VERSION_BASE / origin/main / origin/develop / HEAD~1；
 * 找不到基准（例如浅克隆）时只提示并跳过，不阻塞构建。
 */
const { execFileSync } = require('node:child_process')
const { readFileSync, existsSync } = require('node:fs')
const path = require('node:path')

const REQUESTED_BASE = 'SKILL_VERSION_BASE'
const SKILL_PATH = 'docs/skill/tracememo-reader/SKILL.md'
const SEMVER = /^\d+\.\d+\.\d+$/

function git(args) {
  return execFileSync('git', args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

function resolveBase() {
  const candidates = []
  if (process.env[REQUESTED_BASE]) candidates.push(process.env[REQUESTED_BASE])
  candidates.push('origin/main', 'origin/develop', 'HEAD~1')

  for (const candidate of candidates) {
    try {
      git(['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`])
      return candidate
    } catch {
      // 该基准不存在，继续尝试下一个
    }
  }
  return null
}

function versionOf(markdown) {
  if (!markdown) return null
  const match = /^version:[ \t]*(\S+)[ \t]*$/m.exec(markdown)
  return match ? match[1] : null
}

function skip(reason) {
  console.log(`[skill-version] 跳过版本漂移检查：${reason}`)
  process.exit(0)
}

function fail(message) {
  console.error(`[skill-version] FAIL：${message}`)
  process.exit(1)
}

const root = process.cwd()
const skillFile = path.join(root, SKILL_PATH)

if (!existsSync(skillFile)) fail(`找不到 ${SKILL_PATH}。`)

const current = readFileSync(skillFile, 'utf8')
const currentVersion = versionOf(current)

if (!currentVersion) {
  fail(`${SKILL_PATH} 的 frontmatter 缺少 version 字段。外部 Agent 依赖它做版本自检。`)
}
if (!SEMVER.test(currentVersion)) {
  fail(`${SKILL_PATH} 的 version "${currentVersion}" 不是 x.y.z 形式。`)
}

const base = resolveBase()
if (!base) skip('找不到可用的 git 比较基准（可能是浅克隆）。')

// 已提交的改动 + 工作区未提交的改动都要看，否则本地预检会漏掉。
let changedFiles = new Set()
try {
  for (const args of [
    ['diff', '--name-only', `${base}...HEAD`],
    ['diff', '--name-only', 'HEAD']
  ]) {
    for (const file of git(args).split('\n')) if (file) changedFiles.add(file)
  }
} catch (error) {
  skip(`无法计算与 ${base} 的差异（${error.message.split('\n')[0]}）。`)
}

if (!changedFiles.has(SKILL_PATH)) {
  console.log(`[skill-version] OK：与 ${base} 相比 ${SKILL_PATH} 未变更，无需提升版本。`)
  process.exit(0)
}

let previous = null
try {
  previous = git(['show', `${base}:${SKILL_PATH}`])
} catch {
  previous = null
}

const previousVersion = versionOf(previous)

if (previousVersion === null) {
  console.log(
    `[skill-version] OK：${base} 上没有可比较的 version，当前为 ${currentVersion}。`
  )
  process.exit(0)
}

if (previousVersion === currentVersion) {
  fail(
    `${SKILL_PATH} 内容已变更，但 version 仍是 ${currentVersion}（基准 ${base}）。\n` +
      '         外部 Agent 只能通过 version 判断自己是否过期，请提升该版本号（例如 1.3.0 → 1.4.0）。'
  )
}

console.log(
  `[skill-version] OK：版本随文档一起提升 ${previousVersion} → ${currentVersion}（基准 ${base}）。`
)
