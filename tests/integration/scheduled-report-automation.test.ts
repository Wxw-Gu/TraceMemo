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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wxe-scheduled-report-automation-'))
})

const SELF = 'my_account_9527'

/** 联系人表必须在 `vi.hoisted` 里 —— `vi.mock` 的工厂是提前求值的。 */
const contacts = vi.hoisted(() => [
  {
    md5: 'tech-md5',
    m_nsUsrName: 'tech@chatroom',
    m_nsNickName: '技术交流群',
    type: 'group' as const
  },
  {
    m_nsUsrName: 'wxid_friend',
    m_nsNickName: '好友昵称',
    remark: '好友备注',
    type: 'user' as const
  }
])

vi.mock('electron', () => ({
  app: { getPath: () => root },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8')
  },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('../../src/main/services/chat-service', () => ({
  listContacts: () => contacts,
  getSelfAccountInfo: () => ({ wxid: 'my_account_9527' }),
  // 头像补全是可选增强：这里显式给一个空实现，避免 runner 落到未 mock 的导出上刷警告。
  getContactAvatars: async () => ({})
}))

import type {
  PersonalWechatSendCapability,
  PersonalWechatSendRequest
} from '../../src/shared/personal-wechat'
import type { Wcdb4Client } from '../../src/main/wcdb4-client'
import type { GeneratedReportRecord } from '../../src/shared/report-history'
import type { AgentGroupReportResult } from '../../src/main/services/agent-group-report-service'
import type {
  AutomationRule,
  AutomationRuleDraft,
  ScheduledReportTargetType
} from '../../src/shared/automation'
import { WechatActionGateway } from '../../src/main/services/wechat-action-gateway'
import { AutomationRuleStore } from '../../src/main/services/automation-rule-store'
import { AutomationExecutionLogService } from '../../src/main/services/automation-execution-log-service'
import { AutomationActionRunner } from '../../src/main/services/automation-action-runner'
import { AutomationService } from '../../src/main/services/automation-service'
import { ScheduledReportService } from '../../src/main/services/scheduled-report-service'

/**
 * 定时日报的**端到端链路**。
 *
 * Scheduler（`ScheduledReportService.tick`）→ `AutomationService.executeScheduledRule`
 * → `AutomationActionRunner.runScheduledReport` → `WechatActionGateway` → 被替换掉的传输层。
 *
 * 除了「微信怎么把图片发出去」，其余**全部是生产实现**。这个文件的存在理由：
 * - `AUTOMATION_PURPOSE_ALLOWLIST` 一旦漏登记 `automation_scheduled_report`，
 *   整条链会在策略层被**静默**拦下（ACTION_NOT_ALLOWED），而每个单元测试都还是绿的；
 * - `scheduledInFlight` / 确定性 executionId 这两道并发闸，只有真的拼起来才看得出来；
 * - 四个发送目标、槽位游标、执行日志的 trigger 区分，都是"拼起来"才成立的语义。
 */

function readyCapability(): PersonalWechatSendCapability {
  return {
    supported: true,
    ready: true,
    status: 'ready',
    capabilities: { text: true, image: true, voice: false },
    message: '个人微信已准备好发送日报',
    senderStatus: {
      state: 'online',
      platform: 'darwin',
      arch: 'arm64',
      sipDisabled: false,
      wechatRunning: true,
      endpoint: '127.0.0.1:0',
      endpointReady: true,
      runtimeReady: true,
      attachReady: true,
      baseAddressReady: true,
      textHookInstalled: true,
      textHookReady: true,
      imageHookInstalled: true,
      imageHookReady: true,
      messageListenerReady: true,
      canSend: true,
      canSendText: true,
      canSendImage: true,
      canSendVoice: false,
      message: '个人微信已准备好发送日报'
    }
  }
}

const RULE_NAME = '技术交流群 · 每日晚报'
const SCHEDULE_TIME = '18:30'
/** 规则的创建时间固定在 2026-08-20，必须早于所有参与断言的槽位。 */
const CREATED_AT = Date.parse('2026-08-20T09:00:00+08:00')
/** 2026-08-27 18:31，当天 18:30 的槽位已经到点。 */
const AFTER_SLOT = new Date('2026-08-27T18:31:00+08:00')
/**
 * `AutomationService` / `AutomationRuleStore` 的 `now` 是**毫秒数**，
 * `ScheduledReportService` 的 `now` 是 **`Date`** —— 两者刻意分开命名，
 * 避免把毫秒数丢给需要 `Date` 的那一个（那会在推通知时抛 `toISOString` 错误）。
 */
const AFTER_SLOT_MS = AFTER_SLOT.getTime()
const SLOT_ISO = new Date('2026-08-27T18:30:00+08:00').toISOString()

function scheduledDraft(
  target: ScheduledReportTargetType,
  options: { contactId?: string; enabled?: boolean; postfixText?: string } = {}
): AutomationRuleDraft {
  return {
    name: RULE_NAME,
    enabled: options.enabled !== false,
    ruleType: 'scheduled_report',
    trigger: 'message',
    scope: 'group',
    conditions: {
      requireMentionMe: false,
      keyword: '',
      keywordMatchMode: 'contains',
      conversationIds: [],
      ignoreSelf: true
    },
    actions: [],
    cooldownSeconds: 0,
    replyDelaySeconds: 2,
    scheduledReport: {
      schedule: { time: SCHEDULE_TIME },
      report: {
        sourceConversationId: 'tech@chatroom',
        range: 'yesterday',
        messageTypes: ['text'],
        templateId: 'v1',
        memberNameMode: 'groupNickname',
        timeoutSeconds: 300
      },
      target:
        target === 'contact'
          ? { type: 'contact', contactId: options.contactId ?? 'wxid_friend' }
          : { type: target },
      // 只有显式给了后置词才写进规则：空字符串意味着"只发图片"，
      // 这正是存量规则迁移过来的形态，不能在测试工厂里被悄悄补上默认值。
      ...(options.postfixText ? { postfixText: options.postfixText } : {})
    }
  }
}

interface Chain {
  scheduler: ScheduledReportService
  service: AutomationService
  store: AutomationRuleStore
  log: AutomationExecutionLogService
  sends: PersonalWechatSendRequest[]
  ruleId: string
}

function buildChain(
  options: {
    capability?: PersonalWechatSendCapability
    target?: ScheduledReportTargetType
    contactId?: string
    enabled?: boolean
    postfixText?: string
    generate?: () => Promise<AgentGroupReportResult>
  } = {}
): Chain {
  const sends: PersonalWechatSendRequest[] = []
  const savedReports: GeneratedReportRecord[] = []
  const capability = options.capability ?? readyCapability()

  const gateway = new WechatActionGateway({
    getUserDataPath: () => root,
    getCapability: async () => capability,
    // 传输层是唯一被替换的部分：策略、幂等、审计、节流都是真的。
    send: async (request) => {
      sends.push(request)
      return { success: true, status: readyCapability().senderStatus }
    },
    wait: async () => undefined
  })

  // `now` 固定：否则 `createdAt` 会变成墙上时钟，把「槽位必须晚于创建时间」那道闸踩掉。
  const store = new AutomationRuleStore({ userDataPath: () => root, now: () => CREATED_AT })
  const log = new AutomationExecutionLogService({ userDataPath: () => root })
  const runner = new AutomationActionRunner({
    executeAction: (request) => gateway.execute(request),
    generateReport:
      options.generate ??
      (async () => ({
        success: true,
        groupName: '技术交流群',
        pngPath: path.join(root, 'scheduled-report.png'),
        messageCount: 42
      })),
    saveGeneratedReport: async (request) => {
      const record: GeneratedReportRecord = {
        id: 'report-1',
        contactId: request.contactId,
        contactName: request.contactName,
        source: 'scheduled',
        dateRange: request.dateRange,
        messageCount: request.messageCount,
        generatedAt: request.generatedAt,
        reportDate: '2026-08-26',
        pngPath: path.join(root, 'scheduled-report.png'),
        htmlStatus: 'ready',
        pngStatus: 'ready'
      }
      savedReports.push(record)
      return { success: true, record }
    },
    resolveReportContact: () => ({
      md5: 'tech-md5',
      m_nsUsrName: 'tech@chatroom',
      m_nsNickName: '技术交流群'
    })
  })

  const client = {
    getMyUsernameCandidates: () => [SELF],
    getSessions: () => [{ username: 'tech@chatroom', nickname: '技术交流群' }]
  } as unknown as Wcdb4Client

  const service = new AutomationService(client, {
    ruleStore: store,
    executionLog: log,
    runner,
    getCapability: async () => capability,
    now: () => AFTER_SLOT_MS
  })

  const ruleId = store.createRule(
    scheduledDraft(options.target ?? 'source_chat', {
      ...(options.contactId ? { contactId: options.contactId } : {}),
      ...(options.enabled === false ? { enabled: false } : {}),
      ...(options.postfixText ? { postfixText: options.postfixText } : {})
    })
  ).id

  const scheduler = new ScheduledReportService({
    storageDir: path.join(root, 'scheduled-reports-legacy'),
    executeRule: (id, runOptions) => service.executeScheduledRule(id, runOptions),
    listRules: () => store.listRules(),
    listExecutions: (input) => log.list(input),
    isDatabaseReady: () => true,
    now: () => AFTER_SLOT
  })

  return { scheduler, service, store, log, sends, ruleId }
}

/** 每个用例都换一个干净的 userData 目录，避免审计 / 幂等记录互相污染。 */
const workdirs: string[] = []
function isolatedRoot(): void {
  const dir = fs.mkdtempSync(path.join(root, 'case-'))
  workdirs.push(dir)
}

describe('scheduled report end-to-end chain', () => {
  beforeEach(() => {
    fs.removeSync(path.join(root, 'automation'))
    fs.removeSync(path.join(root, 'actions'))
    fs.removeSync(path.join(root, 'scheduled-reports-legacy'))
    isolatedRoot()
  })

  afterAll(() => {
    for (const dir of workdirs) fs.removeSync(dir)
    fs.removeSync(root)
  })

  it('到点 ⇒ 生成日报 → 落日报历史 → 穿过 Gateway 发出，并记录 schedule 触发', async () => {
    const chain = buildChain()

    await chain.scheduler.tick(AFTER_SLOT)
    await chain.scheduler.settle()

    // 真的发出去了：说明 purpose 通过了 `AUTOMATION_PURPOSE_ALLOWLIST`。
    expect(chain.sends).toHaveLength(1)
    expect(chain.sends[0]).toMatchObject({
      type: 'image',
      to: 'tech@chatroom',
      isGroup: true,
      filePath: path.join(root, 'scheduled-report.png')
    })

    const record = chain.log.list()[0]
    expect(record.trigger).toBe('schedule')
    expect(record.status).toBe('success')
    expect(record.steps.map((step) => `${step.key}:${step.status}`)).toEqual([
      'schedule_triggered:success',
      'report_generating:success',
      'report_generated:success',
      'send_resolved:success',
      'report_sent:success'
    ])
    // `send_resolved` 的 detail 是**用户可读的目标名**，不是 roomId。
    expect(record.steps.find((step) => step.key === 'send_resolved')?.detail).toBe('技术交流群')
  })

  it('配置了后置词 ⇒ 图片 sent 之后补发一条文本，两条各自独立', async () => {
    const chain = buildChain({ postfixText: '今日日报' })

    await chain.scheduler.tick(AFTER_SLOT)
    await chain.scheduler.settle()

    /*
     * 两条：先图后文。
     *
     * 后置词走的是**另一个 purpose**（`automation_scheduled_report_postfix`）——
     * 只要它在 `AUTOMATION_PURPOSE_ALLOWLIST` 里漏登记，第二次发送就会被策略层
     * 以 ACTION_NOT_ALLOWED 静默拦下，这里会只剩 1 条。这正是本用例存在的理由。
     */
    expect(chain.sends.map((send) => send.type)).toEqual(['image', 'text'])
    expect(chain.sends[0]).toMatchObject({
      type: 'image',
      to: 'tech@chatroom',
      isGroup: true,
      filePath: path.join(root, 'scheduled-report.png')
    })
    expect(chain.sends[1]).toMatchObject({
      type: 'text',
      to: 'tech@chatroom',
      isGroup: true,
      text: '今日日报'
    })
    // 两条都成功，整次执行才是 success（后置词失败会拖垮整次判定，见下一条）。
    expect(chain.log.list()[0].status).toBe('success')
  })

  it('未配置后置词 ⇒ 只发图片，绝不"顺手补一句"', async () => {
    const chain = buildChain()

    await chain.scheduler.tick(AFTER_SLOT)
    await chain.scheduler.settle()

    expect(chain.sends.map((send) => send.type)).toEqual(['image'])
    expect(chain.log.list()[0].status).toBe('success')
  })

  it('图片能力缺失 ⇒ 后置词绝不发送（图片没发出去，就没有"之后"）', async () => {
    const capability = readyCapability()
    const chain = buildChain({
      postfixText: '今日日报',
      capability: { ...capability, capabilities: { ...capability.capabilities, image: false } }
    })

    await chain.scheduler.tick(AFTER_SLOT)
    await chain.scheduler.settle()

    // 图片都没发出去，后置词更不可能发 —— 传输层零调用。
    expect(chain.sends).toHaveLength(0)
    expect(chain.log.list()[0].status).toBe('failed')
  })

  it('图片已发出但后置词失败 ⇒ 如实判失败，不吞掉也不回滚', async () => {
    const capability = readyCapability()
    // 文字能力缺失：图片照发，但后置词那一步会被 SEND_NOT_READY 拦下。
    const chain = buildChain({
      postfixText: '今日日报',
      capability: { ...capability, capabilities: { ...capability.capabilities, text: false } }
    })

    await chain.scheduler.tick(AFTER_SLOT)
    await chain.scheduler.settle()

    // 图片确实发出去了 —— 微信发送不支持回滚，所以**必须留痕**，不能假装没发生。
    expect(chain.sends.map((send) => send.type)).toEqual(['image'])
    const record = chain.log.list()[0]
    expect(record.status).toBe('failed')
    // 失败点必须精确落在"后置词"，而不是伪装成"日报没生成/没发送"。
    expect(record.steps.find((step) => step.key === 'report_sent')?.error).toContain(
      '后置词发送失败'
    )
  })

  it('同一槽位重放 ⇒ 图片与后置词各自幂等，都不会重复发', async () => {
    const chain = buildChain({ postfixText: '今日日报' })

    await chain.service.executeScheduledRule(chain.ruleId, {
      trigger: 'schedule',
      scheduledSlot: SLOT_ISO
    })
    await chain.service.executeScheduledRule(chain.ruleId, {
      trigger: 'schedule',
      scheduledSlot: SLOT_ISO
    })

    // 两次重放合起来仍然只有一条图 + 一条文：两条各有独立幂等位，
    // 少给后置词一个 key 会让它在第二次重放时"被图片的幂等位短路掉"。
    expect(chain.sends.map((send) => send.type)).toEqual(['image', 'text'])
  })

  it('四个发送目标各自解析正确（同一个 Gateway，不绑作用域锁）', async () => {
    const cases: Array<{ target: ScheduledReportTargetType; to: string; isGroup: boolean }> = [
      { target: 'source_chat', to: 'tech@chatroom', isGroup: true },
      { target: 'file_transfer', to: 'filehelper', isGroup: false },
      { target: 'self', to: SELF, isGroup: false },
      { target: 'contact', to: 'wxid_friend', isGroup: false }
    ]

    for (const item of cases) {
      const chain = buildChain({ target: item.target })

      await chain.scheduler.tick(AFTER_SLOT)
      await chain.scheduler.settle()

      expect(
        chain.sends.map((send) => ({ type: send.type, to: send.to, isGroup: send.isGroup }))
      ).toEqual([{ type: 'image', to: item.to, isGroup: item.isGroup }])
      expect(chain.log.list()[0].status).toBe('success')
    }
  })

  it('目标失效 ⇒ 生成成功但**绝不** fallback 到别处，且如实判失败', async () => {
    const chain = buildChain({ target: 'contact', contactId: 'wxid_gone' })

    await chain.scheduler.tick(AFTER_SLOT)
    await chain.scheduler.settle()

    expect(chain.sends).toHaveLength(0)
    const record = chain.log.list()[0]
    expect(record.status).toBe('failed')
    // 失败点在"发到哪"，不能伪装成"生成失败"。
    expect(record.steps.find((step) => step.key === 'report_generating')?.status).toBe('success')
    expect(record.steps.find((step) => step.key === 'send_resolved')?.status).toBe('failed')
    expect(record.steps.find((step) => step.key === 'report_sent')?.status).toBe('skipped')
  })

  it('停用的规则完全不执行（连日报都不生成）', async () => {
    const chain = buildChain({ enabled: false })

    await chain.scheduler.tick(AFTER_SLOT)
    await chain.scheduler.settle()

    expect(chain.sends).toHaveLength(0)
    expect(chain.log.list()).toHaveLength(0)
  })

  it('图片能力缺失 ⇒ 日报照生成，但不发送，并说明原因', async () => {
    const capability = readyCapability()
    const chain = buildChain({
      capability: { ...capability, capabilities: { ...capability.capabilities, image: false } }
    })

    await chain.scheduler.tick(AFTER_SLOT)
    await chain.scheduler.settle()

    expect(chain.sends).toHaveLength(0)
    const record = chain.log.list()[0]
    expect(record.status).toBe('failed')
    expect(record.steps.find((step) => step.key === 'report_generating')?.status).toBe('success')
    expect(record.steps.find((step) => step.key === 'report_sent')?.error).toContain('无法发送图片')
  })

  it('手动执行与定时执行**共用同一条链路**，只有 trigger 不同', async () => {
    const chain = buildChain()

    const outcome = await chain.service.executeScheduledRule(chain.ruleId, { trigger: 'manual' })

    expect(outcome.executed).toBe(true)
    expect(chain.sends).toHaveLength(1)
    expect(chain.log.list()[0].trigger).toBe('manual')
  })

  it('同一条规则并发触发 ⇒ 第二个被 inFlight 挡掉，只发一次', async () => {
    const chain = buildChain()

    const [first, second] = await Promise.all([
      chain.service.executeScheduledRule(chain.ruleId, {
        trigger: 'schedule',
        scheduledSlot: SLOT_ISO
      }),
      chain.service.executeScheduledRule(chain.ruleId, {
        trigger: 'schedule',
        scheduledSlot: SLOT_ISO
      })
    ])

    const executed = [first, second].filter((item) => item.executed)
    const blocked = [first, second].filter((item) => !item.executed)
    expect(executed).toHaveLength(1)
    expect(blocked).toHaveLength(1)
    expect(blocked[0].reason).toBe('in_flight')
    expect(chain.sends).toHaveLength(1)
  })

  it('同一槽位被重复触发 ⇒ 确定性 executionId 让 Gateway 去重，不会重复发', async () => {
    const chain = buildChain()

    const first = await chain.service.executeScheduledRule(chain.ruleId, {
      trigger: 'schedule',
      scheduledSlot: SLOT_ISO
    })
    const second = await chain.service.executeScheduledRule(chain.ruleId, {
      trigger: 'schedule',
      scheduledSlot: SLOT_ISO
    })

    // executionId 由 ruleId + slot 确定性派生，所以两次完全一致。
    expect(first.executionId).toBeTruthy()
    expect(second.executionId).toBe(first.executionId)
    // 传输层只被调用一次 —— 幂等拦在 Gateway，不是靠上层自觉。
    expect(chain.sends).toHaveLength(1)
  })

  it('槽位游标：定时触发消费槽位，手动执行不消费', async () => {
    const chain = buildChain()

    await chain.service.executeScheduledRule(chain.ruleId, { trigger: 'manual' })
    const afterManual = chain.store.getRule(chain.ruleId)?.scheduledReport
    expect(afterManual?.lastRunAt).toBeTruthy()
    // 手动执行若写了槽位，就会把今天安排好的那次定时执行一起吞掉。
    expect(afterManual?.lastScheduledSlot).toBeUndefined()

    await chain.service.executeScheduledRule(chain.ruleId, {
      trigger: 'schedule',
      scheduledSlot: SLOT_ISO
    })
    expect(chain.store.getRule(chain.ruleId)?.scheduledReport?.lastScheduledSlot).toBe(SLOT_ISO)
  })

  it('调度器只读规则：槽位已消费后重启不再补跑', async () => {
    const chain = buildChain()

    await chain.scheduler.tick(AFTER_SLOT)
    await chain.scheduler.settle()
    expect(chain.sends).toHaveLength(1)

    // 新建一个调度器实例（= 应用重启）：规则与游标都从盘上读。
    const restarted = new ScheduledReportService({
      storageDir: path.join(root, 'scheduled-reports-legacy'),
      executeRule: (id, runOptions) => chain.service.executeScheduledRule(id, runOptions),
      listRules: () => chain.store.listRules(),
      listExecutions: (input) => chain.log.list(input),
      isDatabaseReady: () => true,
      now: () => AFTER_SLOT
    })
    await restarted.tick(AFTER_SLOT)
    await restarted.settle()

    expect(chain.sends).toHaveLength(1)
  })

  it('执行日志与步骤 detail 不泄露 roomId / wxid / 文件路径', async () => {
    const chain = buildChain({ target: 'contact' })

    await chain.scheduler.tick(AFTER_SLOT)
    await chain.scheduler.settle()

    const record = chain.log.list()[0]
    const serialized = JSON.stringify(record)
    expect(serialized).not.toContain('@chatroom')
    expect(serialized).not.toContain('wxid_friend')
    expect(serialized).not.toContain(root)
    // 但必须留下可读的目标名（备注优先）。
    expect(record.steps.find((step) => step.key === 'send_resolved')?.detail).toBe('好友备注')
  })

  it('定时失败 ⇒ 推一条微信异常通知，且"今天执行"统计与那条日志是同一份', async () => {
    const store = new AutomationRuleStore({ userDataPath: () => root, now: () => CREATED_AT })
    const log = new AutomationExecutionLogService({ userDataPath: () => root })
    const runner = new AutomationActionRunner({
      // 生成直接失败 ⇒ 定时执行判 failed。
      generateReport: async () => ({
        success: false,
        error: '模型调用超时',
        errorCode: 'AI_TIMEOUT'
      })
    })
    const service = new AutomationService(
      {
        getMyUsernameCandidates: () => [SELF],
        getSessions: () => [{ username: 'tech@chatroom', nickname: '技术交流群' }]
      } as unknown as Wcdb4Client,
      {
        ruleStore: store,
        executionLog: log,
        runner,
        getCapability: async () => readyCapability(),
        now: () => AFTER_SLOT_MS
      }
    )
    const ruleId = store.createRule(scheduledDraft('source_chat')).id

    const notifications: string[] = []
    const scheduler = new ScheduledReportService({
      storageDir: path.join(root, 'scheduled-reports-legacy'),
      executeRule: (id, runOptions) => service.executeScheduledRule(id, runOptions),
      listRules: () => store.listRules(),
      listExecutions: (input) => log.list(input),
      sendNotification: async (request) => {
        notifications.push(request.text)
        return { success: true, status: 'sent' }
      },
      getNotificationRecipient: () => SELF,
      getAgentHubStatus: () => ({ hub: 'online', connector: 'online', updatedAt: 0 }),
      isDatabaseReady: () => true,
      now: () => AFTER_SLOT
    })

    // 开启异常通知会先试发一条，把它排掉，后面只看执行失败那一条。
    await scheduler.setNotificationEnabled(true)
    expect(notifications).toHaveLength(1)
    notifications.length = 0

    await scheduler.tick(AFTER_SLOT)
    await scheduler.settle()

    expect(log.list()[0].status).toBe('failed')
    expect(log.list()[0].ruleId).toBe(ruleId)
    expect(notifications).toHaveLength(1)
    expect(notifications[0]).toContain(RULE_NAME)
    expect(notifications[0]).toContain('模型调用超时')
  })

  it('规则不存在 / 目标待重选 ⇒ 明确拒绝，不执行也不发送', async () => {
    const chain = buildChain()

    const missing = await chain.service.executeScheduledRule('rule_does_not_exist', {
      trigger: 'manual'
    })
    expect(missing.executed).toBe(false)
    expect(missing.reason).toBe('rule_not_found')

    // 把规则改成「目标待重选」：迁移遗留态，执行必然失败 ⇒ 直接拒绝。
    const current = chain.store.getRule(chain.ruleId) as AutomationRule
    chain.store.updateRule(chain.ruleId, {
      ...(current as unknown as AutomationRuleDraft),
      scheduledReport: { ...current.scheduledReport!, targetNeedsReview: true }
    })
    const needsReview = await chain.service.executeScheduledRule(chain.ruleId, {
      trigger: 'manual'
    })
    expect(needsReview.executed).toBe(false)
    expect(needsReview.reason).toBe('target_needs_review')
    expect(chain.sends).toHaveLength(0)
  })
})
