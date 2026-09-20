import { describe, expect, it } from 'vitest'
import {
  GROUP_EXIT_EVENT_MESSAGE_TYPE,
  isGroupExitEventMessage,
  mergeGroupExitEvents,
  toGroupExitEventMessage
} from '../../src/shared/group-exit-event-message'
import type { GroupExitMonitorEvent } from '../../src/shared/group-exit-monitor'
import type { Message } from '../../src/shared/types'

const at = (year: number, month: number, day: number, hour = 0, minute = 0): number =>
  new Date(year, month - 1, day, hour, minute).getTime()

const makeEvent = (overrides: Partial<GroupExitMonitorEvent> = {}): GroupExitMonitorEvent => ({
  id: 'evt-1',
  contactId: 'g'.repeat(32),
  roomId: 'room@chatroom',
  groupName: '研发群',
  memberWxid: 'wxid_a',
  memberName: '老张',
  previousCount: 10,
  currentCount: 9,
  delta: -1,
  message: '老张退出了研发群',
  detectedAt: at(2026, 9, 20, 14, 30),
  ...overrides
})

const makeMessage = (id: string, createTimeSec: number): Message => ({
  id,
  from: 'user',
  type: '文本',
  datetime: '2026-09-20 14:00',
  content: 'hello',
  isSender: false,
  createTime: createTimeSec
})

describe('toGroupExitEventMessage', () => {
  it('把事件映射成系统分支的消息，并带专用 type 标记', () => {
    const message = toGroupExitEventMessage(makeEvent())

    expect(message.id).toBe('group-exit:evt-1')
    expect(message.from).toBe('system')
    expect(message.type).toBe(GROUP_EXIT_EVENT_MESSAGE_TYPE)
    expect(message.content).toBe('老张退出了研发群')
    expect(message.isSender).toBe(false)
    expect(message.senderId).toBe('wxid_a')
    expect(message.sessionId).toBe('room@chatroom')
    expect(isGroupExitEventMessage(message)).toBe(true)
  })

  it('⚠️ createTime 必须从毫秒换算成秒（全项目 Message.createTime 都是秒）', () => {
    const detectedAt = at(2026, 9, 20, 14, 30)
    const message = toGroupExitEventMessage(makeEvent({ detectedAt }))

    // 直接塞毫秒会让事件被排到几万年之后，或者从时间轴上消失。
    expect(message.createTime).toBe(Math.floor(detectedAt / 1000))
    expect(message.createTime).toBeLessThan(1e11)
  })

  it('真实微信系统消息不会被误判为退群事件', () => {
    const systemMessage: Message = {
      id: 'm1',
      from: 'system',
      type: '系统消息',
      datetime: '2026-09-20 14:00',
      content: '某某加入了群聊',
      isSender: false
    }

    expect(isGroupExitEventMessage(systemMessage)).toBe(false)
  })
})

describe('mergeGroupExitEvents', () => {
  it('按时间升序并入，事件落在正确位置', () => {
    const messages = [
      makeMessage('m1', Math.floor(at(2026, 9, 20, 10) / 1000)),
      makeMessage('m2', Math.floor(at(2026, 9, 20, 16) / 1000))
    ]
    const events = [makeEvent({ detectedAt: at(2026, 9, 20, 14, 30) })]

    const merged = mergeGroupExitEvents(messages, events)

    expect(merged.map((message) => message.id)).toEqual(['m1', 'group-exit:evt-1', 'm2'])
  })

  it('重复合并是幂等的（广播会反复刷新，不能越插越多）', () => {
    const messages = [makeMessage('m1', Math.floor(at(2026, 9, 20, 10) / 1000))]
    const events = [makeEvent()]

    const once = mergeGroupExitEvents(messages, events)
    const twice = mergeGroupExitEvents(once, events)

    expect(twice).toHaveLength(2)
    expect(twice.map((message) => message.id)).toEqual(once.map((message) => message.id))
  })

  it('没有事件时原样返回同一个引用（避免无谓的重渲染）', () => {
    const messages = [makeMessage('m1', 1_700_000_000)]
    expect(mergeGroupExitEvents(messages, [])).toBe(messages)
  })

  it('多个事件各自成组、保持时间顺序', () => {
    const messages = [makeMessage('m1', Math.floor(at(2026, 9, 20, 8) / 1000))]
    const events = [
      makeEvent({ id: 'e1', detectedAt: at(2026, 9, 20, 12) }),
      makeEvent({ id: 'e2', detectedAt: at(2026, 9, 20, 15) })
    ]

    const merged = mergeGroupExitEvents(messages, events)

    expect(merged.map((message) => message.id)).toEqual([
      'm1',
      'group-exit:e1',
      'group-exit:e2'
    ])
  })
})
