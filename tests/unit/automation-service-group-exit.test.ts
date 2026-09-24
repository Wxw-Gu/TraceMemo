import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  chat: {
    listContacts: vi.fn(),
    getSelfAccountInfo: vi.fn()
  }
}))

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/tracememo-automation-group-exit' } }))
vi.mock('../../src/main/services/chat-service', () => mocks.chat)

import {
  AutomationService,
  leaveNotificationExecutionId,
  leaveNotificationIdempotencyKey
} from '../../src/main/services/automation-service'
import { AutomationActionRunner } from '../../src/main/services/automation-action-runner'
import type { AutomationExecutionLogService } from '../../src/main/services/automation-execution-log-service'
import type { AutomationRuleStore } from '../../src/main/services/automation-rule-store'
import {
  BUILTIN_LEAVE_NOTIFICATION_RULE_ID,
  createDefaultLeaveNotificationRule,
  type AutomationExecution,
  type AutomationRule,
  type LeaveNotificationConfig
} from '../../src/shared/automation'
import type { GroupMemberExitedEvent } from '../../src/shared/group-exit-event'
import type { PersonalWechatSendCapability } from '../../src/shared/personal-wechat'
import type { WechatActionRequest, WechatActionResult } from '../../src/shared/wechat-action'

/**
 * 退群事件 → 自动化执行。
 *
 * 这是迁移后的**唯一发送链路**，所以这里锁的是行为契约而不是实现细节：
 * 关闭不执行、四种目标各自解析正确、同一事件只发一次、失败不影响退群事实。
 */

const readyCapability: PersonalWechatSendCapability = {
  supported: true,
  ready: true,
  status: 'ready',
  capabilities: { text: true, image: true, voice: true },
  senderStatus: {} as never,
  message: 'ready'
}

const NOW = 1_700_000_000_000

function exitEvent(overrides: Partial<GroupMemberExitedEvent> = {}): GroupMemberExitedEvent {
  return {
    eventId: 'room@chatroom:wxid_member:1700000000000:1',
    conversationId: 'room@chatroom',
    groupName: '产品测试群',
    memberId: 'wxid_member',
    memberName: '张三',
    wechatNickname: '张三',
    previousCount: 243,
    currentCount: 242,
    occurredAt: NOW,
    ...overrides
  }
}

function sentAction(): WechatActionResult {
  return {
    actionId: 'action-1',
    status: 'sent',
    decision: 'allow',
    startedAt: new Date(NOW).toISOString(),
    finishedAt: new Date(NOW).toISOString()
  }
}

interface Harness {
  service: AutomationService
  requests: WechatActionRequest[]
  executions: AutomationExecution[]
  setRule: (rule: AutomationRule | undefined) => void
  setCapability: (capability: PersonalWechatSendCapability) => void
}

function createHarness(
  options: {
    config?: Partial<LeaveNotificationConfig>
    rule?: Partial<AutomationRule>
    actionResult?: () => Promise<WechatActionResult> | WechatActionResult
  } = {}
): Harness {
  const base = createDefaultLeaveNotificationRule(NOW)
  let rule: AutomationRule | undefined = {
    ...base,
    ...options.rule,
    leaveNotification: { ...base.leaveNotification!, ...options.config }
  }
  let capability: PersonalWechatSendCapability = readyCapability
  const requests: WechatActionRequest[] = []
  const executions: AutomationExecution[] = []

  const ruleStore = {
    listRules: () => (rule ? [rule] : []),
    getRule: (id: string) => (rule && rule.id === id ? rule : undefined)
  } as unknown as AutomationRuleStore
  const executionLog = {
    record: (execution: AutomationExecution) => {
      const index = executions.findIndex((item) => item.executionId === execution.executionId)
      if (index >= 0) executions[index] = execution
      else executions.push(execution)
    },
    list: () => executions,
    clear: () => true,
    countSince: () => ({ total: executions.length, success: 0 })
  } as unknown as AutomationExecutionLogService
  const runner = new AutomationActionRunner({
    executeAction: async (request) => {
      requests.push(request)
      return options.actionResult ? options.actionResult() : sentAction()
    },
    now: () => NOW
  })

  const service = new AutomationService({} as never, {
    ruleStore,
    executionLog,
    runner,
    getCapability: async () => capability,
    now: () => NOW
  })

  return {
    service,
    requests,
    executions,
    setRule: (next) => {
      rule = next
    },
    setCapability: (next) => {
      capability = next
    }
  }
}

beforeEach(() => {
  mocks.chat.listContacts.mockReset().mockReturnValue([
    { m_nsUsrName: 'wxid_friend', m_nsNickName: '好友', remark: '好友备注', type: 'user' },
    { m_nsUsrName: 'room@chatroom', m_nsNickName: '产品测试群', type: 'group' }
  ])
  mocks.chat.getSelfAccountInfo.mockReset().mockReturnValue({ wxid: 'wxid_self' })
})

describe('AutomationService.handleGroupExit', () => {
  it('退群事件 → 命中规则 → 解析目标 → Gateway 调用一次 → execution 成功', async () => {
    const harness = createHarness({ config: { target: { type: 'file_transfer' } } })

    await harness.service.handleGroupExit(exitEvent())

    expect(harness.requests).toHaveLength(1)
    expect(harness.requests[0]).toMatchObject({
      origin: 'automation',
      purpose: 'automation_leave_notification',
      triggerType: 'automation',
      recipient: { type: 'contact', id: 'filehelper', name: '文件传输助手' },
      content: { type: 'text' }
    })
    expect(harness.executions).toHaveLength(1)
    expect(harness.executions[0]).toMatchObject({
      ruleId: BUILTIN_LEAVE_NOTIFICATION_RULE_ID,
      ruleName: '退群通知',
      sourceDisplayName: '产品测试群',
      status: 'success'
    })
    // 步骤序列：触发 → 匹配 → 目标 → 发送
    expect(harness.executions[0].steps.map((step) => step.key)).toEqual([
      'exit_received',
      'exit_matched',
      'exit_target',
      'exit_send'
    ])
    // 用户可见的「目标」是显示名，不是 wxid。
    const targetStep = harness.executions[0].steps.find((step) => step.key === 'exit_target')
    expect(targetStep?.detail).toBe('文件传输助手')
  })

  it('规则关闭时不执行、也不创建 execution', async () => {
    const harness = createHarness({ rule: { enabled: false } })

    await harness.service.handleGroupExit(exitEvent())

    expect(harness.requests).toHaveLength(0)
    expect(harness.executions).toHaveLength(0)
  })

  it('目标待重选（迁移遗留）时不执行、也不创建 execution', async () => {
    const harness = createHarness({
      config: { targetNeedsReview: true, target: { type: 'file_transfer' } }
    })

    await harness.service.handleGroupExit(exitEvent())

    expect(harness.requests).toHaveLength(0)
    expect(harness.executions).toHaveLength(0)
  })

  it('缺少 eventId 时直接跳过，绝不发送', async () => {
    const harness = createHarness()

    await harness.service.handleGroupExit(exitEvent({ eventId: '' }))

    expect(harness.requests).toHaveLength(0)
  })

  it('当前群聊 → 发送目标是事件所在群', async () => {
    const harness = createHarness({ config: { target: { type: 'source_chat' } } })

    await harness.service.handleGroupExit(
      exitEvent({ conversationId: 'A@chatroom', groupName: 'A 群' })
    )

    expect(harness.requests[0].recipient).toEqual({
      type: 'group',
      id: 'A@chatroom',
      name: 'A 群'
    })
  })

  it('发给自己 → 发送目标是当前账号 wxid', async () => {
    mocks.chat.getSelfAccountInfo.mockReturnValue({ wxid: 'wxid_realme' })
    const harness = createHarness({ config: { target: { type: 'self' } } })

    await harness.service.handleGroupExit(exitEvent())

    expect(harness.requests[0].recipient).toEqual({
      type: 'contact',
      id: 'wxid_realme',
      name: '我'
    })
  })

  it('文件传输助手 → 稳定 identity，而不是昵称', async () => {
    const harness = createHarness({ config: { target: { type: 'file_transfer' } } })

    await harness.service.handleGroupExit(exitEvent())

    expect(harness.requests[0].recipient.id).toBe('filehelper')
    expect(harness.requests[0].recipient.id).not.toBe('文件传输助手')
  })

  it('指定好友 → 发送目标是保存的稳定 id', async () => {
    const harness = createHarness({
      config: { target: { type: 'contact', contactId: 'wxid_friend' } }
    })

    await harness.service.handleGroupExit(exitEvent())

    expect(harness.requests[0].recipient).toEqual({
      type: 'contact',
      id: 'wxid_friend',
      name: '好友备注'
    })
  })

  /*
   * §「旧联系人失效」：不偷偷发给别人，execution 记 failed，Gateway 一次都不调。
   */
  it('指定好友已不存在 → execution failed 且不调用 Gateway', async () => {
    const harness = createHarness({
      config: { target: { type: 'contact', contactId: 'wxid_gone' } }
    })

    await harness.service.handleGroupExit(exitEvent())

    expect(harness.requests).toHaveLength(0)
    expect(harness.executions).toHaveLength(1)
    expect(harness.executions[0].status).toBe('failed')
    expect(harness.executions[0].errorSummary).toContain('已不存在或当前无法发送')
    const sendStep = harness.executions[0].steps.find((step) => step.key === 'exit_send')
    expect(sendStep?.status).toBe('skipped')
  })

  it('发送能力缺失 → execution failed（退群事实不受影响）', async () => {
    const harness = createHarness()
    harness.setCapability({ ...readyCapability, capabilities: { text: false, image: false, voice: false } })

    await harness.service.handleGroupExit(exitEvent())

    expect(harness.requests).toHaveLength(0)
    expect(harness.executions[0].status).toBe('failed')
    expect(harness.executions[0].errorSummary).toContain('无法发送文字')
  })

  it('Gateway 抛错 → execution failed，且 handleGroupExit 自己绝不抛', async () => {
    const harness = createHarness({
      actionResult: () => {
        throw new Error('connector timeout')
      }
    })

    await expect(harness.service.handleGroupExit(exitEvent())).resolves.toBeUndefined()
    expect(harness.executions).toHaveLength(1)
    expect(harness.executions[0].status).toBe('failed')
  })

  it('Gateway 返回失败状态 → execution failed', async () => {
    const harness = createHarness({
      actionResult: () => ({
        actionId: 'action-x',
        status: 'failed',
        decision: 'allow',
        errorCode: 'SEND_FAILED',
        reason: '微信发送失败',
        startedAt: new Date(NOW).toISOString(),
        finishedAt: new Date(NOW).toISOString()
      })
    })

    await harness.service.handleGroupExit(exitEvent())

    expect(harness.executions[0].status).toBe('failed')
    expect(harness.executions[0].errorSummary).toBe('微信发送失败')
  })

  it('模板里所有变量都被替换（预览与实发共用同一套规则）', async () => {
    const harness = createHarness({
      config: {
        target: { type: 'file_transfer' },
        template: '{groupName}|{user}|{groupRemark}|{wxid}|{previousCount}->{currentCount}|{time}'
      }
    })

    await harness.service.handleGroupExit(
      exitEvent({ groupName: '产品测试群', groupRemark: '群内备注', wechatNickname: '微信昵称' })
    )

    const content = harness.requests[0].content
    expect(content.type).toBe('text')
    if (content.type === 'text') {
      // 群名（{groupName}）与成员群昵称（{groupRemark}）是两个值，不能混。
      expect(content.text).toBe(
        '产品测试群|微信昵称|群内备注|wxid_member|243->242|2023-11-15 06:13:20'
      )
    }
  })

  it('同一个 eventId 投递两次 → 只发一次、只产生一条 execution', async () => {
    const harness = createHarness()
    const event = exitEvent()

    await harness.service.handleGroupExit(event)
    await harness.service.handleGroupExit(event)

    expect(harness.requests).toHaveLength(1)
    expect(harness.executions).toHaveLength(1)
  })

  /*
   * §「不同事件」：同群两个成员先后退出就是两条通知。
   * 退群通知**不复用**消息型规则的 cooldown，否则第二次会被时间窗吞掉。
   */
  it('不同 eventId 各自执行一次，不被合并', async () => {
    const harness = createHarness()

    await harness.service.handleGroupExit(exitEvent({ eventId: 'event-a' }))
    await harness.service.handleGroupExit(exitEvent({ eventId: 'event-b' }))

    expect(harness.requests).toHaveLength(2)
    expect(harness.executions).toHaveLength(2)
    expect(new Set(harness.executions.map((item) => item.executionId)).size).toBe(2)
  })

  it('幂等键与 executionId 都由 eventId 派生（跨重启也稳定）', () => {
    const eventId = 'room@chatroom:wxid_member:1700000000000:1'

    expect(leaveNotificationIdempotencyKey(eventId)).toBe(
      `automation_leave_notification:${eventId}`
    )
    // 同一个 (ruleId, eventId) 永远算出同一个 executionId —— 重启后重复投递会覆盖同一条记录。
    expect(leaveNotificationExecutionId('rule-1', eventId)).toBe(
      leaveNotificationExecutionId('rule-1', eventId)
    )
    expect(leaveNotificationExecutionId('rule-1', eventId)).not.toBe(
      leaveNotificationExecutionId('rule-1', 'another-event')
    )
  })

  it('规则不存在或不是退群通知类型时静默跳过', async () => {
    const harness = createHarness()
    harness.setRule(undefined)

    await harness.service.handleGroupExit(exitEvent())

    expect(harness.requests).toHaveLength(0)
    expect(harness.executions).toHaveLength(0)
  })
})
