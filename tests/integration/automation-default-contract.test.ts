import { readFileSync } from 'fs-extra'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

import { createDefaultLeaveNotificationRule } from '../../src/shared/automation'
import { GROUP_EXIT_NOTIFICATION_TEMPLATE } from '../../src/shared/group-exit-monitor'

/**
 * E2E main 替身（`tests/e2e/support/electron-main.cjs`）的**默认值契约**。
 *
 * 替身扮演"一个全新安装的 main 进程"。它里面的默认值必须与真实默认值逐字一致，
 * 否则 E2E 与截图验证的就是一个**不存在的世界**。
 *
 * 这个契约是被真实事故逼出来的：迁移时把默认目标从"文件传输助手"改成"当前群聊"、
 * 并往默认模板里加了「群聊: {groupName}」一行，但替身没跟着改 ——
 * 于是截图里看到的是"当前群聊没被选中、模板也没有群聊行"，
 * 而组件测试却全绿（组件测试用的是内存 mock，不是替身）。
 */

const DOUBLE_PATH = join(process.cwd(), 'tests/e2e/support/electron-main.cjs')

/**
 * 取出替身里整条退群通知规则（该声明在文件里只出现一次）。
 *
 * 起点取 `let leaveNotificationRule = {` 而不是 `leaveNotification:` ——
 * `enabled` / `ruleType` / `cooldownSeconds` 都在嵌套的 leaveNotification 之前。
 */
function leaveNotificationBlock(): string {
  const source = readFileSync(DOUBLE_PATH, 'utf8')
  const start = source.indexOf('let leaveNotificationRule = {')
  expect(start, '替身里找不到 leaveNotificationRule').toBeGreaterThan(-1)
  return source.slice(start)
}

describe('E2E main 替身的默认值契约', () => {
  const defaults = createDefaultLeaveNotificationRule(0)

  it('退群通知的默认目标与真实默认值一致', () => {
    const block = leaveNotificationBlock()
    const match = block.match(/target:\s*\{\s*type:\s*'([a-z_]+)'/)

    expect(match?.[1]).toBe(defaults.leaveNotification?.target.type)
  })

  it('退群通知的默认模板与真实默认值逐字一致', () => {
    const block = leaveNotificationBlock()
    const match = block.match(/template:\s*'((?:[^'\\]|\\.)*)'/)

    expect(match, '替身里找不到 template 字面量').not.toBeNull()
    // 替身里是单引号 + \n 转义的 JS 字面量，反转义后与 shared 常量比对。
    const template = (match as RegExpMatchArray)[1].replace(/\\n/g, '\n')

    expect(template).toBe(defaults.leaveNotification?.template)
    expect(template).toBe(GROUP_EXIT_NOTIFICATION_TEMPLATE)
  })

  it('替身里必须存在群名占位符（否则截图看不出群名变量）', () => {
    expect(leaveNotificationBlock()).toContain('群聊: {groupName}')
  })

  it('起停/冷却语义与真实默认值一致', () => {
    const block = leaveNotificationBlock()

    expect(block).toMatch(/enabled:\s*true/)
    expect(block).toMatch(/ruleType:\s*'leave_notification'/)
    // 退群通知不套用消息型规则的冷却，否则两次退群会被并成一次。
    expect(block).toMatch(/cooldownSeconds:\s*0/)
  })

  it('替身里的日报规则类型与真实分派一致', () => {
    const source = readFileSync(DOUBLE_PATH, 'utf8')
    expect(source).toContain("ruleType: 'daily_report'")
  })
})
