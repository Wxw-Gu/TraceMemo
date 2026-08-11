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

console.log('skill install instruction tests passed')
