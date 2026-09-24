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

import { BUILTIN_DAILY_REPORT_RULE_ID, BUILTIN_LEAVE_NOTIFICATION_RULE_ID } from '../../src/shared/automation'
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

/** 写旧退群监控状态文件（退群通知迁移的唯一输入）。 */
function writeLegacyMonitorState(input: {
  monitoredRoomIds?: string[]
  notificationRoomIds?: string[]
  notificationTemplate?: string
}): void {
  fs.writeJsonSync(path.join(root, 'group-exit-monitor.json'), input)
}

describe('AutomationRuleStore', () => {
  beforeEach(() => {
    fs.removeSync(path.join(root, 'automation'))
  })

  afterAll(() => fs.removeSync(root))

  it('首次加载会播种内置规则「@我生成日报」与「退群通知」并落盘', () => {
    const store = new AutomationRuleStore(deps(root))
    const rules = store.listRules()

    expect(rules).toHaveLength(2)
    const builtin = rules.find((rule) => rule.id === BUILTIN_DAILY_REPORT_RULE_ID)
    expect(builtin).toBeDefined()
    expect(builtin?.name).toBe('@我生成日报')
    expect(builtin?.ruleType).toBe('daily_report')
    expect(builtin?.enabled).toBe(true)
    expect(builtin?.scope).toBe('group')
    expect(builtin?.conditions.requireMentionMe).toBe(true)
    expect(builtin?.conditions.keyword).toBe('日报')
    expect(builtin?.conditions.ignoreSelf).toBe(true)
    expect(builtin?.cooldownSeconds).toBe(60)
    expect(builtin?.actions.map((action) => action.type)).toEqual([
      'replyText',
      'generateReport',
      'sendReportImage'
    ])
    expect(fs.pathExistsSync(rulesFile())).toBe(true)
  })

  it('全新安装的退群通知规则：默认目标是「当前群聊」', () => {
    const store = new AutomationRuleStore(deps(root))
    const leave = store.listRules().find((rule) => rule.id === BUILTIN_LEAVE_NOTIFICATION_RULE_ID)

    expect(leave).toBeDefined()
    expect(leave?.ruleType).toBe('leave_notification')
    expect(leave?.name).toBe('退群通知')
    // 「当前群聊」= 旧退群监控通知的原始行为，所以既是默认值也是第一项。
    expect(leave?.leaveNotification?.target).toEqual({ type: 'source_chat' })
    expect(leave?.leaveNotification?.targetNeedsReview).toBeUndefined()
    // 退群通知不套用消息型规则的冷却，避免把两次退群合并成一次。
    expect(leave?.cooldownSeconds).toBe(0)
    expect(leave?.actions).toEqual([])
  })

  it('删掉内置规则后不会在下次启动时被重新塞回来', () => {
    const store = new AutomationRuleStore(deps(root))
    expect(store.deleteRule(BUILTIN_DAILY_REPORT_RULE_ID)).toBe(true)
    expect(store.deleteRule(BUILTIN_LEAVE_NOTIFICATION_RULE_ID)).toBe(true)
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
    expect(created.ruleType).toBe('daily_report')
    expect(created.scope).toBe('group')
    expect(created.conditions.keywordMatchMode).toBe('contains')
    expect(created.conditions.conversationIds).toEqual(['a'])
    expect(created.createdAt).toBe(now)
    expect(created.updatedAt).toBe(now)
    expect(store.listRules()).toHaveLength(3)
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
    expect(store.listRules()).toHaveLength(2)
    expect(store.listRules().map((rule) => rule.id)).toEqual(
      expect.arrayContaining([BUILTIN_DAILY_REPORT_RULE_ID, BUILTIN_LEAVE_NOTIFICATION_RULE_ID])
    )
  })

  it('已播种但规则列表为空的存档不会被再次播种「@我生成日报」', () => {
    fs.ensureDirSync(path.dirname(rulesFile()))
    fs.writeJsonSync(rulesFile(), {
      version: 2,
      builtinSeeded: true,
      leaveNotificationMigrated: true,
      rules: []
    })

    const store = new AutomationRuleStore(deps(root))
    expect(store.listRules()).toHaveLength(0)
  })

  it('写入的是真实文件，重新打开能读到', () => {
    const store = new AutomationRuleStore(deps(root))
    store.createRule({ name: '持久化检查', conditions: {}, actions: [] })

    const reopened = new AutomationRuleStore(deps(root))
    expect(reopened.listRules().map((rule) => rule.name)).toContain('持久化检查')
  })

  it('saveLeaveNotificationRule 是 singleton upsert：保存多次也只有一条', () => {
    const store = new AutomationRuleStore(deps(root))
    for (let index = 0; index < 3; index += 1) {
      store.saveLeaveNotificationRule({
        name: '退群通知',
        enabled: true,
        ruleType: 'leave_notification',
        scope: 'group',
        conditions: {},
        actions: [],
        cooldownSeconds: 0,
        replyDelaySeconds: 2,
        leaveNotification: {
          target: { type: 'contact', contactId: `wxid_friend_${index}` },
          template: '[退群监测]\n用户: {user}'
        }
      })
    }

    const leaveRules = store
      .listRules()
      .filter((rule) => rule.id === BUILTIN_LEAVE_NOTIFICATION_RULE_ID)
    expect(leaveRules).toHaveLength(1)
    expect(leaveRules[0].leaveNotification?.target).toEqual({
      type: 'contact',
      contactId: 'wxid_friend_2'
    })
  })

  it('保存退群通知会清掉迁移遗留的「目标待重选」标记', () => {
    writeLegacyMonitorState({
      monitoredRoomIds: ['a@chatroom', 'b@chatroom'],
      notificationRoomIds: ['a@chatroom']
    })
    const store = new AutomationRuleStore(deps(root))
    expect(
      store.getRule(BUILTIN_LEAVE_NOTIFICATION_RULE_ID)?.leaveNotification?.targetNeedsReview
    ).toBe(true)

    store.saveLeaveNotificationRule({
      ...store.getRule(BUILTIN_LEAVE_NOTIFICATION_RULE_ID),
      enabled: true,
      leaveNotification: { target: { type: 'source_chat' }, template: '[退群监测]' }
    })

    const saved = store.getRule(BUILTIN_LEAVE_NOTIFICATION_RULE_ID)
    expect(saved?.leaveNotification?.targetNeedsReview).toBeUndefined()
    expect(saved?.leaveNotification?.target).toEqual({ type: 'source_chat' })
  })

  /*
   * 加上群名变量之前的默认模板（有「人数」行、没有「群聊」行）。
   * 这正是老用户手上那份 —— 模板是他们的已保存数据。
   */
  const PREVIOUS_DEFAULT_TEMPLATE = [
    '[退群监测]',
    '',
    '用户: {user}',
    '',
    '群备注: {groupRemark}',
    '',
    '微信号: {wxid}',
    '',
    '人数: {previousCount} -> {currentCount}',
    '',
    '退群时间: {time}'
  ].join('\n')

  /** 写一份"老用户"的规则文件（退群通知模板里没有群名变量）。 */
  function writeRulesWithTemplate(
    template: string,
    flags: { notificationTemplateUpgraded?: boolean } = {}
  ): void {
    fs.ensureDirSync(path.dirname(rulesFile()))
    fs.writeJsonSync(rulesFile(), {
      version: 2,
      builtinSeeded: true,
      leaveNotificationMigrated: true,
      notificationTemplateUpgraded: flags.notificationTemplateUpgraded === true,
      rules: [
        {
          id: BUILTIN_DAILY_REPORT_RULE_ID,
          name: '@我生成日报',
          enabled: true,
          ruleType: 'daily_report',
          trigger: 'message',
          scope: 'group',
          conditions: { requireMentionMe: true, keyword: '日报', keywordMatchMode: 'contains' },
          actions: [{ type: 'generateReplyText', enabled: true }],
          cooldownSeconds: 60,
          replyDelaySeconds: 2,
          createdAt: 1,
          updatedAt: 1
        },
        {
          id: BUILTIN_LEAVE_NOTIFICATION_RULE_ID,
          name: '退群通知',
          enabled: true,
          ruleType: 'leave_notification',
          trigger: 'message',
          scope: 'group',
          conditions: { requireMentionMe: false, keyword: '', keywordMatchMode: 'contains' },
          actions: [],
          cooldownSeconds: 0,
          replyDelaySeconds: 2,
          leaveNotification: { target: { type: 'source_chat' }, template },
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })
  }

  describe('替用户把群名变量补进模板（一次性）', () => {
    it('老用户首次读盘时自动补上「群聊」这一行，其余内容保留', () => {
      writeRulesWithTemplate(PREVIOUS_DEFAULT_TEMPLATE)

      const rule = new AutomationRuleStore(deps(root)).getRule(BUILTIN_LEAVE_NOTIFICATION_RULE_ID)
      const template = rule?.leaveNotification?.template ?? ''

      expect(template).toContain('群聊: {groupName}')
      // 原来每一行都还在。
      for (const line of PREVIOUS_DEFAULT_TEMPLATE.split('\n')) {
        if (line.trim()) expect(template).toContain(line)
      }
    })

    it('只补一次：之后用户删掉这一行，重启不会被加回来', () => {
      writeRulesWithTemplate(PREVIOUS_DEFAULT_TEMPLATE)
      // 第一轮：自动补上，并落盘标记。
      const first = new AutomationRuleStore(deps(root))
      expect(first.getRule(BUILTIN_LEAVE_NOTIFICATION_RULE_ID)?.leaveNotification?.template).toContain(
        '群聊: {groupName}'
      )

      // 用户主动把这一行删掉并保存。
      const stripped = PREVIOUS_DEFAULT_TEMPLATE
      first.saveLeaveNotificationRule({
        ...first.getRule(BUILTIN_LEAVE_NOTIFICATION_RULE_ID),
        leaveNotification: { target: { type: 'source_chat' }, template: stripped }
      })

      // 重启：不能再替他补 —— "删不掉"比缺信息更讨厌。
      const reopened = new AutomationRuleStore(deps(root))
      expect(
        reopened.getRule(BUILTIN_LEAVE_NOTIFICATION_RULE_ID)?.leaveNotification?.template
      ).toBe(stripped)
    })

    it('已经含 {groupName} 的模板原样不动', () => {
      const already = '[退群监测]\n\n群聊: {groupName}\n\n用户: {user}'
      writeRulesWithTemplate(already)

      const rule = new AutomationRuleStore(deps(root)).getRule(BUILTIN_LEAVE_NOTIFICATION_RULE_ID)
      expect(rule?.leaveNotification?.template).toBe(already)
    })

    it('用户完全自定义的模板也不会被覆盖内容', () => {
      writeRulesWithTemplate('退群: {user}')

      const rule = new AutomationRuleStore(deps(root)).getRule(BUILTIN_LEAVE_NOTIFICATION_RULE_ID)
      const template = rule?.leaveNotification?.template ?? ''

      expect(template).toContain('退群: {user}')
      expect(template).toContain('群聊: {groupName}')
    })

    it('标记已是 true 时不再动模板', () => {
      writeRulesWithTemplate(PREVIOUS_DEFAULT_TEMPLATE, { notificationTemplateUpgraded: true })

      const rule = new AutomationRuleStore(deps(root)).getRule(BUILTIN_LEAVE_NOTIFICATION_RULE_ID)
      expect(rule?.leaveNotification?.template).toBe(PREVIOUS_DEFAULT_TEMPLATE)
    })

    it('全新安装的模板本来就带群名，不需要补', () => {
      const rule = new AutomationRuleStore(deps(root)).getRule(BUILTIN_LEAVE_NOTIFICATION_RULE_ID)
      expect(rule?.leaveNotification?.template).toContain('群聊: {groupName}')
    })
  })

  describe('旧退群通知配置迁移', () => {
    it('旧配置从不通知任何人 → 迁移成关闭，且保留自定义模板', () => {
      writeLegacyMonitorState({
        monitoredRoomIds: ['a@chatroom', 'b@chatroom'],
        notificationRoomIds: [],
        notificationTemplate: '退群: {user}'
      })

      const leave = new AutomationRuleStore(deps(root)).getRule(
        BUILTIN_LEAVE_NOTIFICATION_RULE_ID
      )

      expect(leave?.enabled).toBe(false)
      // 关闭状态下 target 只是占位值（= 默认目标），不会发送任何东西。
      expect(leave?.leaveNotification?.target).toEqual({ type: 'source_chat' })
      // 用户写的模板内容保留；同一次启动的"补群名"升级会另加一行。
      expect(leave?.leaveNotification?.template).toContain('退群: {user}')
      expect(leave?.leaveNotification?.template).toContain('群聊: {groupName}')
    })

    it('旧配置在每个被监控群都通知 → 无损映射为「当前群聊」且保持启用', () => {
      writeLegacyMonitorState({
        monitoredRoomIds: ['a@chatroom', 'b@chatroom'],
        notificationRoomIds: ['a@chatroom', 'b@chatroom']
      })

      const leave = new AutomationRuleStore(deps(root)).getRule(
        BUILTIN_LEAVE_NOTIFICATION_RULE_ID
      )

      expect(leave?.enabled).toBe(true)
      expect(leave?.leaveNotification?.target).toEqual({ type: 'source_chat' })
      expect(leave?.leaveNotification?.targetNeedsReview).toBeUndefined()
    })

    /*
     * 关键的一条：旧「通知群聊」是**逐群**的多值配置，新目标是**单值**。
     * 只勾了一部分时无法无损映射 —— 这时候：
     * 不取第一个群、不改写成当前群聊、保持关闭、要求用户重选，并留一份备份。
     */
    it('旧配置只勾了部分群 → 标记待重选、不发送、留下备份，绝不猜', () => {
      writeLegacyMonitorState({
        monitoredRoomIds: ['a@chatroom', 'b@chatroom', 'c@chatroom'],
        notificationRoomIds: ['b@chatroom'],
        notificationTemplate: '退群: {user}'
      })

      const store = new AutomationRuleStore(deps(root))
      const leave = store.getRule(BUILTIN_LEAVE_NOTIFICATION_RULE_ID)

      expect(leave?.enabled).toBe(false)
      expect(leave?.leaveNotification?.targetNeedsReview).toBe(true)
      // 不回落到「取第一个群」，也不改写成别的具体目标 —— 只留默认占位（当前群聊），
      // 且因为 enabled=false + targetNeedsReview=true，在用户重选之前不会发送。
      expect(leave?.leaveNotification?.target).toEqual({ type: 'source_chat' })
      // 用户写的模板内容保留；同一次启动的"补群名"升级会另加一行。
      expect(leave?.leaveNotification?.template).toContain('退群: {user}')
      expect(leave?.leaveNotification?.template).toContain('群聊: {groupName}')

      const backup = fs.readJsonSync(
        path.join(root, 'automation', 'leave-notification-migration-backup.json')
      )
      expect(backup).toMatchObject({
        outcome: 'needs_review',
        legacy: { notificationRoomIds: ['b@chatroom'] }
      })
      expect(store.getLastLeaveNotificationMigration()?.outcome).toBe('needs_review')
    })

    it('迁移只跑一次：重启两次也只有一条退群通知规则', () => {
      writeLegacyMonitorState({
        monitoredRoomIds: ['a@chatroom', 'b@chatroom'],
        notificationRoomIds: ['a@chatroom', 'b@chatroom']
      })

      const first = new AutomationRuleStore(deps(root))
      const second = new AutomationRuleStore(deps(root))

      for (const store of [first, second]) {
        expect(
          store.listRules().filter((rule) => rule.id === BUILTIN_LEAVE_NOTIFICATION_RULE_ID)
        ).toHaveLength(1)
      }
    })

    it('迁移完成标记会被持久化，删掉退群通知规则后重启不会再被塞回来', () => {
      const store = new AutomationRuleStore(deps(root))
      expect(store.deleteRule(BUILTIN_LEAVE_NOTIFICATION_RULE_ID)).toBe(true)

      const reopened = new AutomationRuleStore(deps(root))
      expect(reopened.getRule(BUILTIN_LEAVE_NOTIFICATION_RULE_ID)).toBeUndefined()
    })

    it('旧状态文件在迁移后仍留在磁盘上（不做不可逆删除）', () => {
      writeLegacyMonitorState({
        monitoredRoomIds: ['a@chatroom'],
        notificationRoomIds: ['a@chatroom']
      })

      void new AutomationRuleStore(deps(root))

      expect(fs.pathExistsSync(path.join(root, 'group-exit-monitor.json'))).toBe(true)
    })
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
