// `vi.mock` 的工厂会被提升到 import 之前执行，所以根目录必须用 `vi.hoisted` 先备好，
// 否则工厂里引用的 `root` 还在 TDZ 里。
const root = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path')
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wxe-automation-service-'))
})

vi.mock('electron', () => ({
  app: { getPath: () => root },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8')
  },
  BrowserWindow: { getAllWindows: () => [] }
}))

import fs from 'fs-extra'
import path from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PersonalWechatSendCapability } from '../../src/shared/personal-wechat'
import type { Wcdb4Client } from '../../src/main/wcdb4-client'
import { AutomationService } from '../../src/main/services/automation-service'
import { AutomationRuleStore } from '../../src/main/services/automation-rule-store'
import { AutomationExecutionLogService } from '../../src/main/services/automation-execution-log-service'
import { AutomationActionRunner } from '../../src/main/services/automation-action-runner'
import type { NormalizedIncomingMessage } from '../../src/main/services/message-listener-service'
import type { AutomationRunInput, AutomationRunResult } from '../../src/main/services/automation-action-runner'

/**
 * AutomationService 的编排语义：四道闸 + 执行日志落盘 + 发送能力预检。
 */

const SELF = 'my_account_9527'
const GROUP_ID = '12345678@chatroom'
const OTHER_GROUP = '87654321@chatroom'

/** 完整可用的发送能力替身（不用强转，避免类型加字段后静默失真）。 */
function capability(overrides: Partial<PersonalWechatSendCapability> = {}): PersonalWechatSendCapability {
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
    },
    ...overrides
  }
}

function message(overrides: Partial<NormalizedIncomingMessage> = {}): NormalizedIncomingMessage {
  return {
    sessionId: GROUP_ID,
    localId: '100',
    createTime: 1_789_900_000,
    messageType: 1,
    isSelf: false,
    senderId: 'wxid_sender',
    senderNickname: '张三',
    content: '今日日报',
    isGroup: true,
    mentionTargets: [SELF],
    ...overrides
  }
}

interface Harness {
  service: AutomationService
  store: AutomationRuleStore
  log: AutomationExecutionLogService
  runs: AutomationRunInput[]
  setCapability: (value: PersonalWechatSendCapability) => void
  setRunResult: (value: AutomationRunResult) => void
}

function buildHarness(
  options: {
    now?: () => number
    capability?: PersonalWechatSendCapability
    /** 执行期间的挂起点：resolve 之前 `runner.run` 不会返回（用来模拟长任务）。 */
    holdExecution?: () => Promise<void>
    /** 每次真正进入 runner 时通知测试，便于确定时序。 */
    onRunStart?: () => void
    /** gate 表容量上限，用来在单测里触发清理路径。 */
    gateMaxEntries?: number
  } = {}
): Harness {
  const store = new AutomationRuleStore()
  const log = new AutomationExecutionLogService()
  const runs: AutomationRunInput[] = []
  let currentCapability = options.capability ?? capability()
  let runResult: AutomationRunResult = {
    steps: [
      { key: 'received', label: '收到消息', status: 'success' },
      { key: 'matched', label: '规则匹配', status: 'success' },
      { key: 'reply', label: '回复确认', status: 'success' },
      { key: 'report', label: '生成日报', status: 'success' },
      { key: 'send', label: '发送日报图片', status: 'success' }
    ],
    status: 'success'
  }

  // 只观察 Runner 被怎么调用，不在这里验证它的内部步骤（那是 runner 测试的职责）。
  const spyRunner = {
    run: async (input: AutomationRunInput): Promise<AutomationRunResult> => {
      runs.push(input)
      options.onRunStart?.()
      await options.holdExecution?.()
      return runResult
    }
  } as unknown as AutomationActionRunner

  const client = {
    getMyUsernameCandidates: () => [SELF],
    getSessions: () => [{ username: GROUP_ID, nickname: '测试群' }]
  } as unknown as Wcdb4Client

  const service = new AutomationService(client, {
    ruleStore: store,
    executionLog: log,
    runner: spyRunner,
    getCapability: async () => currentCapability,
    isListening: () => true,
    ...(options.now ? { now: options.now } : {}),
    ...(options.gateMaxEntries !== undefined ? { gateMaxEntries: options.gateMaxEntries } : {})
  })

  return {
    service,
    store,
    log,
    runs,
    setCapability: (value) => {
      currentCapability = value
    },
    setRunResult: (value) => {
      runResult = value
    }
  }
}

describe('AutomationService', () => {
  beforeEach(() => {
    fs.removeSync(path.join(root, 'automation'))
  })

  afterAll(() => fs.removeSync(root))

  it('真 @ + 关键词命中时执行一次，并留下完整的执行记录', async () => {
    const harness = buildHarness()
    await harness.service.handleMessage(message())

    expect(harness.runs).toHaveLength(1)
    expect(harness.runs[0]).toMatchObject({
      conversationId: GROUP_ID,
      isGroup: true,
      sourceDisplayName: '测试群'
    })

    const records = harness.log.list()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      ruleName: '@我生成日报',
      sourceDisplayName: '测试群',
      status: 'success'
    })
    expect(records[0].steps.map((step) => step.key)).toEqual([
      'received',
      'matched',
      'reply',
      'report',
      'send'
    ])
    expect(records[0].executionId).toBe(harness.runs[0].executionId)
  })

  it('同一条消息被重复投递时只执行一次，且**不产生任何额外记录**', async () => {
    const harness = buildHarness()
    // 关掉 cooldown，单独验证「同消息幂等」这条闸 —— 否则第二次会先被 gate 拦下。
    const seeded = harness.store.listRules()[0]
    harness.store.updateRule(seeded.id, { ...seeded, cooldownSeconds: 0 })

    await harness.service.handleMessage(message())
    await harness.service.handleMessage(message())

    expect(harness.runs).toHaveLength(1)
    // 重复投递是「这条消息已经处理过」，不是「跳过了一次执行」——用户日志里不该出现。
    expect(harness.log.list()).toHaveLength(1)
  })

  it('同一条消息在不同群里各算一次（localId 单独跨群不唯一）', async () => {
    const harness = buildHarness()
    await harness.service.handleMessage(message())
    await harness.service.handleMessage(message({ sessionId: OTHER_GROUP }))

    expect(harness.runs).toHaveLength(2)
  })

  it('cooldown 内不重复触发，且对用户完全静默', async () => {
    let now = 1_700_000_000_000
    const harness = buildHarness({ now: () => now })

    await harness.service.handleMessage(message({ localId: '1' }))
    now += 30_000
    await harness.service.handleMessage(message({ localId: '2' }))

    // 只执行一次 —— 这条是硬要求。
    expect(harness.runs).toHaveLength(1)
    // 但第二次**不留任何痕迹**：没有 execution、没有「已跳过」、没有「冷却中」。
    expect(harness.log.list()).toHaveLength(1)
    // 只进诊断计数（不上 UI）。
    expect(harness.service.getBlockedMessageCount()).toBe(1)
  })

  it('cooldown 过后可以再次触发', async () => {
    let now = 1_700_000_000_000
    const harness = buildHarness({ now: () => now })

    await harness.service.handleMessage(message({ localId: '1' }))
    now += 61_000
    await harness.service.handleMessage(message({ localId: '2' }))

    expect(harness.runs).toHaveLength(2)
  })

  it('自己发送的消息不触发（否则「收到，正在生成今日日报」会形成死循环）', async () => {
    const harness = buildHarness()
    await harness.service.handleMessage(message({ isSelf: true, content: '收到，正在生成今日日报' }))

    expect(harness.runs).toHaveLength(0)
    expect(harness.log.list()).toHaveLength(0)
  })

  it('正文里手打 @昵称 但没有真 @ 元数据时不触发', async () => {
    const harness = buildHarness()
    await harness.service.handleMessage(message({ content: '@我 今日日报', mentionTargets: [] }))
    expect(harness.runs).toHaveLength(0)
  })

  it('停用的规则不触发', async () => {
    const harness = buildHarness()
    const rule = harness.store.listRules()[0]
    harness.store.setRuleEnabled(rule.id, false)
    await harness.service.handleMessage(message())
    expect(harness.runs).toHaveLength(0)
  })

  it('不在生效范围内的群不触发', async () => {
    const harness = buildHarness()
    const rule = harness.store.listRules()[0]
    harness.store.updateRule(rule.id, { ...rule, conditions: { ...rule.conditions, conversationIds: [OTHER_GROUP] } })
    await harness.service.handleMessage(message())
    expect(harness.runs).toHaveLength(0)
  })

  it('发送能力不足时不执行，并记下说明清楚的失败记录', async () => {
    const harness = buildHarness({
      capability: capability({
        ready: false,
        capabilities: { text: false, image: false, voice: false },
        message: '请先绑定个人微信'
      })
    })
    await harness.service.handleMessage(message())

    expect(harness.runs).toHaveLength(0)
    const records = harness.log.list()
    expect(records).toHaveLength(1)
    expect(records[0].status).toBe('failed')
    expect(records[0].errorSummary).toContain('当前环境无法发送文字')
  })

  it('只能发文字、不能发图片时不执行（不能假装日报发得出去）', async () => {
    const harness = buildHarness({
      capability: capability({ capabilities: { text: true, image: false, voice: false } })
    })
    await harness.service.handleMessage(message())

    expect(harness.runs).toHaveLength(0)
    expect(harness.log.list()[0].errorSummary).toContain('当前环境无法发送图片')
  })

  it('拿不到会话昵称时也不把 wxid 写进执行记录', async () => {
    const store = new AutomationRuleStore()
    const log = new AutomationExecutionLogService()
    const client = {
      getMyUsernameCandidates: () => [SELF],
      getSessions: () => []
    } as unknown as Wcdb4Client
    const service = new AutomationService(client, {
      ruleStore: store,
      executionLog: log,
      runner: {
        run: async (input: AutomationRunInput) => ({
          steps: [],
          status: 'success' as const,
          ...(input ? {} : {})
        })
      } as unknown as AutomationActionRunner,
      getCapability: async () => capability()
    })

    await service.handleMessage(message())
    const record = log.list()[0]
    expect(record.sourceDisplayName).toBe('群聊')
    expect(JSON.stringify(record)).not.toContain('@chatroom')
    expect(JSON.stringify(record)).not.toContain('wxid')
  })

  it('执行记录里不出现 localId / serverId / source 等内部字段', async () => {
    const harness = buildHarness()
    await harness.service.handleMessage(
      message({ serverId: '7000000000000000001', localId: '424242' })
    )
    const serialized = JSON.stringify(harness.log.list())
    expect(serialized).not.toContain('424242')
    expect(serialized).not.toContain('7000000000000000001')
    expect(serialized).not.toContain('localId')
    expect(serialized).not.toContain('serverId')
  })

  it('执行失败时把失败摘要带进执行记录', async () => {
    const harness = buildHarness()
    harness.setRunResult({
      steps: [
        { key: 'received', label: '收到消息', status: 'success' },
        { key: 'matched', label: '规则匹配', status: 'success' },
        { key: 'reply', label: '回复确认', status: 'success' },
        { key: 'report', label: '生成日报', status: 'failed', error: 'AI 服务不可达' },
        { key: 'send', label: '发送日报图片', status: 'skipped' }
      ],
      status: 'failed',
      errorSummary: 'AI 服务不可达'
    })
    await harness.service.handleMessage(message())

    const record = harness.log.list()[0]
    expect(record.status).toBe('failed')
    expect(record.errorSummary).toBe('AI 服务不可达')
    expect(record.steps.find((step) => step.key === 'send')?.status).toBe('skipped')
  })

  it('执行日志落盘后能被新的实例读到（重启不丢）', async () => {
    const harness = buildHarness()
    await harness.service.handleMessage(message())
    const reloaded = new AutomationExecutionLogService()
    expect(reloaded.list()).toHaveLength(1)
    expect(reloaded.list()[0].ruleName).toBe('@我生成日报')
  })

  it('getStatus 如实反映监听状态、发送能力与今日执行数', async () => {
    const harness = buildHarness()
    await harness.service.handleMessage(message())
    const status = await harness.service.getStatus()

    expect(status.listening).toBe(true)
    // 底层只能回读最近活跃会话，这个降级标记必须一直是 true。
    expect(status.listeningDegraded).toBe(true)
    expect(status.todayExecutions).toBe(1)
    expect(status.todaySuccesses).toBe(1)
    expect(status.sendCapability).toMatchObject({
      supported: true,
      ready: true,
      canSendText: true,
      canSendImage: true
    })
  })

  it('把命中时的规则整条交给 Runner（含回复前等待）', async () => {
    const harness = buildHarness()
    await harness.service.handleMessage(message())

    expect(harness.runs).toHaveLength(1)
    // 「回复前等待」是规则自己的字段，编排层只负责把规则原样传下去 ——
    // 不该再有一份全局设置参与，否则同一字段有两个来源就必然对不上。
    expect(harness.runs[0].rule.replyDelaySeconds).toBe(2)
  })

  it('handleMessage 内部异常不会向外抛', async () => {
    const harness = buildHarness()
    const brokenStore = {
      listRules: () => {
        throw new Error('磁盘炸了')
      }
    } as unknown as AutomationRuleStore
    const service = new AutomationService(
      { getMyUsernameCandidates: () => [SELF], getSessions: () => [] } as unknown as Wcdb4Client,
      { ruleStore: brokenStore }
    )
    await expect(service.handleMessage(message())).resolves.toBeUndefined()
    void harness
  })
})

/**
 * Automation rule conversation gate —— 规则 × 会话维度的阻塞窗口。
 *
 * ```
 * blocked = inFlight || now < triggeredAt + cooldown      // 粒度：ruleId + conversationId
 * ```
 *
 * 窗口内的消息：不匹配、不执行、不回复、**不写用户执行日志**，只进诊断计数。
 * `triggeredAt` 是**第一次触发**的时间；执行完成不重置它。
 */
describe('AutomationService · rule conversation gate', () => {
  const T0 = 1_700_000_000_000

  // 这个 describe 在文件后段，**不会**继承上一个 describe 的 beforeEach；
  // 而规则是写盘的（同一个 userData root），不清理就会互相污染
  // （Test 6 建的第二条规则会漏给 Test 7/8）。
  beforeEach(() => {
    fs.removeSync(path.join(root, 'automation'))
  })

  it('Test 1 · 0s 触发，2/20/59s 全忽略，61s 重新触发（executions = 2 而不是 5）', async () => {
    let now = T0
    const harness = buildHarness({ now: () => now })

    await harness.service.handleMessage(message({ localId: '1' }))
    for (const offset of [2_000, 20_000, 59_000]) {
      now = T0 + offset
      await harness.service.handleMessage(message({ localId: `t${offset}` }))
    }
    now = T0 + 61_000
    await harness.service.handleMessage(message({ localId: 'e' }))

    expect(harness.runs).toHaveLength(2)
    expect(harness.log.list()).toHaveLength(2)
    expect(harness.service.getBlockedMessageCount()).toBe(3)
  })

  it('Test 2 · 短任务（8s 就完成）仍然阻塞到 cooldown 到期', async () => {
    let now = T0
    const harness = buildHarness({ now: () => now })

    await harness.service.handleMessage(message({ localId: '1' })) // 0s 触发，立即完成
    now = T0 + 8_000
    now = T0 + 30_000 // 任务早完成了，但 cooldown 还没到
    await harness.service.handleMessage(message({ localId: '2' }))
    expect(harness.runs).toHaveLength(1)

    now = T0 + 61_000
    await harness.service.handleMessage(message({ localId: '3' }))
    expect(harness.runs).toHaveLength(2)
  })

  it('Test 3 · 长任务（超过 cooldown）一直阻塞到执行结束：解锁 = max(完成, 触发+cooldown)', async () => {
    let now = T0
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const harness = buildHarness({
      now: () => now,
      holdExecution: () => held,
      onRunStart: markStarted
    })

    const firstRun = harness.service.handleMessage(message({ localId: '1' }))
    await started

    // 61s：cooldown 早就过期了，但第一条执行还在跑 ⇒ 仍然忽略
    now = T0 + 61_000
    await harness.service.handleMessage(message({ localId: '2' }))
    expect(harness.runs).toHaveLength(1)

    // 75s：第一条终于结束
    now = T0 + 75_000
    release()
    await firstRun

    // 76s：这才重新允许 —— **不是**「完成后再等 60 秒」
    now = T0 + 76_000
    await harness.service.handleMessage(message({ localId: '3' }))
    expect(harness.runs).toHaveLength(2)
  })

  it('Test 4 · 同群不同发送者也忽略（gate 不是 sender 级）', async () => {
    let now = T0
    const harness = buildHarness({ now: () => now })

    await harness.service.handleMessage(message({ localId: '1' }))
    now = T0 + 20_000
    await harness.service.handleMessage(
      message({ localId: '2', senderId: 'wxid_other', senderNickname: '李四' })
    )

    expect(harness.runs).toHaveLength(1)
  })

  it('Test 5 · 同一条规则在另一个群正常执行（gate 是 ruleId + conversationId）', async () => {
    let now = T0
    const harness = buildHarness({ now: () => now })

    await harness.service.handleMessage(message({ localId: '1' }))
    now = T0 + 10_000
    await harness.service.handleMessage(message({ localId: '2', sessionId: OTHER_GROUP }))

    expect(harness.runs).toHaveLength(2)
  })

  it('Test 6 · 同一群里的另一条规则不受影响（不是会话全局锁）', async () => {
    let now = T0
    const harness = buildHarness({ now: () => now })
    const seeded = harness.store.listRules()[0]
    // 第二条规则同样命中这条消息，但**没有冷却** —— 用它证明 gate 按 ruleId 隔离。
    harness.store.createRule({
      name: '帮助',
      enabled: true,
      scope: 'group',
      conditions: {
        requireMentionMe: true,
        keyword: '日报',
        keywordMatchMode: 'contains',
        conversationIds: [],
        ignoreSelf: true
      },
      actions: [{ type: 'replyText', enabled: true, text: '好的' }],
      cooldownSeconds: 0,
      replyDelaySeconds: 0
    })

    await harness.service.handleMessage(message({ localId: '1' }))
    expect(harness.runs).toHaveLength(2)

    now = T0 + 10_000
    await harness.service.handleMessage(message({ localId: '2' }))
    // 规则 A 被 gate 挡下，规则 B 照常执行。
    expect(harness.runs).toHaveLength(3)
    expect(harness.runs[2].rule.id).not.toBe(seeded.id)
  })

  it('Test 7 · 第一条失败后仍然走完整 cooldown（避免故障期疯狂重试）', async () => {
    let now = T0
    const harness = buildHarness({ now: () => now })
    harness.setRunResult({ steps: [], status: 'failed', errorSummary: 'AI 服务不可达' })

    await harness.service.handleMessage(message({ localId: '1' }))
    expect(harness.runs).toHaveLength(1)

    now = T0 + 5_000
    await harness.service.handleMessage(message({ localId: '2' }))
    expect(harness.runs).toHaveLength(1)

    now = T0 + 61_000
    await harness.service.handleMessage(message({ localId: '3' }))
    expect(harness.runs).toHaveLength(2)
  })

  it('Test 8 · 60 秒内 10 条符合条件的消息，用户执行日志只留 1 条', async () => {
    let now = T0
    const harness = buildHarness({ now: () => now })

    await harness.service.handleMessage(message({ localId: '1' }))
    for (let index = 2; index <= 11; index += 1) {
      now = T0 + index * 5_000 // 5s..55s，全部落在 60s 窗口内
      await harness.service.handleMessage(message({ localId: String(index) }))
    }

    expect(harness.runs).toHaveLength(1)
    const records = harness.log.list()
    expect(records).toHaveLength(1)
    expect(records[0].status).toBe('success')
    // 不许出现「冷却中 / 剩余 N 秒」这类记录。
    expect(JSON.stringify(records)).not.toContain('冷却')
    expect(harness.service.getBlockedMessageCount()).toBe(10)
  })
})

/**
 * gate 表清理的硬不变量：**正在执行（`inFlight === true`）的 gate 永不被淘汰**。
 *
 * 淘汰它 = 把一条正在跑的规则提前放开，立刻会产生第二次并发执行。
 * 这里用极小的上限（1）逼出清理路径。
 */
describe('AutomationService · gate 缓存清理', () => {
  const T0 = 1_700_000_000_000
  const GROUP_A = 'aaa@chatroom'
  const GROUP_B = 'bbb@chatroom'
  const GROUP_C = 'ccc@chatroom'

  beforeEach(() => {
    fs.removeSync(path.join(root, 'automation'))
  })

  it('清理只删「inFlight=false 且 cooldown 已过期」的条目，正在执行的一条必须留着', async () => {
    let now = T0
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    // 只把**第一次**执行挂住（也就是 A 群那条）；B/C 的执行立即完成。
    let runCount = 0
    const harness = buildHarness({
      now: () => now,
      gateMaxEntries: 1,
      holdExecution: () => {
        runCount += 1
        return runCount === 1 ? held : Promise.resolve()
      },
      onRunStart: markStarted
    })
    // cooldown = 0：这样「执行完成」的 gate 立刻就算「已解锁」，可以被清理。
    const seeded = harness.store.listRules()[0]
    harness.store.updateRule(seeded.id, { ...seeded, cooldownSeconds: 0 })

    // A 群：开始执行并**挂住**（gate A 处于 inFlight）
    const runningA = harness.service.handleMessage(
      message({ localId: 'a1', sessionId: GROUP_A })
    )
    await started
    expect(harness.runs).toHaveLength(1)

    // B 群：执行一次并正常结束（gate B 变成「已解锁」，是本次清理的目标）
    now = T0 + 1_000
    await harness.service.handleMessage(message({ localId: 'b1', sessionId: GROUP_B }))
    expect(harness.runs).toHaveLength(2)

    // C 群：claim 一条新 gate ⇒ 表 size 超过上限 ⇒ 触发 evictGatesIfNeeded
    now = T0 + 2_000
    await harness.service.handleMessage(message({ localId: 'c1', sessionId: GROUP_C }))

    // 关键不变量：A 的执行还在跑，往 A 发消息必须**仍然被挡住**。
    now = T0 + 3_000
    await harness.service.handleMessage(message({ localId: 'a2', sessionId: GROUP_A }))
    expect(harness.runs.filter((run) => run.conversationId === GROUP_A)).toHaveLength(1)

    release()
    await runningA
  })
})
