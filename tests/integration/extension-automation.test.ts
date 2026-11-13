import fs from 'fs-extra'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const root = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path')
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tm-extension-automation-'))
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

import {
  createDefaultDailyReportRule,
  describeRuleActions,
  normalizeRuleDraft,
  type AutomationRule
} from '../../src/shared/automation'
import type { WechatActionRequest, WechatActionResult } from '../../src/shared/wechat-action'
import { AutomationActionRunner } from '../../src/main/services/automation-action-runner'
import { AutomationRuleStore } from '../../src/main/services/automation-rule-store'

const sent: WechatActionResult = {
  actionId: 'action-1',
  status: 'sent',
  decision: 'allow',
  startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:00:01.000Z'
}

function extensionRule(): AutomationRule {
  return {
    ...createDefaultDailyReportRule(0),
    id: 'rule-with-extension',
    name: '关键词回复',
    conditions: {
      requireMentionMe: false,
      keyword: '你好',
      keywordMatchMode: 'contains',
      conversationIds: [],
      ignoreSelf: true
    },
    actions: [
      {
        type: 'extensionAction',
        enabled: true,
        extensionId: 'com.example.keyword-bot',
        actionId: 'keyword.reply'
      }
    ]
  }
}

function runner(dependencies: {
  reply?: { type: 'text'; text: string }
  canSend?: boolean
  fail?: boolean
}): {
  instance: AutomationActionRunner
  executeAction: ReturnType<
    typeof vi.fn<(request: WechatActionRequest) => Promise<WechatActionResult>>
  >
} {
  const executeAction = vi.fn(async (request: WechatActionRequest) => {
    void request
    return sent
  })
  const instance = new AutomationActionRunner({
    executeAction,
    invokeExtensionAction: async () => {
      if (dependencies.fail) throw new Error('扩展崩溃')
      return {
        success: true,
        output: { matched: true },
        ...(dependencies.reply ? { reply: dependencies.reply } : {})
      }
    },
    canExtensionSendText: () => dependencies.canSend !== false,
    delay: async () => undefined,
    now: () => 1_000
  })
  return { instance, executeAction }
}

const message = {
  eventId: 'message:1',
  accountId: 'wxid_self',
  conversationId: 'fixture-room@chatroom',
  messageId: '9001',
  senderId: 'wxid_peer',
  senderName: '张三',
  isGroup: true,
  isSelf: false,
  type: 'text' as const,
  text: '你好',
  mentionsMe: false,
  timestamp: 1_700_000_000_000
}

describe('extension automation action', () => {
  it('扩展返回 reply 后由宿主经 Gateway 发送', async () => {
    const { instance, executeAction } = runner({ reply: { type: 'text', text: '你好呀！' } })
    const result = await instance.run({
      executionId: 'exec-1',
      rule: extensionRule(),
      conversationId: 'fixture-room@chatroom',
      isGroup: true,
      sourceDisplayName: '测试群',
      message
    })
    expect(result.status).toBe('success')
    expect(result.steps.map((step) => step.key)).toEqual([
      'received',
      'matched',
      'extension_action',
      'reply',
      'report',
      'send'
    ])
    expect(executeAction).toHaveBeenCalledTimes(1)
    const request = executeAction.mock.calls[0][0]
    expect(request.origin).toBe('extension')
    expect(request.purpose).toBe('extension_action')
    expect(request.triggerType).toBe('automation')
    expect(request.idempotencyKey).toBe('extension_action:exec-1')
    expect(request.recipient).toMatchObject({ type: 'group', id: 'fixture-room@chatroom' })
    expect(request.content).toEqual({ type: 'text', text: '你好呀！' })
    expect((request.metadata as { extensionId: string }).extensionId).toBe(
      'com.example.keyword-bot'
    )
  })

  it('扩展没有发送权限时拒绝发送，且不调用 Gateway', async () => {
    const { instance, executeAction } = runner({
      reply: { type: 'text', text: '你好呀！' },
      canSend: false
    })
    const result = await instance.run({
      executionId: 'exec-2',
      rule: extensionRule(),
      conversationId: 'fixture-room@chatroom',
      isGroup: true,
      sourceDisplayName: '测试群',
      message
    })
    expect(result.status).toBe('failed')
    expect(result.errorSummary).toContain('wechat.send.text')
    expect(executeAction).not.toHaveBeenCalled()
    const reply = result.steps.find((step) => step.key === 'reply')
    expect(reply?.status).toBe('failed')
  })

  it('扩展动作失败时后续步骤全部跳过', async () => {
    const { instance, executeAction } = runner({ fail: true })
    const result = await instance.run({
      executionId: 'exec-3',
      rule: extensionRule(),
      conversationId: 'fixture-room@chatroom',
      isGroup: true,
      sourceDisplayName: '测试群',
      message
    })
    expect(result.status).toBe('failed')
    expect(result.steps.find((step) => step.key === 'extension_action')?.status).toBe('failed')
    expect(result.steps.filter((step) => step.status === 'skipped')).toHaveLength(3)
    expect(executeAction).not.toHaveBeenCalled()
  })

  it('未配置扩展动作时步骤列表保持原样', async () => {
    const { instance } = runner({})
    const rule: AutomationRule = {
      ...createDefaultDailyReportRule(0),
      actions: [{ type: 'replyText', enabled: true, text: '收到' }]
    }
    const result = await instance.run({
      executionId: 'exec-4',
      rule,
      conversationId: 'fixture-room@chatroom',
      isGroup: true,
      sourceDisplayName: '测试群',
      message
    })
    expect(result.steps.map((step) => step.key)).toEqual([
      'received',
      'matched',
      'reply',
      'report',
      'send'
    ])
  })
})

describe('extension action persistence', () => {
  it('规则保存后仍保留扩展动作，缺少扩展/动作 id 的草稿会被丢弃', () => {
    const store = new AutomationRuleStore({ userDataPath: () => path.join(root, 'rules') })
    const created = store.createRule({
      name: '扩展规则',
      enabled: true,
      ruleType: 'daily_report',
      scope: 'group',
      conditions: { keyword: '你好', keywordMatchMode: 'contains' },
      cooldownSeconds: 30,
      replyDelaySeconds: 0,
      actions: [
        {
          type: 'extensionAction',
          enabled: true,
          extensionId: 'com.example.keyword-bot',
          actionId: 'keyword.reply'
        },
        { type: 'extensionAction', enabled: true }
      ]
    })
    expect(created.actions).toHaveLength(1)
    expect(created.actions[0]).toMatchObject({
      type: 'extensionAction',
      extensionId: 'com.example.keyword-bot',
      actionId: 'keyword.reply'
    })
    const reloaded = new AutomationRuleStore({
      userDataPath: () => path.join(root, 'rules')
    }).getRule(created.id)
    expect(reloaded?.actions[0].extensionId).toBe('com.example.keyword-bot')
    expect(describeRuleActions(reloaded!)).toBe('执行扩展动作')
  })

  it('input 只接受 JSON 对象，超限丢弃', () => {
    const normalized = normalizeRuleDraft({
      actions: [
        {
          type: 'extensionAction',
          enabled: true,
          extensionId: 'com.example.keyword-bot',
          actionId: 'keyword.reply',
          input: { url: 'https://example.com', nested: { ok: true } }
        }
      ]
    })
    expect(normalized.actions[0].input).toEqual({
      url: 'https://example.com',
      nested: { ok: true }
    })
    const tooBig = normalizeRuleDraft({
      actions: [
        {
          type: 'extensionAction',
          enabled: true,
          extensionId: 'com.example.keyword-bot',
          actionId: 'keyword.reply',
          input: { blob: 'x'.repeat(5_000) }
        }
      ]
    })
    expect(tooBig.actions[0].input).toBeUndefined()
  })
})

process.on('exit', () => {
  fs.removeSync(root)
})
