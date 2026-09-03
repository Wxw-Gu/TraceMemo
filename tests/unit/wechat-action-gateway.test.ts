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
  WechatActionGateway
} from '../../src/main/services/wechat-action-gateway'
import type { PersonalWechatSendCapability } from '../../src/shared/personal-wechat'
import type { WechatActionResult } from '../../src/shared/wechat-action'

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

  function memberAction(
    gateway: WechatActionGateway,
    roomId = 'room@chatroom'
  ): Promise<WechatActionResult> {
    gateway.registerMemberEvent({ id: 'event-1', roomId: 'room@chatroom' })
    return gateway.execute({
      origin: 'member_monitor',
      purpose: 'member_left_notification',
      triggerType: 'automation',
      sourceId: 'event-1',
      recipient: { type: 'group', id: roomId },
      content: { type: 'text', text: '张三已退出群聊' }
    })
  }

  it('allows a valid member action, sends once, and writes an audit record', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'tracememo-wechat-action-'))
    directories.push(userData)
    const gateway = new WechatActionGateway({ getUserDataPath: () => userData })
    const result = await memberAction(gateway)

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
        purpose: 'member_left_notification',
        recipientId: 'room@chatroom',
        sendStatus: 'sent',
        decision: 'allow',
        contentPreview: '张三已退出群聊'
      })
    ])
  })

  it('deduplicates the same member event across repeated execution calls', async () => {
    const gateway = createGateway()
    const first = await memberAction(gateway)
    const second = await memberAction(gateway)

    expect(second.actionId).toBe(first.actionId)
    expect(mocks.sender.send).toHaveBeenCalledOnce()
  })

  it('blocks a recipient outside the source group', async () => {
    const gateway = createGateway()
    const result = await memberAction(gateway, 'other@chatroom')

    expect(result).toMatchObject({
      status: 'blocked',
      decision: 'block',
      errorCode: 'RECIPIENT_SCOPE_VIOLATION'
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
      origin: 'member_monitor',
      purpose: 'member_left_notification',
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
      origin: 'member_monitor',
      purpose: 'member_left_notification',
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

  it('does not accept an event lookup for a different source id', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'tracememo-wechat-action-'))
    directories.push(userData)
    const gateway = new WechatActionGateway({
      getUserDataPath: () => userData,
      getMemberEvent: () => ({ id: 'different-event', roomId: 'room@chatroom' })
    })
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
      errorCode: 'INVALID_REQUEST'
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
    const result = await memberAction(gateway)

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
    const result = await memberAction(gateway)

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
    const first = memberAction(gateway)
    await vi.advanceTimersByTimeAsync(0)
    gateway.registerMemberEvent({ id: 'event-2', roomId: 'room@chatroom' })
    const second = gateway.execute({
      origin: 'member_monitor',
      purpose: 'member_left_notification',
      triggerType: 'automation',
      sourceId: 'event-2',
      recipient: { type: 'group', id: 'room@chatroom' },
      content: { type: 'text', text: '李四已退出群聊' }
    })

    await vi.advanceTimersByTimeAsync(AUTOMATION_SEND_INTERVAL_MS)
    const results = await Promise.all([first, second])

    expect(results.map((result) => result.status)).toEqual(['failed', 'sent'])
    expect(sentAt[1] - sentAt[0]).toBe(AUTOMATION_SEND_INTERVAL_MS)
    vi.useRealTimers()
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

    await expect(memberAction(gateway)).resolves.toMatchObject({
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
})
