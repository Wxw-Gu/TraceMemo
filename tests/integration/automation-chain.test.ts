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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wxe-automation-chain-'))
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

import { AUTOMATION_SEND_PURPOSE } from '../../src/shared/automation'
import type {
  PersonalWechatSendCapability,
  PersonalWechatSendRequest
} from '../../src/shared/personal-wechat'
import type { Wcdb4Client } from '../../src/main/wcdb4-client'
import type { NormalizedIncomingMessage } from '../../src/main/services/message-listener-service'
import { WechatActionGateway } from '../../src/main/services/wechat-action-gateway'
import { AutomationRuleStore } from '../../src/main/services/automation-rule-store'
import { AutomationExecutionLogService } from '../../src/main/services/automation-execution-log-service'
import { AutomationActionRunner } from '../../src/main/services/automation-action-runner'
import { AutomationService } from '../../src/main/services/automation-service'

/**
 * 端到端：真实链路跑一遍。
 *
 * 这里除了「微信怎么把消息发出去」这一步，其余**全部是生产实现**：
 * AutomationService → TriggerMatcher → AutomationActionRunner →
 * WechatActionGateway（真实策略 + 幂等 + 节流）→ 被替换掉的传输层。
 *
 * 存在的理由：单元测试各自 mock 掉邻居，无法证明「这些部件真的能拼起来」。
 * 尤其 `AUTOMATION_PURPOSE_ALLOWLIST` 这道闸 —— 它一旦漏登记，整条链会在策略层
 * 被静默拦下，而每个单元的测试都还是绿的。
 */

const SELF = 'my_account_9527'
const GROUP_ID = '12345678@chatroom'

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

/**
 * 完整可用的发送能力替身。
 *
 * 不写 `as never` 之类的强转 —— 那样一旦 `PersonalWechatSendCapability` 加字段，
 * 这里会静默失真，而测试仍然是绿的。
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

interface Chain {
  service: AutomationService
  log: AutomationExecutionLogService
  store: AutomationRuleStore
  gateway: WechatActionGateway
  sends: PersonalWechatSendRequest[]
  reports: string[]
}

function buildChain(): Chain {
  const sends: PersonalWechatSendRequest[] = []
  const reports: string[] = []

  const gateway = new WechatActionGateway({
    getUserDataPath: () => root,
    getCapability: async () => readyCapability(),
    // 传输层是唯一被替换的部分：其余（策略、幂等、审计、节流）都是真的。
    send: async (request) => {
      sends.push(request)
      return { success: true, status: readyCapability().senderStatus }
    },
    // 节流本身要保留，但不想让测试真的等 3 秒。
    wait: async () => undefined
  })

  const store = new AutomationRuleStore({ userDataPath: () => root })
  const log = new AutomationExecutionLogService({ userDataPath: () => root })
  // 回复等待归零：端到端链路要跑得快且可复现。
  // 真实默认值是 2 秒（编辑自动化 → 3 · 触发后执行），等待语义本身由 runner 单测覆盖。
  const seeded = store.listRules()[0]
  if (seeded) store.updateRule(seeded.id, { ...seeded, replyDelaySeconds: 0 })
  const runner = new AutomationActionRunner({
    executeAction: (request) => gateway.execute(request),
    generateReport: async (request) => {
      reports.push(request.group)
      return { success: true, pngPath: path.join(root, 'report.png') }
    }
  })

  const client = {
    getMyUsernameCandidates: () => [SELF],
    getSessions: () => [{ username: GROUP_ID, nickname: '测试群' }]
  } as unknown as Wcdb4Client

  const service = new AutomationService(client, {
    ruleStore: store,
    executionLog: log,
    runner,
    getCapability: async () => readyCapability()
  })

  return { service, log, store, gateway, sends, reports }
}

describe('automation end-to-end chain', () => {
  beforeEach(() => {
    fs.removeSync(path.join(root, 'automation'))
    fs.removeSync(path.join(root, 'actions'))
  })

  afterAll(() => fs.removeSync(root))

  it('真 @我 + 「日报」→ 回复确认 + 生成日报 + 发送图片，全程走 WechatActionGateway', async () => {
    const chain = buildChain()
    await chain.service.handleMessage(message())

    // 两次发送：先文字后图片，且都真的穿过了策略层（没有被 ACTION_NOT_ALLOWED 拦下）。
    expect(chain.sends).toHaveLength(2)
    expect(chain.sends[0]).toMatchObject({
      type: 'text',
      to: GROUP_ID,
      isGroup: true,
      text: '收到，正在生成今日日报'
    })
    expect(chain.sends[1]).toMatchObject({
      type: 'image',
      to: GROUP_ID,
      isGroup: true,
      filePath: path.join(root, 'report.png')
    })
    expect(chain.reports).toEqual([GROUP_ID])

    const record = chain.log.list()[0]
    expect(record.status).toBe('success')
    expect(record.steps.map((step) => `${step.key}:${step.status}`)).toEqual([
      'received:success',
      'matched:success',
      'reply:success',
      'report:success',
      'send:success'
    ])
  })

  it('两个 purpose 都通过了策略 allowlist，并留下审计记录', () => {
    const chain = buildChain()
    return chain.service.handleMessage(message()).then(() => {
      const audit = chain.gateway.listAuditRecords()
      const purposes = audit.map((item) => item.purpose)
      expect(purposes).toContain(AUTOMATION_SEND_PURPOSE.reply)
      expect(purposes).toContain(AUTOMATION_SEND_PURPOSE.report)
      // 被拦下的话 decision 会是 block —— 这里必须都是 allow，否则就是漏登记 allowlist。
      expect(audit.every((item) => item.decision === 'allow')).toBe(true)
      expect(audit.every((item) => item.sendStatus === 'sent')).toBe(true)
      expect(audit.every((item) => item.origin === 'automation')).toBe(true)
    })
  })

  it('同一 executionId 不会重复发送（网关幂等挡住第二次）', async () => {
    const chain = buildChain()
    const first = await chain.gateway.execute({
      idempotencyKey: `${AUTOMATION_SEND_PURPOSE.reply}:exec-fixed`,
      origin: 'automation',
      purpose: AUTOMATION_SEND_PURPOSE.reply,
      triggerType: 'automation',
      executionId: 'exec-fixed',
      recipient: { type: 'group', id: GROUP_ID },
      content: { type: 'text', text: '收到，正在生成今日日报' }
    })
    expect(first.status).toBe('sent')
    expect(chain.sends).toHaveLength(1)

    const second = await chain.gateway.execute({
      idempotencyKey: `${AUTOMATION_SEND_PURPOSE.reply}:exec-fixed`,
      origin: 'automation',
      purpose: AUTOMATION_SEND_PURPOSE.reply,
      triggerType: 'automation',
      executionId: 'exec-fixed',
      recipient: { type: 'group', id: GROUP_ID },
      content: { type: 'text', text: '收到，正在生成今日日报' }
    })
    expect(second.status).toBe('sent')
    // 关键：没有第二次真实发送。
    expect(chain.sends).toHaveLength(1)
  })

  it('自己发送的回复被 MessageListener 再读到时不触发（防死循环）', async () => {
    const chain = buildChain()
    await chain.service.handleMessage(message())
    const sendsAfterFirst = chain.sends.length

    // TraceMemo 回复的那句话本身就含关键词「日报」，会被回读为一条 isSelf 消息。
    await chain.service.handleMessage(
      message({
        localId: '101',
        isSelf: true,
        content: '收到，正在生成今日日报',
        mentionTargets: []
      })
    )

    expect(chain.sends).toHaveLength(sendsAfterFirst)
    expect(chain.log.list()).toHaveLength(1)
  })

  it('规则被停用后整条链不再产生任何发送', async () => {
    const chain = buildChain()
    const builtin = chain.store.listRules()[0]
    chain.store.setRuleEnabled(builtin.id, false)
    await chain.service.handleMessage(message())

    expect(chain.sends).toHaveLength(0)
    expect(chain.log.list()).toHaveLength(0)
  })

  it('假的 @（正文里有 @昵称但无底层 @ 元数据）整条链不动作', async () => {
    const chain = buildChain()
    await chain.service.handleMessage(message({ content: '@我 今日日报', mentionTargets: [] }))
    expect(chain.sends).toHaveLength(0)
  })
})
