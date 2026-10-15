const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const filePath = path.join(
  __dirname,
  '..',
  'src',
  'renderer',
  'src',
  'features',
  'api-center',
  'utils',
  'buildSkillInstallInstruction.ts'
)
const source = fs.readFileSync(filePath, 'utf8')
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS }
}).outputText
const moduleExports = {}
new Function('exports', 'require', 'module', output)(moduleExports, require, {
  exports: moduleExports
})

const { buildSkillInstallInstruction } = moduleExports
const local = {
  type: 'local',
  directoryPath: 'C:/skill/tracememo-reader',
  skillPath: 'C:/skill/tracememo-reader/SKILL.md',
  version: 'v1.0'
}

for (const [target, expected] of [
  ['codex', 'Codex 项目或用户 Skill 目录'],
  ['claude-code', '按照 SKILL\.md 调用本地 HTTP API'],
  ['openclaw', '作为 TraceMemo Reader Skill 安装'],
  ['generic', '读取并安装']
]) {
  const text = buildSkillInstallInstruction({
    target,
    source: local,
    apiBaseUrl: { host: '127.0.0.1', port: 6131 }
  })
  assert.match(text, new RegExp(expected))
  assert.match(text, /http:\/\/127\.0\.0\.1:6131\/api\/v1\/health/)
  assert.match(text, /TRACEMEMO_API_TOKEN/)
  assert.match(text, /WECHATEXPLORER_API_TOKEN/)
  assert.match(text, /Authorization: Bearer/)
  assert.doesNotMatch(text, /mcpServers/)
}

assert.match(
  buildSkillInstallInstruction({
    target: 'codex',
    source: local,
    apiBaseUrl: { host: '0.0.0.0', port: 7000 }
  }),
  /http:\/\/127\.0\.0\.1:7000\/api\/v1\/health/
)
assert.match(
  buildSkillInstallInstruction({
    target: 'generic',
    source: { type: 'remote', installUrl: 'https://example.com/skill', version: 'v1.0' },
    apiBaseUrl: { host: 'localhost', port: 6131 }
  }),
  /https:\/\/example\.com\/skill/
)

// source.version 曾经是死字段：传进来却被模板丢掉，于是安装指令不携带任何版本信息。
for (const target of ['codex', 'claude-code', 'openclaw', 'generic']) {
  const text = buildSkillInstallInstruction({
    target,
    source: { ...local, version: '9.9.9' },
    apiBaseUrl: { host: '127.0.0.1', port: 6131 }
  })
  assert.match(text, /Skill 版本是 9\.9\.9/, `${target} 指令应携带 source.version`)
  assert.doesNotMatch(text, /v1\.0/, `${target} 不应残留 fixture 的旧版本号`)
  assert.match(text, /覆盖/, `${target} 指令应说明用新版本覆盖旧版本`)
}

// 指令要同时提醒 Agent 做版本自检，否则更新机制又只能靠人记得。
const selfCheckText = buildSkillInstallInstruction({
  target: 'codex',
  source: local,
  apiBaseUrl: { host: '127.0.0.1', port: 6131 }
})
assert.match(selfCheckText, /版本自检/)
assert.match(selfCheckText, /skill\.version/)

// 没有版本号时不编造：不输出版本段，其余指令保持可用。
const withoutVersion = buildSkillInstallInstruction({
  target: 'codex',
  source: { type: 'local', directoryPath: 'C:/skill/tracememo-reader', skillPath: 'x' },
  apiBaseUrl: { host: '127.0.0.1', port: 6131 }
})
assert.doesNotMatch(withoutVersion, /Skill 版本是/)
assert.match(withoutVersion, /TRACEMEMO_API_TOKEN/)

console.log('skill install instruction tests passed')
