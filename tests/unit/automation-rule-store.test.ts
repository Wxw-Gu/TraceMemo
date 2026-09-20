import fs from 'fs-extra'
import path from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const root = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path')
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wxe-automation-rule-store-'))
})

vi.mock('electron', () => ({ app: { getPath: () => root } }))

import { BUILTIN_DAILY_REPORT_RULE_ID } from '../../src/shared/automation'
import {
  AutomationRuleStore,
  type AutomationRuleStoreDependencies
} from '../../src/main/services/automation-rule-store'
import { AutomationExecutionLogService } from '../../src/main/services/automation-execution-log-service'
import type { AutomationExecution } from '../../src/shared/automation'

const rulesFile = (): string => path.join(root, 'automation', 'rules.json')
const executionsFile = (): string => path.join(root, 'automation', 'executions.json')

/** 只重定向目录，其余用真实实现 —— 目的是验证真实的读写与归一化。 */
const deps = (dir: string, now?: () => number): AutomationRuleStoreDependencies => ({
  userDataPath: () => dir,
  ...(now ? { now } : {})
})

describe('AutomationRuleStore', () => {
  beforeEach(() => {
    fs.removeSync(path.join(root, 'automation'))
  })

  afterAll(() => fs.removeSync(root))

  it('首次加载会播种内置规则「@我生成日报」并落盘', () => {
    const store = new AutomationRuleStore(deps(root))
    const rules = store.listRules()

    expect(rules).toHaveLength(1)
    const builtin = rules[0]
    expect(builtin.id).toBe(BUILTIN_DAILY_REPORT_RULE_ID)
    expect(builtin.name).toBe('@我生成日报')
    expect(builtin.enabled).toBe(true)
    expect(builtin.scope).toBe('group')
    expect(builtin.conditions.requireMentionMe).toBe(true)
    expect(builtin.conditions.keyword).toBe('日报')
    expect(builtin.conditions.ignoreSelf).toBe(true)
    expect(builtin.cooldownSeconds).toBe(60)
    expect(builtin.actions.map((action) => action.type)).toEqual([
      'replyText',
      'generateReport',
      'sendReportImage'
    ])
    expect(fs.pathExistsSync(rulesFile())).toBe(true)
  })

  it('删掉内置规则后不会在下次启动时被重新塞回来', () => {
    const store = new AutomationRuleStore(deps(root))
    expect(store.deleteRule(BUILTIN_DAILY_REPORT_RULE_ID)).toBe(true)
    expect(store.listRules()).toHaveLength(0)

    // 关键：新实例（等于重启）不应该重新播种。
    const reopened = new AutomationRuleStore(deps(root))
    expect(reopened.listRules()).toHaveLength(0)
  })

  it('createRule 归一化脏输入并补上 id 与时间戳', () => {
    const now = 1_700_000_000_000
    const store = new AutomationRuleStore(deps(root, () => now))
    const created = store.createRule({
      name: '  关键词回复  ',
      scope: 'bogus',
      conditions: { keyword: '周报', keywordMatchMode: 'regex', conversationIds: ['a', ''] },
      actions: [{ type: 'replyText', enabled: true, text: '好的' }],
      cooldownSeconds: 30
    })

    expect(created.id).not.toBe(BUILTIN_DAILY_REPORT_RULE_ID)
    expect(created.name).toBe('关键词回复')
    expect(created.scope).toBe('group')
    expect(created.conditions.keywordMatchMode).toBe('contains')
    expect(created.conditions.conversationIds).toEqual(['a'])
    expect(created.createdAt).toBe(now)
    expect(created.updatedAt).toBe(now)
    expect(store.listRules()).toHaveLength(2)
  })

  it('updateRule 保留 id 与 createdAt，刷新 updatedAt', () => {
    let now = 1_000
    const store = new AutomationRuleStore(deps(root, () => now))
    const created = store.createRule({ name: 'A', conditions: {}, actions: [] })
    now = 2_000
    const updated = store.updateRule(created.id, {
      name: 'B',
      conditions: { keyword: 'x' },
      actions: [{ type: 'generateReport', enabled: true }]
    })

    expect(updated?.id).toBe(created.id)
    expect(updated?.createdAt).toBe(1_000)
    expect(updated?.updatedAt).toBe(2_000)
    expect(updated?.name).toBe('B')
    expect(updated?.conditions.keyword).toBe('x')
  })

  it('updateRule 名称为空时沿用原名，而不是变成「未命名自动化」', () => {
    const store = new AutomationRuleStore(deps(root))
    const builtin = store.listRules()[0]
    const updated = store.updateRule(builtin.id, { ...builtin, name: '   ' })
    expect(updated?.name).toBe('@我生成日报')
  })

  it('setRuleEnabled 只改开关', () => {
    const store = new AutomationRuleStore(deps(root))
    const builtin = store.listRules()[0]
    const disabled = store.setRuleEnabled(builtin.id, false)
    expect(disabled?.enabled).toBe(false)
    expect(disabled?.conditions.keyword).toBe('日报')
    expect(store.listRules()[0].enabled).toBe(false)
  })

  it('对不存在的 id 做更新/启停返回 undefined，删除返回 false', () => {
    const store = new AutomationRuleStore(deps(root))
    expect(store.updateRule('nope', { name: 'x' })).toBeUndefined()
    expect(store.setRuleEnabled('nope', true)).toBeUndefined()
    expect(store.deleteRule('nope')).toBe(false)
  })

  it('规则文件损坏时降级为空并重新播种，而不是让功能整体不可用', () => {
    fs.ensureDirSync(path.dirname(rulesFile()))
    fs.writeFileSync(rulesFile(), '{ 这不是 JSON', 'utf8')

    const store = new AutomationRuleStore(deps(root))
    expect(store.listRules()).toHaveLength(1)
    expect(store.listRules()[0].id).toBe(BUILTIN_DAILY_REPORT_RULE_ID)
  })

  it('已播种但规则列表为空的存档不会被再次播种', () => {
    fs.ensureDirSync(path.dirname(rulesFile()))
    fs.writeJsonSync(rulesFile(), { version: 1, builtinSeeded: true, rules: [] })

    const store = new AutomationRuleStore(deps(root))
    expect(store.listRules()).toHaveLength(0)
  })

  it('写入的是真实文件，重新打开能读到', () => {
    const store = new AutomationRuleStore(deps(root))
    store.createRule({ name: '持久化检查', conditions: {}, actions: [] })

    const reopened = new AutomationRuleStore(deps(root))
    expect(reopened.listRules().map((rule) => rule.name)).toContain('持久化检查')
  })
})

describe('AutomationExecutionLogService', () => {
  beforeEach(() => {
    fs.removeSync(path.join(root, 'automation'))
  })

  const execution = (overrides: Partial<AutomationExecution> = {}): AutomationExecution => ({
    executionId: 'exec-1',
    ruleId: 'rule-1',
    ruleName: '测试规则',
    triggerTime: 1_700_000_000_000,
    sourceDisplayName: '测试群',
    status: 'success',
    durationMs: 1_234,
    steps: [{ key: 'received', label: '收到消息', status: 'success' }],
    ...overrides
  })

  it('记录并返回，新的在前', () => {
    const log = new AutomationExecutionLogService({ userDataPath: () => root })
    log.record(execution({ executionId: 'a', ruleName: '规则A' }))
    log.record(execution({ executionId: 'b', ruleName: '规则B' }))

    expect(log.list().map((item) => item.ruleName)).toEqual(['规则B', '规则A'])
  })

  it('相同 executionId 会覆盖而不是追加（先 running 后终态）', () => {
    const log = new AutomationExecutionLogService({ userDataPath: () => root })
    log.record(execution({ status: 'running', steps: [] }))
    log.record(execution({ status: 'failed', errorSummary: '生成日报失败' }))

    const records = log.list()
    expect(records).toHaveLength(1)
    expect(records[0].status).toBe('failed')
    expect(records[0].errorSummary).toBe('生成日报失败')
  })

  it('容量有界，超出后丢弃最旧的', () => {
    const log = new AutomationExecutionLogService({ userDataPath: () => root })
    for (let index = 0; index < 250; index += 1) {
      log.record(execution({ executionId: `exec-${index}`, ruleName: `规则${index}` }))
    }
    const records = log.list({ limit: 1000 })
    expect(records).toHaveLength(200)
    expect(records[0].ruleName).toBe('规则249')
    expect(records.some((item) => item.ruleName === '规则49')).toBe(false)
  })

  it('countSince 只统计时间窗口内的记录', () => {
    const log = new AutomationExecutionLogService({ userDataPath: () => root })
    log.record(execution({ executionId: 'old', triggerTime: 1_000, status: 'success' }))
    log.record(execution({ executionId: 'new-ok', triggerTime: 5_000, status: 'success' }))
    log.record(execution({ executionId: 'new-bad', triggerTime: 6_000, status: 'failed' }))

    expect(log.countSince(4_000)).toEqual({ total: 2, success: 1 })
    expect(log.countSince(0)).toEqual({ total: 3, success: 2 })
  })

  it('clear 清空并落盘', () => {
    const log = new AutomationExecutionLogService({ userDataPath: () => root })
    log.record(execution())
    expect(log.clear()).toBe(true)
    expect(log.list()).toHaveLength(0)
    expect(new AutomationExecutionLogService({ userDataPath: () => root }).list()).toHaveLength(0)
  })

  it('落盘后新实例能读到（重启后仍能看到近期执行记录）', () => {
    const log = new AutomationExecutionLogService({ userDataPath: () => root })
    log.record(execution({ ruleName: '重启检查' }))
    expect(fs.pathExistsSync(executionsFile())).toBe(true)

    const reloaded = new AutomationExecutionLogService({ userDataPath: () => root })
    expect(reloaded.list()[0].ruleName).toBe('重启检查')
  })

  it('文件损坏时降级为空数组而不是抛异常', () => {
    fs.ensureDirSync(path.dirname(executionsFile()))
    fs.writeFileSync(executionsFile(), 'not json at all', 'utf8')
    const log = new AutomationExecutionLogService({ userDataPath: () => root })
    expect(log.list()).toEqual([])
  })

  it('丢弃缺少 executionId 的脏记录', () => {
    const log = new AutomationExecutionLogService({ userDataPath: () => root })
    log.record({ ...execution(), executionId: '   ' })
    expect(log.list()).toHaveLength(0)
  })

  it('list 的 limit 参数生效', () => {
    const log = new AutomationExecutionLogService({ userDataPath: () => root })
    for (let index = 0; index < 10; index += 1) {
      log.record(execution({ executionId: `exec-${index}` }))
    }
    expect(log.list({ limit: 3 })).toHaveLength(3)
  })
})
