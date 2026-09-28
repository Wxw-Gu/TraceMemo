import { mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/tracememo-test-user-data' } }))

import {
  ScheduledReportService,
  calculateNextRunAt,
  resolveDueScheduledSlot,
  validateScheduleTime
} from '../../src/main/services/scheduled-report-service'
import type { ScheduledReportDependencies } from '../../src/main/services/scheduled-report-service'
import type { AgentHubStatus } from '../../src/shared/agent-hub'
import {
  createDefaultScheduledReportRule,
  normalizeScheduledReportConfig,
  type AutomationRule
} from '../../src/shared/automation'
import type { ScheduledRuleRunOutcome } from '../../src/shared/automation'

/**
 * 定时日报服务（退役后）只剩三件事：调度 / 异常通知 / 旧数据只读存档。
 *
 * 这一组测试守的是**任务来源已经换成 AutomationRuleStore**：
 * - 调度器**只读规则**，执行一律委派给注入的 `executeRule`；
 * - 槽位已消费 / 已停用 / 目标待重选 / 数据库未就绪 ⇒ **不执行**；
 * - 定时失败 ⇒ 推异常通知；手动执行 / `NO_MESSAGES` ⇒ **不推**；
 * - 旧 `tasks.json` / `executions.json` **只读**，且新执行日志按 ruleId 投影。
 */

const onlineAgentHubStatus = (): AgentHubStatus => ({
  hub: 'online' as const,
  connector: 'online' as const,
  updatedAt: Date.now()
})

const SCHEDULE_TIME = '18:30'
/** 一个"当天 18:30 之后"的时刻，保证当日槽位已到点。 */
const AFTER_SLOT = new Date('2026-08-27T18:31:00+08:00')
/**
 * 规则的创建时间：**固定**在 2026-08-20。
 *
 * 必须早于所有参与断言的槽位，否则「槽位晚于创建时间」这道闸会把一切挡住；
 * 也绝不能用 `Date.now()` —— 那样断言会随墙上时钟漂移。
 */
const CREATED_AT = Date.parse('2026-08-20T00:00:00+08:00')

function makeRule(overrides: Partial<AutomationRule> = {}): AutomationRule {
  return {
    ...createDefaultScheduledReportRule(CREATED_AT, {
      id: 'rule-1',
      name: '每日晚报',
      config: normalizeScheduledReportConfig({
        schedule: { time: SCHEDULE_TIME },
        report: { sourceConversationId: 'g1@chatroom', messageTypes: ['text'] }
      })
    }),
    ...overrides
  }
}

interface Harness {
  service: ScheduledReportService
  storageDir: string
  rules: AutomationRule[]
  /** **真正注入进 service 的那个** mock（可能来自 `overrides`）。 */
  executeRule: ReturnType<typeof vi.fn>
  sendNotification: ReturnType<typeof vi.fn>
  listExecutions: ReturnType<typeof vi.fn>
}

async function makeHarness(
  overrides: Partial<ScheduledReportDependencies> = {},
  rules: AutomationRule[] = [makeRule()]
): Promise<Harness> {
  const storageDir = await mkdtemp(join(tmpdir(), 'tracememo-scheduled-'))
  const executeRule = vi.fn(
    async (): Promise<ScheduledRuleRunOutcome> => ({
      executed: true,
      executionId: 'exec-1',
      status: 'success',
      reportGenerated: true
    })
  )
  const sendNotification = vi.fn().mockResolvedValue({ success: true, status: 'sent' })
  const listExecutions = vi.fn().mockReturnValue([])
  const deps = {
    storageDir,
    executeRule,
    listRules: () => rules,
    listExecutions,
    sendNotification,
    getNotificationRecipient: () => 'owner-wxid',
    getAgentHubStatus: onlineAgentHubStatus,
    isDatabaseReady: () => true,
    now: () => AFTER_SLOT,
    ...overrides
  } as unknown as ScheduledReportDependencies
  const service = new ScheduledReportService(deps)
  return {
    service,
    storageDir,
    rules,
    // 用 dep 上的**最终**实现回填，避免 `overrides` 覆盖后断言打空。
    executeRule: deps.executeRule as unknown as ReturnType<typeof vi.fn>,
    sendNotification: deps.sendNotification as unknown as ReturnType<typeof vi.fn>,
    listExecutions: deps.listExecutions as unknown as ReturnType<typeof vi.fn>
  }
}

describe('定时日报 · 时间计算', () => {
  it('校验 HH:mm 并计算下一次本地时刻', () => {
    expect(validateScheduleTime('09:05')).toBe(true)
    expect(validateScheduleTime('24:00')).toBe(false)
    expect(validateScheduleTime('9:5')).toBe(false)
    const from = new Date('2026-08-27T10:00:00+08:00')
    expect(calculateNextRunAt('18:30', from)).toBe(
      new Date('2026-08-27T18:30:00+08:00').toISOString()
    )
    // 已经过了今天的点 ⇒ 顺延到明天。
    expect(calculateNextRunAt('09:00', from)).toBe(
      new Date('2026-08-28T09:00:00+08:00').toISOString()
    )
  })

  it('resolveDueScheduledSlot 给出"已经到点、最近的那个"槽位', () => {
    // 18:31 时，18:30 已经到点 ⇒ 槽位是今天 18:30。
    expect(resolveDueScheduledSlot(SCHEDULE_TIME, AFTER_SLOT)).toBe(
      new Date('2026-08-27T18:30:00+08:00').toISOString()
    )
    // 18:29 时，今天的点还没到 ⇒ 最近一个槽位是昨天。
    expect(resolveDueScheduledSlot(SCHEDULE_TIME, new Date('2026-08-27T18:29:00+08:00'))).toBe(
      new Date('2026-08-26T18:30:00+08:00').toISOString()
    )
  })
})

describe('定时日报 · 调度器', () => {
  it('到点且未消费 ⇒ 以 schedule 触发，并把槽位交给 AutomationService', async () => {
    const { service, executeRule } = await makeHarness()

    await service.tick(AFTER_SLOT)
    await service.settle()

    expect(executeRule).toHaveBeenCalledTimes(1)
    const [ruleId, options] = executeRule.mock.calls[0]
    expect(ruleId).toBe('rule-1')
    expect(options).toEqual({
      trigger: 'schedule',
      scheduledSlot: new Date('2026-08-27T18:30:00+08:00').toISOString()
    })
  })

  it('槽位已消费 ⇒ 不再触发（重启后不重复补跑）', async () => {
    const rule = makeRule({
      scheduledReport: {
        ...normalizeScheduledReportConfig({
          schedule: { time: SCHEDULE_TIME },
          report: { sourceConversationId: 'g1@chatroom', messageTypes: ['text'] }
        }),
        lastScheduledSlot: new Date('2026-08-27T18:30:00+08:00').toISOString()
      }
    })
    const { service, executeRule } = await makeHarness({}, [rule])

    await service.tick(AFTER_SLOT)
    await service.settle()

    expect(executeRule).not.toHaveBeenCalled()
  })

  it('停用的规则不调度', async () => {
    const { service, executeRule } = await makeHarness({}, [makeRule({ enabled: false })])
    await service.tick(AFTER_SLOT)
    await service.settle()
    expect(executeRule).not.toHaveBeenCalled()
  })

  it('目标待重选的规则不调度（执行必然失败）', async () => {
    const rule = makeRule({
      scheduledReport: {
        ...normalizeScheduledReportConfig({
          schedule: { time: SCHEDULE_TIME },
          report: { sourceConversationId: 'g1@chatroom', messageTypes: ['text'] }
        }),
        targetNeedsReview: true
      }
    })
    const { service, executeRule } = await makeHarness({}, [rule])
    await service.tick(AFTER_SLOT)
    await service.settle()
    expect(executeRule).not.toHaveBeenCalled()
  })

  it('数据库未就绪时不调度', async () => {
    const { service, executeRule } = await makeHarness({ isDatabaseReady: () => false })
    await service.tick(AFTER_SLOT)
    await service.settle()
    expect(executeRule).not.toHaveBeenCalled()
  })

  it('今天的点还没到 + 昨天已消费 ⇒ 不触发', async () => {
    // 规则在昨天 18:30 跑过（游标 = 昨天 18:30），现在是今天 18:29：
    // 最近的槽位仍然是「昨天 18:30」，但它已经消费过 ⇒ 什么都别做。
    const rule = makeRule({
      scheduledReport: {
        ...normalizeScheduledReportConfig({
          schedule: { time: SCHEDULE_TIME },
          report: { sourceConversationId: 'g1@chatroom', messageTypes: ['text'] }
        }),
        lastScheduledSlot: new Date('2026-08-26T18:30:00+08:00').toISOString()
      }
    })
    const { service, executeRule } = await makeHarness({}, [rule])

    await service.tick(new Date('2026-08-27T18:29:00+08:00'))
    await service.settle()

    expect(executeRule).not.toHaveBeenCalled()
  })

  it('槽位早于规则创建时间 ⇒ 不触发（新建规则不会被立刻补发）', async () => {
    // 今天 12:00 建的规则、执行时间 18:30。今天 18:30 还没到，
    // 最近的槽位是**昨天 18:30** —— 它早于 createdAt，不属于这条规则。
    // 少了这道闸，新建规则会在下一次 15 秒 tick 里立刻发一份昨天的报告。
    const rule = makeRule({ createdAt: Date.parse('2026-08-27T12:00:00+08:00') })
    const { service, executeRule } = await makeHarness({}, [rule])

    await service.tick(new Date('2026-08-27T18:29:00+08:00'))
    await service.settle()

    expect(executeRule).not.toHaveBeenCalled()
  })

  it('停机错过一个槽位 ⇒ 补跑最近那个未消费的槽位（不静默丢一天）', async () => {
    // 规则 08-20 创建、游标停在 08-25 18:30，08-26 那晚应用没开：
    // 08-27 18:29 启动时，最近未消费的槽位是 08-26 18:30，应当补上。
    const rule = makeRule({
      scheduledReport: {
        ...normalizeScheduledReportConfig({
          schedule: { time: SCHEDULE_TIME },
          report: { sourceConversationId: 'g1@chatroom', messageTypes: ['text'] }
        }),
        lastScheduledSlot: new Date('2026-08-25T18:30:00+08:00').toISOString()
      }
    })
    const { service, executeRule } = await makeHarness({}, [rule])

    await service.tick(new Date('2026-08-27T18:29:00+08:00'))
    await service.settle()

    expect(executeRule).toHaveBeenCalledTimes(1)
    expect(executeRule.mock.calls[0][1]).toEqual({
      trigger: 'schedule',
      scheduledSlot: new Date('2026-08-26T18:30:00+08:00').toISOString()
    })
  })

  it('游标比槽位新（用户改过执行时间）⇒ 旧槽位已过期，不再补', async () => {
    const rule = makeRule({
      scheduledReport: {
        ...normalizeScheduledReportConfig({
          schedule: { time: SCHEDULE_TIME },
          report: { sourceConversationId: 'g1@chatroom', messageTypes: ['text'] }
        }),
        lastScheduledSlot: new Date('2026-08-27T18:30:00+08:00').toISOString()
      }
    })
    const { service, executeRule } = await makeHarness({}, [rule])

    // 18:31 时最近槽位正好等于游标 ⇒ 不触发；再把时间回拨到 18:29，
    // 槽位退化成 08-26 18:30，仍然**比游标旧** ⇒ 同样不触发。
    await service.tick(AFTER_SLOT)
    await service.tick(new Date('2026-08-27T18:29:00+08:00'))
    await service.settle()

    expect(executeRule).not.toHaveBeenCalled()
  })

  it('schedule 触发的执行结果不会走 conversation gate（并发由 AutomationService 管）', async () => {
    // 这里只断言"调度器把两次 tick 都原样交给 executeRule"：
    // 真正的 ruleId inFlight 去重在 AutomationService，见 automation-service 的单测。
    const { service, executeRule } = await makeHarness()
    await service.tick(AFTER_SLOT)
    await service.tick(AFTER_SLOT)
    await service.settle()
    expect(executeRule).toHaveBeenCalledTimes(2)
  })
})

describe('定时日报 · 立即执行', () => {
  it('手动执行走 manual，且**不消耗槽位**', async () => {
    const { service, executeRule } = await makeHarness()

    const result = await service.runScheduledReportNow('rule-1')

    expect(result.success).toBe(true)
    expect(executeRule).toHaveBeenCalledWith('rule-1', { trigger: 'manual' })
  })

  it('规则不存在时如实报错，不执行', async () => {
    const { service, executeRule } = await makeHarness()
    const result = await service.runScheduledReportNow('missing')
    expect(result.success).toBe(false)
    expect(result.error).toContain('未找到')
    expect(executeRule).not.toHaveBeenCalled()
  })
})

describe('定时日报 · 微信异常通知', () => {
  it('定时执行失败 ⇒ 推一条异常通知（能力开启时）', async () => {
    const { service, storageDir, executeRule, sendNotification } = await makeHarness({
      executeRule: vi.fn(async () => ({
        executed: true,
        executionId: 'exec-fail',
        status: 'failed',
        reportGenerated: false,
        errorSummary: '日报生成失败'
      })) as unknown as ScheduledReportDependencies['executeRule']
    })
    await writeFile(join(storageDir, 'settings.json'), JSON.stringify({ enabled: true }))

    await service.tick(AFTER_SLOT)
    await service.settle()

    expect(executeRule).toHaveBeenCalledTimes(1)
    expect(sendNotification).toHaveBeenCalledTimes(1)
    const text = sendNotification.mock.calls[0][0].text as string
    expect(text).toContain('每日晚报')
    expect(text).toContain('日报生成失败')

    const notifications = await service.listNotifications()
    expect(notifications).toHaveLength(1)
    expect(notifications[0].status).toBe('sent')
  })

  it('NO_MESSAGES 不是"失败"，不打扰用户', async () => {
    const { service, storageDir, sendNotification } = await makeHarness({
      executeRule: vi.fn(async () => ({
        executed: true,
        executionId: 'exec-empty',
        status: 'failed',
        reportGenerated: false,
        errorCode: 'NO_MESSAGES',
        errorSummary: '暂无可生成的日报'
      })) as unknown as ScheduledReportDependencies['executeRule']
    })
    await writeFile(join(storageDir, 'settings.json'), JSON.stringify({ enabled: true }))

    await service.tick(AFTER_SLOT)
    await service.settle()

    expect(sendNotification).not.toHaveBeenCalled()
    expect(await service.listNotifications()).toHaveLength(0)
  })

  it('通知关闭时不推送，也不排队', async () => {
    const { service, sendNotification } = await makeHarness({
      executeRule: vi.fn(async () => ({
        executed: true,
        executionId: 'exec-fail',
        status: 'failed',
        reportGenerated: false,
        errorSummary: '日报生成失败'
      })) as unknown as ScheduledReportDependencies['executeRule']
    })

    await service.tick(AFTER_SLOT)
    await service.settle()

    expect(sendNotification).not.toHaveBeenCalled()
    expect(await service.listNotifications()).toHaveLength(0)
  })

  it('手动执行失败**不**推异常通知（与旧行为一致）', async () => {
    const { service, storageDir, sendNotification } = await makeHarness({
      executeRule: vi.fn(async () => ({
        executed: true,
        executionId: 'exec-manual',
        status: 'failed',
        reportGenerated: false,
        errorSummary: '日报生成失败'
      })) as unknown as ScheduledReportDependencies['executeRule']
    })
    await writeFile(join(storageDir, 'settings.json'), JSON.stringify({ enabled: true }))

    await service.runScheduledReportNow('rule-1')

    expect(sendNotification).not.toHaveBeenCalled()
  })

  it('开启通知前会先做能力检测并试发一条', async () => {
    const { service, sendNotification } = await makeHarness(
      { getAgentHubStatus: () => ({ hub: 'offline', connector: 'disconnected', updatedAt: 0 }) },
      []
    )
    const result = await service.setNotificationEnabled(true)
    expect(result.success).toBe(false)
    expect(result.reason).toBe('agent_hub_offline')
    expect(sendNotification).not.toHaveBeenCalled()
  })

  it('Agent Hub 在线且已绑定接收者 ⇒ 开启成功并落盘', async () => {
    const { service, storageDir, sendNotification } = await makeHarness({}, [])
    const result = await service.setNotificationEnabled(true)
    expect(result.success).toBe(true)
    expect(sendNotification).toHaveBeenCalledTimes(1)
    expect(await service.getNotificationSettings()).toEqual({ enabled: true })
    // 设置**真的**落盘了（不是只改了内存）。
    const { readFile } = await import('fs/promises')
    const raw = await readFile(join(storageDir, 'settings.json'), 'utf8')
    expect(JSON.parse(raw)).toEqual({ enabled: true })
  })
})

describe('定时日报 · 旧数据只读存档', () => {
  it('旧执行记录原样可读，且按旧 taskId / 新 ruleId 双向匹配', async () => {
    const { service, storageDir } = await makeHarness()
    await writeFile(
      join(storageDir, 'executions.json'),
      JSON.stringify([
        {
          id: 'old-exec-1',
          taskId: 'scheduled_report_old',
          startedAt: '2026-08-01T10:00:00.000Z',
          status: 'success',
          message: '日报生成成功，微信发送成功'
        }
      ])
    )
    // 重新建一个实例，确保从盘上读（而不是复用内存）。
    const fresh = new ScheduledReportService({
      storageDir,
      listRules: () => [],
      isDatabaseReady: () => true
    })

    const all = await fresh.listLegacyExecutions()
    expect(all).toHaveLength(1)
    expect(all[0].id).toBe('old-exec-1')

    const byLegacyId = await fresh.listLegacyExecutions('scheduled_report_old')
    expect(byLegacyId).toHaveLength(1)

    // 迁移后 ruleId 可能形如 `scheduled-report:<旧 id>`（旧 id 缺失时的确定性映射）。
    const byMappedId = await fresh.listLegacyExecutions('scheduled-report:scheduled_report_old')
    expect(byMappedId).toHaveLength(1)

    expect(await fresh.listLegacyExecutions('unrelated')).toHaveLength(0)
    void service
  })

  it('项目只读投影只暴露「发回来源群」的规则（旧 HTTP 契约能如实表达的那一种）', async () => {
    const { service } = await makeHarness({}, [
      makeRule({
        id: 'rule-source',
        // 默认目标是 `file_transfer`，旧 HTTP 契约表达不了 ⇒ 这里显式选「发回来源群」。
        scheduledReport: normalizeScheduledReportConfig({
          schedule: { time: SCHEDULE_TIME },
          report: { sourceConversationId: 'g1@chatroom', messageTypes: ['text'] },
          target: { type: 'source_chat' }
        })
      }),
      makeRule({
        id: 'rule-file',
        scheduledReport: normalizeScheduledReportConfig({
          schedule: { time: SCHEDULE_TIME },
          report: { sourceConversationId: 'g2@chatroom', messageTypes: ['text'] },
          target: { type: 'file_transfer' }
        })
      })
    ])

    const tasks = await service.listTasks()
    expect(tasks.map((task) => task.id)).toEqual(['rule-source'])
  })

  it('新执行日志按 ruleId 投影成旧执行形状（只读）', async () => {
    const { service } = await makeHarness({
      listExecutions: (() => [
        {
          executionId: 'exec-1',
          ruleId: 'rule-1',
          ruleName: '每日晚报',
          triggerTime: Date.parse('2026-08-27T10:00:00.000Z'),
          trigger: 'schedule',
          sourceDisplayName: '每日晚报来源群',
          status: 'failed' as const,
          durationMs: 1200,
          steps: [
            { key: 'report_generating' as const, label: '生成日报', status: 'failed' as const },
            { key: 'report_sent' as const, label: '发送日报', status: 'pending' as const }
          ],
          errorSummary: '日报生成失败'
        }
      ]) as unknown as ScheduledReportDependencies['listExecutions']
    })

    const executions = await service.listExecutions('rule-1')
    expect(executions).toHaveLength(1)
    expect(executions[0].taskId).toBe('rule-1')
    expect(executions[0].triggerType).toBe('scheduled')
    expect(executions[0].status).toBe('failed')
    expect(executions[0].error).toBe('日报生成失败')
  })
})

describe('定时日报 · 启动与停止', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('start 会立刻跑一次 tick，stop 后不再有计时器', async () => {
    const { service, executeRule } = await makeHarness()
    await service.start()
    await service.settle()
    service.stop()

    expect(executeRule).toHaveBeenCalledTimes(1)
  })
})
