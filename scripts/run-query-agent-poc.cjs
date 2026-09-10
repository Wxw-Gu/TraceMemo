#!/usr/bin/env node
/**
 * Query Agent POC 快速运行入口：直接执行已构建的 out/main/queryAgentPoc.js，不做任何构建。
 *
 * 与 `pnpm poc:query-agent` 的分工：
 *   - poc:query-agent       : 先 electron-vite build，再运行（代码改动后使用）
 *   - poc:query-agent:run   : 只运行现有构建产物（连续测试使用）
 *
 * 若构建产物不存在，给出明确提示；不会偷偷触发 full build，否则 fast-run 失去意义。
 *
 * 可选环境变量：
 *   TRACEMEMO_POC_ELECTRON  指定 Electron 可执行文件（默认取 node_modules 中的 electron）
 */
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const repoRoot = path.resolve(__dirname, '..')
const pocEntry = path.join(repoRoot, 'out', 'main', 'queryAgentPoc.js')

if (!fs.existsSync(pocEntry)) {
  process.stderr.write(
    [
      '',
      '[poc] POC build 不存在，请先运行：',
      '        pnpm poc:query-agent "你的问题"',
      '',
      `      预期构建产物：${path.relative(repoRoot, pocEntry)}`,
      '      （本入口有意不自动构建，以免失去快速运行的意义）',
      ''
    ].join('\n')
  )
  process.exit(1)
}

// 该入口的目标就是启动 Electron 主进程，因此必须清掉会让 Electron 退化成纯 Node 的标记。
// 部分 IDE 集成终端会注入 ELECTRON_RUN_AS_NODE=1。
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

// 在普通 Node 中 require('electron') 返回可执行文件路径。
const electronBinary = env.TRACEMEMO_POC_ELECTRON || require('electron')

const result = spawnSync(electronBinary, [pocEntry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: repoRoot,
  env
})

if (result.error) {
  process.stderr.write(`[poc] 启动 Electron 失败：${result.error.message}\n`)
  process.exit(1)
}
process.exit(typeof result.status === 'number' ? result.status : 1)
