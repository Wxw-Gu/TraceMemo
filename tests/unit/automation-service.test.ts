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

function buildHarness(options: { now?: () => number; capability?: PersonalWechatSendCapability } = {}): Harness {
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
    ...(options.now ? { now: options.now } : {})
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

  it('同一条消息被重复投递时只执行一次', async () => {
    const harness = buildHarness()
    await harness.service.handleMessage(message())
    await harness.service.handleMessage(message())
    await harness.service.handleMessage(message({ localId: '100' }))

    expect(harness.runs).toHaveLength(1)
    expect(harness.log.list()).toHaveLength(1)
  })

  it('同一条消息在不同群里各算一次（localId 单独跨群不唯一）', async () => {
    const harness = buildHarness()
    await harness.service.handleMessage(message())
    await harness.service.handleMessage(message({ sessionId: OTHER_GROUP }))

    expect(harness.runs).toHaveLength(2)
  })

  it('cooldown 内不重复触发', async () => {
    let now = 1_700_000_000_000
    const harness = buildHarness({ now: () => now })

    await harness.service.handleMessage(message({ localId: '1' }))
    now += 30_000
    await harness.service.handleMessage(message({ localId: '2' }))

    expect(harness.runs).toHaveLength(1)
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
