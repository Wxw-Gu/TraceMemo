import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WECHAT_SEND_TYPES } from '../../src/shared/wechat-send'

/**
 * 发送类型的文档一致性守卫。
 *
 * 历史缺口：运行时白名单已经有 `file`，但 `docs/agent/api.md` 与 Reader Skill
 * 的 `type` 字段仍只写 `text/image/voice`，外部调用方会以为不支持文件。
 *
 * 这里直接比对「文档里 `type` 那一行」与运行时数组：新增类型但忘了改文档时，
 * 这两条会红，而不是等到用户试出来。
 */

const ROOT = path.resolve(__dirname, '../..')

function read(relativePath: string): string {
  return readFileSync(path.join(ROOT, relativePath), 'utf8')
}

function typeRowOf(markdown: string): string {
  const row = markdown
    .split('\n')
    .find((line) => /^\|\s*`type`\s*\|/.test(line))
  if (!row) throw new Error('文档里找不到 `type` 字段行')
  return row
}

describe('WECHAT_SEND_TYPES 与 API 文档同步', () => {
  it('docs/agent/api.md 的 `type` 行覆盖全部运行时类型', () => {
    const row = typeRowOf(read('docs/agent/api.md'))
    for (const type of WECHAT_SEND_TYPES) {
      expect(row).toContain(`\`${type}\``)
    }
  })

  it('Reader Skill 的 `type` 行覆盖全部运行时类型', () => {
    const row = typeRowOf(read('docs/skill/tracememo-reader/SKILL.md'))
    for (const type of WECHAT_SEND_TYPES) {
      expect(row).toContain(`\`${type}\``)
    }
  })

  it('仍然包含 file（防止回退）', () => {
    expect(WECHAT_SEND_TYPES).toContain('file')
    expect(typeRowOf(read('docs/agent/api.md'))).toContain('`file`')
    expect(typeRowOf(read('docs/skill/tracememo-reader/SKILL.md'))).toContain('`file`')
  })
})
