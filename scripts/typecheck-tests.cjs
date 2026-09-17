/*
 * 测试文件的类型检查棘轮（ratchet）。
 *
 * 背景：`tsconfig.node.json` / `tsconfig.web.json` 的 include 都不含 `tests/`，
 * 所以测试里的类型错误对 `pnpm typecheck` 与 CI 完全不可见——已经积累了一批历史债。
 *
 * 策略：**不阻塞既有债，但禁止新增**。
 *  - 基线按「文件 → 错误数」记录，而不是只记总数：
 *    否则在 A 文件修掉 1 条、同时在 B 文件新增 1 条会互相抵消，棘轮形同虚设。
 *  - 某个文件的错误数超过基线即失败；新增了带类型错误的文件同样失败。
 *  - 需要主动下调基线时用 `--update`（只在确实修好了错误之后）。
 *
 * 用法：
 *   node scripts/typecheck-tests.cjs            # 校验
 *   node scripts/typecheck-tests.cjs --update   # 用当前结果重写基线
 */
/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-require-imports */
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')
const configPath = path.join(projectRoot, 'tsconfig.test.json')
const baselinePath = path.join(projectRoot, 'tests', 'typecheck-baseline.json')
const ERROR_LINE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/
const MAX_REPORTED = 20

function runTypeScript() {
  // 直接用本地 typescript 包，避免依赖 node_modules/.bin 在各平台的差异。
  const tscPath = require.resolve('typescript/bin/tsc')
  const result = spawnSync(
    process.execPath,
    [tscPath, '--noEmit', '--pretty', 'false', '-p', configPath],
    { cwd: projectRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  )
  if (result.error) throw result.error
  return `${result.stdout || ''}${result.stderr || ''}`
}

function relative(file) {
  const rel = path.relative(projectRoot, path.resolve(projectRoot, file))
  return rel.split(path.sep).join('/')
}

/** 解析出「文件 → 错误数」与「文件 → 错误信息列表」。 */
function collectErrors(output) {
  const counts = new Map()
  const details = new Map()
  for (const line of output.split('\n')) {
    const match = ERROR_LINE.exec(line.trim())
    if (!match) continue
    const file = relative(match[1])
    counts.set(file, (counts.get(file) ?? 0) + 1)
    if (!details.has(file)) details.set(file, [])
    if (details.get(file).length < 3) details.get(file).push(`${match[2]}:${match[3]} ${match[4]}`)
  }
  return { counts, details }
}

function readBaseline() {
  try {
    const parsed = JSON.parse(fs.readFileSync(baselinePath, 'utf8'))
    if (parsed && typeof parsed.files === 'object' && parsed.files !== null) return parsed
  } catch {
    // 基线缺失或损坏时按「空基线」处理，会在下面明确报错提示。
  }
  return null
}

function total(counts) {
  let sum = 0
  for (const value of counts.values()) sum += value
  return sum
}

function main() {
  if (!fs.existsSync(configPath)) {
    console.error(`[typecheck:test] 缺少 ${path.relative(projectRoot, configPath)}`)
    process.exit(1)
  }
  const { counts, details } = collectErrors(runTypeScript())

  if (process.argv.includes('--update')) {
    const files = Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)))
    const payload = {
      note: '测试文件类型检查基线：只允许下降，不允许上升。用 node scripts/typecheck-tests.cjs --update 下调。',
      total: total(counts),
      files
    }
    fs.mkdirSync(path.dirname(baselinePath), { recursive: true })
    fs.writeFileSync(baselinePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    console.log(
      `[typecheck:test] 基线已更新：${payload.total} 个错误 / ${Object.keys(files).length} 个文件`
    )
    return
  }

  const baseline = readBaseline()
  if (!baseline) {
    console.error(
      `[typecheck:test] 找不到基线 ${path.relative(projectRoot, baselinePath)}。\n` +
        '  首次启用请运行：node scripts/typecheck-tests.cjs --update'
    )
    process.exit(1)
  }

  const regressions = []
  for (const [file, count] of counts) {
    const allowed = baseline.files[file] ?? 0
    if (count > allowed) regressions.push({ file, count, allowed })
  }

  const now = total(counts)
  const baselineTotal = Number(baseline.total) || 0
  const improved = baselineTotal - now

  if (regressions.length > 0) {
    console.error('[typecheck:test] 测试文件出现新的类型错误 ❌')
    console.error(`  基线 ${baselineTotal} → 当前 ${now}（+${now - baselineTotal}）\n`)
    let printed = 0
    for (const item of regressions) {
      console.error(`  ${item.file}  ${item.allowed} → ${item.count}`)
      for (const line of details.get(item.file) ?? []) {
        if (printed >= MAX_REPORTED) break
        console.error(`      ${line}`)
        printed += 1
      }
    }
    console.error('\n  修好之后用 --update 下调基线（不要为了过检查而放宽它）。')
    process.exit(1)
  }

  console.log(
    `[typecheck:test] PASS ✅ 当前 ${now} 个既有类型错误 / ${counts.size} 个文件` +
      (improved > 0 ? `（比基线少 ${improved} 个，可运行 --update 下调）` : '')
  )
  console.log('  注意：这是棘轮，只保证「不新增」。修完历史债后可改为阻断式检查。')
}

main()
