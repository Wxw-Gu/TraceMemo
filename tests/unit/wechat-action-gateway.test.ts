import { mkdtempSync, readJsonSync, rmSync } from 'fs-extra'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  capability: { getPersonalWechatSendCapability: vi.fn() },
  sender: { send: vi.fn() }
}))

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/tracememo-gateway-default' } }))
vi.mock('../../src/main/services/personal-wechat-capability-service', () => ({
  personalWechatCapabilityService: mocks.capability
}))
vi.mock('../../src/main/services/personal-wechat-send-service', () => ({
  personalWechatSendService: mocks.sender
}))

import {
  AUTOMATION_SEND_INTERVAL_MS,
  WechatActionGateway,
  toPersonalWechatSendResult
} from '../../src/main/services/wechat-action-gateway'
import type { PersonalWechatSendCapability } from '../../src/shared/personal-wechat'
import type { WechatActionRequest, WechatActionResult } from '../../src/shared/wechat-action'

const readyCapability: PersonalWechatSendCapability = {
  supported: true,
  ready: true,
  status: 'ready',
  capabilities: { text: true, image: true, voice: true },
  senderStatus: {} as never,
  message: 'ready'
}

describe('WechatActionGateway', () => {
  const directories: string[] = []

  beforeEach(() => {
    mocks.capability.getPersonalWechatSendCapability.mockReset().mockResolvedValue(readyCapability)
    mocks.sender.send.mockReset().mockResolvedValue({ success: true, status: {} })
  })

  afterEach(() => {
    while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true })
  })

  function createGateway(): WechatActionGateway {
    const userData = mkdtempSync(join(tmpdir(), 'tracememo-wechat-action-'))
    directories.push(userData)
    return new WechatActionGateway({ getUserDataPath: () => userData })
  }

  /**
   * 退群通知 —— 迁移后由 **Automation** 发出（purpose `automation_leave_notification`）。
   *
   * 幂等键由 eventId 派生，与 `AutomationService.leaveNotificationIdempotencyKey` 同口径；
   * 收件人**不再被锁死在事件所在群**（可以发给自己 / 文件传输助手 / 指定好友）。
   */
  function leaveNotificationAction(
    gateway: WechatActionGateway,
    recipient: WechatActionRequest['recipient'] = { type: 'group', id: 'room@chatroom' },
    eventId = 'event-1'
  ): Promise<WechatActionResult> {
    return gateway.execute({
      idempotencyKey: `automation_leave_notification:${eventId}`,
      origin: 'automation',
      purpose: 'automation_leave_notification',
      triggerType: 'automation',
      executionId: `exec-${eventId}`,
      sourceId: eventId,
      recipient,
      content: { type: 'text', text: '张三已退出群聊' }
    })
  }

  it('sends a leave notification once and writes an audit record', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'tracememo-wechat-action-'))
    directories.push(userData)
    const gateway = new WechatActionGateway({ getUserDataPath: () => userData })
    const result = await leaveNotificationAction(gateway)

    expect(result).toMatchObject({ status: 'sent', decision: 'allow' })
    expect(mocks.sender.send).toHaveBeenCalledOnce()
    expect(mocks.sender.send).toHaveBeenCalledWith({
      type: 'text',
      to: 'room@chatroom',
      isGroup: true,
      text: '张三已退出群聊'
    })
    const audit = readJsonSync(join(userData, 'actions', 'wechat-actions.json'))
    expect(audit).toEqual([
      expect.objectContaining({
        purpose: 'automation_leave_notification',
        recipientId: 'room@chatroom',
        sendStatus: 'sent',
        decision: 'allow',
        contentPreview: '张三已退出群聊'
      })
    ])
  })

  it('deduplicates the same leave event across repeated execution calls', async () => {
    const gateway = createGateway()
    const first = await leaveNotificationAction(gateway)
    const second = await leaveNotificationAction(gateway)

    expect(second.actionId).toBe(first.actionId)
    expect(mocks.sender.send).toHaveBeenCalledOnce()
  })

  /**
   * 迁移的核心：**不再有「只能发回原群」的作用域锁**。
   * 四种目标必须都能发出去，否则「自己 / 文件传输助手 / 指定好友」形同虚设。
   */
  it('allows every leave-notification recipient, not just the source group', async () => {
    // 四条自动化发送串行且彼此间隔 3 秒 —— 用假定时器推过去，别真的等 9 秒。
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-24T10:00:00.000Z'))
    const gateway = createGateway()
    const targets: Array<{ to: string; isGroup: boolean }> = []
    mocks.sender.send.mockImplementation(async (request: { to: string; isGroup: boolean }) => {
      targets.push({ to: request.to, isGroup: request.isGroup })
      return { success: true, status: {} }
    })

    const pending = [
      leaveNotificationAction(gateway, { type: 'group', id: 'room@chatroom' }, 'event-1'),
      leaveNotificationAction(gateway, { type: 'contact', id: 'wxid_self' }, 'event-2'),
      leaveNotificationAction(gateway, { type: 'contact', id: 'filehelper' }, 'event-3'),
      leaveNotificationAction(gateway, { type: 'contact', id: 'wxid_friend' }, 'event-4')
    ]
    await vi.advanceTimersByTimeAsync(AUTOMATION_SEND_INTERVAL_MS * 4)
    const results = await Promise.all(pending)

    for (const result of results) {
      expect(result).toMatchObject({ status: 'sent', decision: 'allow' })
    }
    expect(targets).toEqual([
      { to: 'room@chatroom', isGroup: true },
      { to: 'wxid_self', isGroup: false },
      { to: 'filehelper', isGroup: false },
      { to: 'wxid_friend', isGroup: false }
    ])
    vi.useRealTimers()
  })

  /**
   * 回归闸门：旧的发送用途**已经在代码上不可能再发出去**。
   * 退群监控不再产生它，allowlist 也把它摘了 —— 谁要是把它加回来，这里会红。
   */
  it('blocks the legacy member_left_notification purpose', async () => {
    const gateway = createGateway()
    const result = await gateway.execute({
      origin: 'member_monitor',
      purpose: 'member_left_notification',
      triggerType: 'automation',
      sourceId: 'event-1',
      recipient: { type: 'group', id: 'room@chatroom' },
      content: { type: 'text', text: '张三已退出群聊' }
    })

    expect(result).toMatchObject({
      status: 'blocked',
      decision: 'block',
      errorCode: 'ACTION_NOT_ALLOWED'
    })
    expect(mocks.sender.send).not.toHaveBeenCalled()
  })

  it('blocks unknown automation purposes before checking capability', async () => {
    const gateway = createGateway()
    const result = await gateway.execute({
      origin: 'unknown',
      purpose: 'arbitrary_message',
      triggerType: 'automation',
      recipient: { type: 'group', id: 'room@chatroom' },
      content: { type: 'text', text: '不应自动发送' }
    })

    expect(result).toMatchObject({
      status: 'blocked',
      decision: 'block',
      errorCode: 'ACTION_NOT_ALLOWED'
    })
    expect(mocks.capability.getPersonalWechatSendCapability).not.toHaveBeenCalled()
    expect(mocks.sender.send).not.toHaveBeenCalled()
  })

  it('returns INVALID_REQUEST for malformed input without throwing from audit handling', async () => {
    const gateway = createGateway()
    const result = await gateway.execute({
      origin: 'automation',
      purpose: 'automation_leave_notification',
      triggerType: 'automation',
      recipient: { type: 'group', id: 'room@chatroom' }
    } as never)

    expect(result).toMatchObject({
      status: 'blocked',
      decision: 'block',
      errorCode: 'INVALID_REQUEST'
    })
  })

  it('returns INVALID_RECIPIENT when the recipient id is missing', async () => {
    const gateway = createGateway()
    const result = await gateway.execute({
      origin: 'automation',
      purpose: 'automation_leave_notification',
      triggerType: 'automation',
      sourceId: 'event-1',
      recipient: { type: 'group', id: '' },
      content: { type: 'text', text: '张三已退出群聊' }
    })

    expect(result).toMatchObject({
      status: 'blocked',
      decision: 'block',
      errorCode: 'INVALID_RECIPIENT'
    })
    expect(mocks.sender.send).not.toHaveBeenCalled()
  })

  it('returns a structured capability failure without sending', async () => {
    const gateway = createGateway()
    mocks.capability.getPersonalWechatSendCapability.mockResolvedValueOnce({
      ...readyCapability,
      ready: false,
      capabilities: { text: false, image: false, voice: false },
      message: '当前微信发送能力不可用'
    })
    const result = await leaveNotificationAction(gateway)

    expect(result).toMatchObject({
      status: 'failed',
      decision: 'allow',
      errorCode: 'SEND_CAPABILITY_UNAVAILABLE'
    })
    expect(mocks.sender.send).not.toHaveBeenCalled()
  })

  it('用户主动发送只依赖微信发送能力', async () => {
    const gateway = createGateway()
    const result = await gateway.execute({
      origin: 'user_tts',
      purpose: 'tts_voice',
      triggerType: 'user',
      recipient: { type: 'contact', id: 'wxid_user' },
      content: { type: 'text', text: '用户主动发送' }
    })

    expect(result).toMatchObject({ status: 'sent', decision: 'allow' })
    expect(mocks.sender.send).toHaveBeenCalledOnce()
  })

  it('converts a transport throw into SEND_FAILED', async () => {
    const gateway = createGateway()
    mocks.sender.send.mockRejectedValueOnce(new Error('connector timeout'))
    const result = await leaveNotificationAction(gateway)

    expect(result).toMatchObject({
      status: 'failed',
      decision: 'allow',
      errorCode: 'SEND_FAILED',
      reason: 'connector timeout'
    })
  })

  it('sends accepted automation actions in FIFO order at least three seconds apart', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-03T08:00:00.000Z'))
    const gateway = createGateway()
    const sentAt: Array<{ to: string; at: number }> = []
    mocks.sender.send.mockImplementation(async (request: { to: string }) => {
      sentAt.push({ to: request.to, at: Date.now() })
      return { success: true, status: {} }
    })
    const action = (id: string) =>
      gateway.execute({
        idempotencyKey: `scheduled:${id}`,
        origin: 'scheduled_report',
        purpose: 'scheduled_report',
        triggerType: 'automation',
        executionId: id,
        recipient: { type: 'group', id: `${id}@chatroom` },
        content: { type: 'image', path: `/tmp/${id}.png` }
      })

    const pending = [action('A'), action('B'), action('C')]
    await vi.advanceTimersByTimeAsync(0)
    expect(sentAt).toEqual([{ to: 'A@chatroom', at: Date.now() }])

    await vi.advanceTimersByTimeAsync(AUTOMATION_SEND_INTERVAL_MS - 1)
    expect(sentAt).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(sentAt.map((item) => item.to)).toEqual(['A@chatroom', 'B@chatroom'])
    await vi.advanceTimersByTimeAsync(AUTOMATION_SEND_INTERVAL_MS)
    await Promise.all(pending)

    expect(sentAt.map((item) => item.to)).toEqual([
      'A@chatroom',
      'B@chatroom',
      'C@chatroom'
    ])
    expect(sentAt[1].at - sentAt[0].at).toBe(AUTOMATION_SEND_INTERVAL_MS)
    expect(sentAt[2].at - sentAt[1].at).toBe(AUTOMATION_SEND_INTERVAL_MS)
    vi.useRealTimers()
  })

  it('keeps the safety interval after a failed automatic send', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-03T09:00:00.000Z'))
    const gateway = createGateway()
    const sentAt: number[] = []
    mocks.sender.send.mockImplementation(async () => {
      sentAt.push(Date.now())
      if (sentAt.length === 1) throw new Error('first failed')
      return { success: true, status: {} }
    })
    const first = leaveNotificationAction(gateway)
    await vi.advanceTimersByTimeAsync(0)
    // 第二条用不同的 eventId → 不同的幂等键，才会真的进队列。
    const second = leaveNotificationAction(gateway, { type: 'group', id: 'room@chatroom' }, 'event-2')

    await vi.advanceTimersByTimeAsync(AUTOMATION_SEND_INTERVAL_MS)
    const results = await Promise.all([first, second])

    expect(results.map((result) => result.status)).toEqual(['failed', 'sent'])
    expect(sentAt[1] - sentAt[0]).toBe(AUTOMATION_SEND_INTERVAL_MS)
    vi.useRealTimers()
  })

  it('sends a report postfix only after the image succeeds and keeps the 3s interval', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-23T09:00:00.000Z'))
    const gateway = createGateway()
    const sent: Array<{ type: string; at: number }> = []
    mocks.sender.send.mockImplementation(async (request: { type: string }) => {
      sent.push({ type: request.type, at: Date.now() })
      return { success: true, status: {} }
    })

    const pending = gateway.executeReportImageSequence({
      recipient: { type: 'group', id: 'room@chatroom' },
      imagePath: '/tmp/report.png',
      postfixText: '今日日报'
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(sent.map((item) => item.type)).toEqual(['image'])

    await vi.advanceTimersByTimeAsync(AUTOMATION_SEND_INTERVAL_MS - 1)
    expect(sent).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    const result = await pending

    expect(result.image.status).toBe('sent')
    expect(result.postfix?.status).toBe('sent')
    expect(sent.map((item) => item.type)).toEqual(['image', 'text'])
    expect(sent[1].at - sent[0].at).toBe(AUTOMATION_SEND_INTERVAL_MS)
    vi.useRealTimers()
  })

  it('does not create the report postfix action when the image fails', async () => {
    const gateway = createGateway()
    mocks.sender.send.mockResolvedValueOnce({
      success: false,
      status: {},
      error: 'image failed'
    })

    const result = await gateway.executeReportImageSequence({
      recipient: { type: 'group', id: 'room@chatroom' },
      imagePath: '/tmp/report.png',
      postfixText: '今日日报'
    })

    expect(result.image.status).toBe('failed')
    expect(result.postfix).toBeUndefined()
    expect(mocks.sender.send).toHaveBeenCalledOnce()
  })

  it('lets a user action send immediately while an automatic action is waiting', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-03T09:30:00.000Z'))
    const gateway = createGateway()
    const sent: Array<{ to: string; at: number }> = []
    mocks.sender.send.mockImplementation(async (request: { to: string }) => {
      sent.push({ to: request.to, at: Date.now() })
      return { success: true, status: {} }
    })
    const automaticAction = (id: string) =>
      gateway.execute({
        idempotencyKey: `scheduled:${id}`,
        origin: 'scheduled_report',
        purpose: 'scheduled_report',
        triggerType: 'automation',
        executionId: id,
        recipient: { type: 'group', id: `${id}@chatroom` },
        content: { type: 'image', path: `/tmp/${id}.png` }
      })

    const first = automaticAction('first')
    const waiting = automaticAction('waiting')
    await vi.advanceTimersByTimeAsync(0)
    const userResult = await gateway.execute({
      origin: 'user_tts',
      purpose: 'tts_voice',
      triggerType: 'user',
      recipient: { type: 'contact', id: 'wxid_user' },
      content: { type: 'text', text: '用户主动发送' }
    })

    expect(userResult.status).toBe('sent')
    expect(sent).toEqual([
      { to: 'first@chatroom', at: Date.now() },
      { to: 'wxid_user', at: Date.now() }
    ])

    await vi.advanceTimersByTimeAsync(AUTOMATION_SEND_INTERVAL_MS)
    await Promise.all([first, waiting])
    expect(sent[2]).toEqual({ to: 'waiting@chatroom', at: Date.now() })
    vi.useRealTimers()
  })

  it('does not put capability failures into the automatic send queue', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-03T10:00:00.000Z'))
    const gateway = createGateway()
    mocks.capability.getPersonalWechatSendCapability
      .mockResolvedValueOnce({ ...readyCapability, ready: false })
      .mockResolvedValueOnce(readyCapability)

    await expect(leaveNotificationAction(gateway)).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'SEND_CAPABILITY_UNAVAILABLE'
    })
    const startedAt = Date.now()
    await gateway.execute({
      origin: 'scheduled_report',
      purpose: 'scheduled_report',
      triggerType: 'automation',
      executionId: 'execution-ready',
      recipient: { type: 'group', id: 'room@chatroom' },
      content: { type: 'image', path: '/tmp/report.png' }
    })

    expect(mocks.sender.send).toHaveBeenCalledOnce()
    expect(Date.now()).toBe(startedAt)
    vi.useRealTimers()
  })

  /**
   * 项目规则：**所有发送都走 WechatActionGateway**。
   *
   * 手动发送（`wechat-personal:send`）改造前是直连 `PersonalWechatSendService` 的，
   * 于是没有审计、没有幂等、也不进 Send Log。这一组锁住改造后的语义。
   */
  describe('用户手动发送（triggerType: user）', () => {
    function manualAction(
      gateway: WechatActionGateway,
      overrides: Partial<WechatActionRequest> = {}
    ): Promise<WechatActionResult> {
      return gateway.execute({
        origin: 'user_manual',
        purpose: 'manual_image',
        triggerType: 'user',
        recipient: { type: 'group', id: 'room@chatroom' },
        content: { type: 'image', path: '/tmp/report.png' },
        ...overrides
      } as WechatActionRequest)
    }

    it('放行、发送一次，并写入审计记录', async () => {
      const userData = mkdtempSync(join(tmpdir(), 'tracememo-wechat-action-'))
      directories.push(userData)
      const gateway = new WechatActionGateway({ getUserDataPath: () => userData })

      const result = await manualAction(gateway)

      expect(result).toMatchObject({ status: 'sent', decision: 'allow' })
      expect(mocks.sender.send).toHaveBeenCalledWith({
        type: 'image',
        to: 'room@chatroom',
        isGroup: true,
        filePath: '/tmp/report.png'
      })
      const audit = readJsonSync(join(userData, 'actions', 'wechat-actions.json'))
      expect(audit).toEqual([
        expect.objectContaining({
          origin: 'user_manual',
          purpose: 'manual_image',
          triggerType: 'user',
          recipientId: 'room@chatroom',
          decision: 'allow',
          sendStatus: 'sent'
        })
      ])
    })

    it('不受 automation 的 purpose allowlist 限制，也不吃 3s 节流', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-09-21T01:00:00.000Z'))
      const gateway = createGateway()

      const first = await manualAction(gateway)
      const second = await manualAction(gateway)

      expect(first.status).toBe('sent')
      expect(second.status).toBe('sent')
      // 节流只对 triggerType === 'automation' 生效：两次点击必须立刻都发出去。
      expect(mocks.sender.send).toHaveBeenCalledTimes(2)
      vi.useRealTimers()
    })

    it('空文本由规范化拦下，不落到发送层', async () => {
      const gateway = createGateway()
      const result = await manualAction(gateway, {
        purpose: 'manual_text',
        content: { type: 'text', text: '   ' }
      })

      expect(result.status).toBe('blocked')
      expect(result.errorCode).toBe('INVALID_REQUEST')
      expect(mocks.sender.send).not.toHaveBeenCalled()
    })
  })

  describe('toPersonalWechatSendResult', () => {
    const fallback = { canSend: true } as unknown as Parameters<
      typeof toPersonalWechatSendResult
    >[1]

    it('优先返回底层 sendResult（它带着真实的 status）', () => {
      const underlying = { success: true, status: { canSend: true, marker: 'real' } }
      expect(
        toPersonalWechatSendResult(
          {
            actionId: 'a1',
            status: 'sent',
            decision: 'allow',
            startedAt: '2026-09-21T01:00:00.000Z',
            finishedAt: '2026-09-21T01:00:01.000Z',
            sendResult: underlying
          },
          fallback
        )
      ).toBe(underlying)
    })

    it('拿不到 sendResult 时按 action.status 合成', () => {
      const sent = toPersonalWechatSendResult(
        {
          actionId: 'a1',
          status: 'sent',
          decision: 'allow',
          startedAt: '2026-09-21T01:00:00.000Z',
          finishedAt: '2026-09-21T01:00:01.000Z'
        },
        fallback
      )
      expect(sent).toEqual({ success: true, status: fallback })

      const blocked = toPersonalWechatSendResult(
        {
          actionId: 'a2',
          status: 'blocked',
          decision: 'block',
          errorCode: 'ACTION_NOT_ALLOWED',
          reason: '自动化动作不允许执行',
          startedAt: '2026-09-21T01:00:00.000Z',
          finishedAt: '2026-09-21T01:00:01.000Z'
        },
        fallback
      )
      expect(blocked.success).toBe(false)
      expect(blocked.error).toBe('自动化动作不允许执行')
    })
  })
})
