import { describe, expect, it } from 'vitest'

import {
  planScheduledReportMigration,
  planScheduledReportMigrationBatch,
  scheduledReportMigrationRuleId,
  type LegacyScheduledReportTask
} from '../../src/main/services/scheduled-report-migration'
import { SCHEDULED_REPORT_DEFAULT_MEMBER_NAME_MODE } from '../../src/shared/automation'

/**
 * 旧「定时日报任务」→ `AutomationRule(ruleType='scheduled_report')` 的映射器。
 *
 * 这是本次迁移里**唯一会改变用户既有行为**的地方，所以每条断言都对应一条产品约束：
 * - Rule ID 优先复用旧 taskId（不许拿显示名当稳定 ID）；
 * - 配置无损映射（时间 / 范围 / 消息类型 / 模板 / 成员名口径 / 超时）；
 * - 只有"能证明是同一个群"才无损映射成 `source_chat`；
 *   历史行为事实上支持"生成 A 群日报 → 发 B 群"，新产品不支持 ⇒ 必须 `targetNeedsReview`
 *   且 **enabled = false**，绝不自动改写、绝不静默丢掉目标；
 * - 解析不到群标识时**保留原值**，运行期如实失败，而不是在这里猜一个群；
 * - 批次按 id 去重 ⇒ 幂等（同一份文件跑两次结果一致）。
 */

const NOW = Date.parse('2026-08-27T10:00:00+08:00')

/** 假联系人表：md5 / 群名 → roomId。 */
const CONTACTS: Record<string, string> = {
  'tech-md5': 'tech@chatroom',
  'product-md5': 'product@chatroom',
  '技术交流群': 'tech@chatroom'
}

/**
 * 与 main 侧 `setLegacyConversationResolver` 注入的真实解析器**同口径**：
 * - 以 `@chatroom` 结尾 ⇒ 原样返回（旧 UI 的 `target` 存的就是 roomId，
 *   而 `chat.resolveMd5` 对 roomId 是查不到的，所以这条 pass-through 是必需的）；
 * - 否则按 md5 / 群名查联系人表。
 */
const resolve = (raw: string): string | undefined => {
  const key = raw.trim()
  if (!key) return undefined
  if (key.endsWith('@chatroom')) return key
  return CONTACTS[key]
}

const task = (overrides: LegacyScheduledReportTask = {}): LegacyScheduledReportTask => ({
  id: 'scheduled_report_old_1',
  name: '技术交流群 · 每日日报',
  group: 'tech-md5',
  target: 'tech@chatroom',
  scheduleTime: '09:15',
  reportRange: 'yesterday',
  messageTypes: ['text', 'image'],
  templateId: 'v1',
  memberNameMode: 'wechatNickname',
  timeoutSeconds: 600,
  enabled: true,
  createdAt: '2026-08-01T01:00:00.000Z',
  updatedAt: '2026-08-20T01:00:00.000Z',
  ...overrides
})

describe('定时日报迁移 · Rule ID', () => {
  it('优先原样复用旧 taskId（不拿显示名当稳定 ID）', () => {
    expect(scheduledReportMigrationRuleId(task())).toBe('scheduled_report_old_1')

    // 改名字不影响 id —— 显示名不是身份。
    expect(scheduledReportMigrationRuleId(task({ name: '换个名字' }))).toBe(
      'scheduled_report_old_1'
    )
  })

  it('旧 id 缺失时退化成由稳定字段派生的确定性 id（重复迁移不产生新规则）', () => {
    const broken = task({ id: undefined })
    const first = scheduledReportMigrationRuleId(broken)
    const second = scheduledReportMigrationRuleId({ ...broken })

    expect(first).toMatch(/^scheduled-report:[0-9a-f]{32}$/)
    expect(second).toBe(first)
  })

  it('id 全是空白字符时同样走派生路径', () => {
    expect(scheduledReportMigrationRuleId(task({ id: '   ' }))).toMatch(/^scheduled-report:/)
  })
})

describe('定时日报迁移 · 逐字段无损映射', () => {
  it('配置字段一个不丢（不是"看起来差不多"）', () => {
    const plan = planScheduledReportMigration(task(), resolve, NOW)

    expect(plan.outcome).toBe('lossless_source_chat')
    expect(plan.name).toBe('技术交流群 · 每日日报')
    expect(plan.enabled).toBe(true)
    expect(plan.config.schedule).toEqual({ time: '09:15' })
    expect(plan.config.report).toEqual({
      // 来源群存**稳定会话 id**：旧值 'tech-md5' 被解析成 roomId。
      sourceConversationId: 'tech@chatroom',
      range: 'yesterday',
      messageTypes: ['text', 'image'],
      templateId: 'v1',
      memberNameMode: 'wechatNickname',
      timeoutSeconds: 600
    })
    expect(plan.config.target).toEqual({ type: 'source_chat' })
    expect(plan.config.targetNeedsReview).toBeUndefined()
    expect(plan.config.legacyTarget).toBeUndefined()
    // 来源群被改写过 ⇒ 留下原文方便用户核对。
    expect(plan.config.legacySourceGroup).toBe('tech-md5')
  })

  it('createdAt / updatedAt 继承旧值（ISO → 毫秒），非法值回落迁移时刻', () => {
    const plan = planScheduledReportMigration(task(), resolve, NOW)
    expect(plan.createdAt).toBe(Date.parse('2026-08-01T01:00:00.000Z'))
    expect(plan.updatedAt).toBe(Date.parse('2026-08-20T01:00:00.000Z'))

    const broken = planScheduledReportMigration(
      task({ createdAt: '不是时间', updatedAt: undefined }),
      resolve,
      NOW
    )
    expect(broken.createdAt).toBe(NOW)
    expect(broken.updatedAt).toBe(NOW)
  })

  it('继承调度游标（lastRunAt / lastScheduledSlot），避免迁移后重复补跑', () => {
    const slot = new Date('2026-08-26T09:15:00+08:00').toISOString()
    const plan = planScheduledReportMigration(
      task({ lastRunAt: '2026-08-26T01:15:00.000Z', lastScheduledSlot: slot }),
      resolve,
      NOW
    )

    expect(plan.config.lastRunAt).toBe('2026-08-26T01:15:00.000Z')
    expect(plan.config.lastScheduledSlot).toBe(slot)
  })

  it('脏值一律收敛到合法默认值，绝不落一条跑不起来的规则', () => {
    const plan = planScheduledReportMigration(
      task({
        scheduleTime: '99:99',
        reportRange: '一个不存在的范围',
        messageTypes: ['不存在的类型'],
        templateId: '不存在的模板',
        memberNameMode: '不存在的口径',
        timeoutSeconds: 999999
      }),
      resolve,
      NOW
    )

    expect(plan.config.schedule.time).toBe('18:30')
    expect(plan.config.report.range).toBe('today')
    expect(plan.config.report.messageTypes).toEqual(['text'])
    expect(plan.config.report.templateId).toBe('v1')
    expect(plan.config.report.memberNameMode).toBe(SCHEDULED_REPORT_DEFAULT_MEMBER_NAME_MODE)
    expect(plan.config.report.timeoutSeconds).toBe(1800)
  })

  it('名字缺失时回落到「定时日报」，不会留一条空名字的规则', () => {
    expect(planScheduledReportMigration(task({ name: '  ' }), resolve, NOW).name).toBe('定时日报')
  })
})

describe('定时日报迁移 · 发送目标（唯一会改变行为的地方）', () => {
  it('target 为空 ⇒ 旧系统本就回落到来源群，等价于 source_chat', () => {
    const plan = planScheduledReportMigration(task({ target: '' }), resolve, NOW)
    expect(plan.outcome).toBe('lossless_source_chat')
    expect(plan.config.target).toEqual({ type: 'source_chat' })
    expect(plan.config.targetNeedsReview).toBeUndefined()
  })

  it('target 与 group 文本相同 ⇒ 无损映射（不依赖能否解析）', () => {
    const plan = planScheduledReportMigration(
      task({ group: 'tech-md5', target: 'tech-md5' }),
      () => undefined,
      NOW
    )
    expect(plan.outcome).toBe('lossless_source_chat')
    expect(plan.config.targetNeedsReview).toBeUndefined()
  })

  it('两者都解析到同一个 roomId ⇒ 无损映射（旧 UI 的常态：group=md5, target=roomId）', () => {
    const plan = planScheduledReportMigration(
      task({ group: 'tech-md5', target: 'tech@chatroom' }),
      resolve,
      NOW
    )
    expect(plan.outcome).toBe('lossless_source_chat')

    // 这条无损判定**依赖**解析器对 `@chatroom` 的 pass-through：
    // 少了它，旧 UI 里每一组 (md5, roomId) 都会退化成 needs_review，
    // 等于把所有用户的定时日报全部停用。
    expect(resolve('tech@chatroom')).toBe('tech@chatroom')
  })

  it('target 指向**另一个群** ⇒ needs_review + 强制停用 + 保留旧目标原文', () => {
    const plan = planScheduledReportMigration(
      task({ group: 'tech-md5', target: 'product@chatroom' }),
      resolve,
      NOW
    )

    expect(plan.outcome).toBe('needs_review')
    // 不能自动改写目标，也不能在用户确认前就被定时发出去。
    expect(plan.enabled).toBe(false)
    expect(plan.config.targetNeedsReview).toBe(true)
    expect(plan.config.legacyTarget).toBe('product@chatroom')
  })

  it('target 无法解析 ⇒ 一律 needs_review（拿不到证据就不自动改写）', () => {
    const plan = planScheduledReportMigration(
      task({ group: 'tech-md5', target: 'unknown-id' }),
      resolve,
      NOW
    )
    expect(plan.outcome).toBe('needs_review')
    expect(plan.enabled).toBe(false)
    expect(plan.config.legacyTarget).toBe('unknown-id')
  })

  it('needs_review 的规则即使旧任务是启用的也必须停用', () => {
    const plan = planScheduledReportMigration(
      task({ target: 'product@chatroom', enabled: true, group: 'tech-md5' }),
      resolve,
      NOW
    )
    expect(plan.enabled).toBe(false)
  })

  it('来源群解析不到 ⇒ 保留原值，不在迁移期猜一个群', () => {
    const plan = planScheduledReportMigration(task({ group: '未知群', target: '' }), resolve, NOW)
    // 原值留着 —— 运行期会如实失败，比"悄悄换一个群发"安全得多。
    expect(plan.config.report.sourceConversationId).toBe('未知群')
    expect(plan.config.legacySourceGroup).toBeUndefined()
  })
})

describe('定时日报迁移 · 批次幂等', () => {
  const tasks: LegacyScheduledReportTask[] = [
    task({ id: 'scheduled_report_a', name: 'A', group: 'tech-md5', target: 'tech@chatroom' }),
    task({ id: 'scheduled_report_b', name: 'B', group: 'product-md5', target: 'product@chatroom' }),
    task({ id: 'scheduled_report_c', name: 'C', group: 'tech-md5', target: 'product@chatroom' })
  ]

  it('3 条旧任务 ⇒ 3 条规则，并给出判定分布', () => {
    const { plans, summary } = planScheduledReportMigrationBatch(tasks, resolve, NOW)

    expect(plans.map((plan) => plan.ruleId)).toEqual([
      'scheduled_report_a',
      'scheduled_report_b',
      'scheduled_report_c'
    ])
    expect(summary).toEqual({
      total: 3,
      migrated: 3,
      lossless: 2,
      needsReview: 1,
      duplicatesSkipped: 0
    })
  })

  it('重复执行结果完全一致（幂等，不是"看起来没多"）', () => {
    const first = planScheduledReportMigrationBatch(tasks, resolve, NOW)
    const second = planScheduledReportMigrationBatch(tasks, resolve, NOW)
    expect(second).toEqual(first)
  })

  it('同一 id 出现两次只迁一条，并如实计入 duplicatesSkipped', () => {
    const { plans, summary } = planScheduledReportMigrationBatch(
      [tasks[0], task({ id: 'scheduled_report_a', name: '重复' })],
      resolve,
      NOW
    )

    expect(plans).toHaveLength(1)
    expect(plans[0].name).toBe('A')
    expect(summary.total).toBe(2)
    expect(summary.migrated).toBe(1)
    expect(summary.duplicatesSkipped).toBe(1)
  })

  it('文件里混进非对象元素时跳过而不是崩掉', () => {
    const { plans } = planScheduledReportMigrationBatch(
      [tasks[0], null as unknown as LegacyScheduledReportTask, 'x' as unknown as LegacyScheduledReportTask],
      resolve,
      NOW
    )
    expect(plans).toHaveLength(1)
  })

  it('空文件 ⇒ 0 条规则（全新安装路径）', () => {
    const { plans, summary } = planScheduledReportMigrationBatch([], resolve, NOW)
    expect(plans).toHaveLength(0)
    expect(summary.migrated).toBe(0)
  })
})
