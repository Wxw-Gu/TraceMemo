import { describe, expect, it } from 'vitest'
import { TypingCoordinator } from '../../src/main/services/wechat-ilink/typing'
import {
  ILINK_TYPING_KEEPALIVE_MS,
  ILINK_TYPING_STATUS_CANCEL,
  ILINK_TYPING_STATUS_TYPING
} from '../../src/main/services/wechat-ilink/types'

interface HarnessOptions {
  tickets?: Array<string | undefined | Error>
  sendResults?: Array<boolean | Error | undefined>
  keepaliveMs?: number
}

function createHarness(options: HarnessOptions = {}): {
  coordinator: TypingCoordinator
  logs: string[]
  typingCalls: Array<{ userId: string; status: number; ticket: string }>
  ticks: Array<() => void>
  scheduled: number[]
  ticketCalls: () => number
  cancelled: () => number
  advance: (ms: number) => void
} {
  const tickets = [...(options.tickets ?? ['ticket-1'])]
  const sends = [...(options.sendResults ?? [])]
  const logs: string[] = []
  const typingCalls: Array<{ userId: string; status: number; ticket: string }> = []
  let ticketCalls = 0
  const ticks: Array<() => void> = []
  const scheduled: number[] = []
  let cancelled = 0
  let now = 1_000

  const coordinator = new TypingCoordinator({
    fetchTicket: async () => {
      ticketCalls += 1
      const next = tickets.length > 1 ? tickets.shift() : tickets[0]
      if (next instanceof Error) throw next
      return typeof next === 'string' ? next : undefined
    },
    sendTyping: async ({ ilinkUserId, ticket, status }) => {
      typingCalls.push({ userId: ilinkUserId, status, ticket })
      const next = sends.length > 1 ? sends.shift() : sends[0]
      if (next instanceof Error) throw next
      return next ?? true
    },
    log: (level, message) => logs.push(`${level}:${message}`),
    now: () => now,
    ...(options.keepaliveMs !== undefined ? { keepaliveMs: options.keepaliveMs } : {}),
    schedule: (tick, intervalMs) => {
      scheduled.push(intervalMs)
      ticks.push(tick)
      return () => {
        cancelled += 1
      }
    }
  })

  return {
    coordinator,
    logs,
    typingCalls,
    ticks,
    scheduled,
    ticketCalls: () => ticketCalls,
    cancelled: () => cancelled,
    advance: (ms: number) => {
      now += ms
    }
  }
}

const PEER = 'fixture-user-openid@im.wechat'

describe('TypingCoordinator', () => {
  it('正常时序：取票 → status=1 → stop 时 status=2', async () => {
    const harness = createHarness()

    const lease = await harness.coordinator.begin({ accountId: 'bot-1', to: PEER })
    expect(harness.ticketCalls()).toBe(1)
    expect(harness.typingCalls.map((call) => call.status)).toEqual([ILINK_TYPING_STATUS_TYPING])
    expect(harness.coordinator.activePeerCount).toBe(1)
    expect(harness.logs.some((line) => line.includes('typing.start'))).toBe(true)

    harness.advance(1_200)
    await lease.stop()

    expect(harness.typingCalls.map((call) => call.status)).toEqual([
      ILINK_TYPING_STATUS_TYPING,
      ILINK_TYPING_STATUS_CANCEL
    ])
    expect(harness.coordinator.activePeerCount).toBe(0)
    expect(harness.logs.some((line) => line.includes('typing.stop'))).toBe(true)
    expect(harness.logs.find((line) => line.includes('typing.stop'))).toContain('duration=1200ms')
  })

  it('typing_ticket 按「账号+对端」缓存，不会每次重取', async () => {
    const harness = createHarness()

    const first = await harness.coordinator.begin({ accountId: 'bot-1', to: PEER })
    await first.stop()
    const second = await harness.coordinator.begin({ accountId: 'bot-1', to: PEER })
    await second.stop()

    expect(harness.ticketCalls()).toBe(1)
    expect(harness.typingCalls).toHaveLength(4)
  })

  it('换账号或重新登录后缓存作废，会重新取票', async () => {
    const harness = createHarness({ tickets: ['ticket-1', 'ticket-2'] })

    const first = await harness.coordinator.begin({ accountId: 'bot-1', to: PEER })
    await first.stop()
    harness.coordinator.invalidateTickets()
    const second = await harness.coordinator.begin({ accountId: 'bot-1', to: PEER })
    await second.stop()

    expect(harness.ticketCalls()).toBe(2)
    expect(harness.typingCalls[2].ticket).toBe('ticket-2')
  })

  it('没有 typing_ticket 时降级：不下发任何 typing，也不抛异常', async () => {
    const harness = createHarness({ tickets: [undefined] })

    const lease = await harness.coordinator.begin({ accountId: 'bot-1', to: PEER })
    await lease.stop()

    expect(harness.typingCalls).toHaveLength(0)
    expect(harness.coordinator.activePeerCount).toBe(0)
    expect(harness.logs.some((line) => line.includes('typing.ticket.missing'))).toBe(true)
  })

  it('getconfig 失败时降级：业务照常，不抛异常', async () => {
    const harness = createHarness({ tickets: [new Error('getconfig 网络错误')] })

    const lease = await harness.coordinator.begin({ accountId: 'bot-1', to: PEER })
    await lease.stop()

    expect(harness.typingCalls).toHaveLength(0)
    expect(harness.logs.some((line) => line.includes('typing.ticket.failed'))).toBe(true)
  })

  it('sendtyping start 失败（返回 ret!=0）时不当成成功，也不抛异常', async () => {
    const harness = createHarness({ sendResults: [false] })

    const lease = await harness.coordinator.begin({ accountId: 'bot-1', to: PEER })
    expect(harness.coordinator.activePeerCount).toBe(0)
    expect(harness.logs.some((line) => line.includes('typing.start.failed'))).toBe(true)

    await lease.stop()
    // 没进入 active 就不该下发 cancel。
    expect(harness.typingCalls.map((call) => call.status)).toEqual([ILINK_TYPING_STATUS_TYPING])
  })

  it('sendtyping 抛异常时不冒泡', async () => {
    const harness = createHarness({ sendResults: [new Error('boom')] })

    const lease = await harness.coordinator.begin({ accountId: 'bot-1', to: PEER })
    await lease.stop()

    expect(harness.coordinator.activePeerCount).toBe(0)
  })

  it('start 失败后 ticket 缓存作废，下次会重取', async () => {
    const harness = createHarness({
      tickets: ['stale-ticket', 'fresh-ticket'],
      sendResults: [false, true]
    })

    const first = await harness.coordinator.begin({ accountId: 'bot-1', to: PEER })
    await first.stop()
    const second = await harness.coordinator.begin({ accountId: 'bot-1', to: PEER })
    await second.stop()

    expect(harness.ticketCalls()).toBe(2)
    expect(harness.typingCalls[1].ticket).toBe('fresh-ticket')
  })

  it('stop 失败时记 typing.stop.failed，但 stop 本身不抛异常', async () => {
    const harness = createHarness({ sendResults: [true, false] })

    const lease = await harness.coordinator.begin({ accountId: 'bot-1', to: PEER })
    await expect(lease.stop()).resolves.toBeUndefined()

    expect(harness.logs.some((line) => line.includes('typing.stop.failed'))).toBe(true)
  })

  it('长任务按 5 秒节奏维持 typing', async () => {
    const harness = createHarness()

    const lease = await harness.coordinator.begin({ accountId: 'bot-1', to: PEER })
    expect(harness.scheduled).toEqual([ILINK_TYPING_KEEPALIVE_MS])

    harness.ticks[0]()
    harness.ticks[0]()
    await Promise.resolve()

    expect(
      harness.typingCalls.filter((call) => call.status === ILINK_TYPING_STATUS_TYPING)
    ).toHaveLength(3)

    await lease.stop()
    expect(harness.cancelled()).toBe(1)
  })

  it('keepalive 失败只在同一会话里记一次日志', async () => {
    const harness = createHarness({ sendResults: [true, false, false, false] })

    await harness.coordinator.begin({ accountId: 'bot-1', to: PEER })
    harness.ticks[0]()
    await Promise.resolve()
    harness.ticks[0]()
    harness.ticks[0]()
    await Promise.resolve()

    expect(harness.logs.filter((line) => line.includes('typing.keepalive.failed'))).toHaveLength(1)
  })

  it('stop 之后 keepalive 不再产生请求', async () => {
    const harness = createHarness()

    const lease = await harness.coordinator.begin({ accountId: 'bot-1', to: PEER })
    await lease.stop()
    const countAfterStop = harness.typingCalls.length

    harness.ticks[0]()
    await Promise.resolve()

    expect(harness.typingCalls).toHaveLength(countAfterStop)
  })

  it('并发：先结束的任务不会取消仍在执行任务的 typing', async () => {
    const harness = createHarness()

    const first = await harness.coordinator.begin({ accountId: 'bot-1', to: PEER })
    const second = await harness.coordinator.begin({ accountId: 'bot-1', to: PEER })
    // 引用计数为 2 时不应重复 start。
    expect(
      harness.typingCalls.filter((call) => call.status === ILINK_TYPING_STATUS_TYPING)
    ).toHaveLength(1)

    await first.stop()
    expect(harness.typingCalls.map((call) => call.status)).toEqual([ILINK_TYPING_STATUS_TYPING])
    expect(harness.coordinator.activePeerCount).toBe(1)

    await second.stop()
    expect(harness.typingCalls.map((call) => call.status)).toEqual([
      ILINK_TYPING_STATUS_TYPING,
      ILINK_TYPING_STATUS_CANCEL
    ])
    expect(harness.coordinator.activePeerCount).toBe(0)
  })

  it('并发：最后一个任务结束后再次 begin 会重新 start', async () => {
    const harness = createHarness()

    const first = await harness.coordinator.begin({ accountId: 'bot-1', to: PEER })
    const second = await harness.coordinator.begin({ accountId: 'bot-1', to: PEER })
    await first.stop()
    await second.stop()

    const third = await harness.coordinator.begin({ accountId: 'bot-1', to: PEER })
    await third.stop()

    expect(harness.typingCalls.map((call) => call.status)).toEqual([
      ILINK_TYPING_STATUS_TYPING,
      ILINK_TYPING_STATUS_CANCEL,
      ILINK_TYPING_STATUS_TYPING,
      ILINK_TYPING_STATUS_CANCEL
    ])
  })

  it('不同对端的 typing 状态互相独立', async () => {
    const other = 'other-openid@im.wechat'
    const harness = createHarness()

    const a = await harness.coordinator.begin({ accountId: 'bot-1', to: PEER })
    const b = await harness.coordinator.begin({ accountId: 'bot-1', to: other })
    expect(harness.coordinator.activePeerCount).toBe(2)

    await a.stop()
    expect(harness.coordinator.activePeerCount).toBe(1)
    expect(
      harness.typingCalls.some(
        (call) => call.userId === other && call.status === ILINK_TYPING_STATUS_TYPING
      )
    ).toBe(true)
    // 只取消了自己的那一个。
    const cancels = harness.typingCalls.filter((call) => call.status === ILINK_TYPING_STATUS_CANCEL)
    expect(cancels.map((call) => call.userId)).toEqual([PEER])

    await b.stop()
    expect(harness.coordinator.activePeerCount).toBe(0)
  })

  it('lease.stop 幂等：重复调用只取消一次', async () => {
    const harness = createHarness()

    const lease = await harness.coordinator.begin({ accountId: 'bot-1', to: PEER })
    await lease.stop()
    await lease.stop()

    expect(
      harness.typingCalls.filter((call) => call.status === ILINK_TYPING_STATUS_CANCEL)
    ).toHaveLength(1)
  })

  it('stop 超过 begin 次数时不会把引用计数压成负数', async () => {
    const harness = createHarness()

    const first = await harness.coordinator.begin({ accountId: 'bot-1', to: PEER })
    const second = await harness.coordinator.begin({ accountId: 'bot-1', to: PEER })
    await first.stop()
    await first.stop()
    await second.stop()

    expect(harness.coordinator.activePeerCount).toBe(0)
    const third = await harness.coordinator.begin({ accountId: 'bot-1', to: PEER })
    expect(harness.coordinator.activePeerCount).toBe(1)
    await third.stop()
  })

  it('clear 会取消 keepalive 定时器', async () => {
    const harness = createHarness()

    await harness.coordinator.begin({ accountId: 'bot-1', to: PEER })
    harness.coordinator.clear()

    expect(harness.cancelled()).toBe(1)
    expect(harness.coordinator.activePeerCount).toBe(0)
  })

  it('日志里不出现 typing_ticket / context_token 原文', async () => {
    const secretTicket = 'TICKET-SECRET-VALUE'
    const secretContext = 'CONTEXT-TOKEN-SECRET'
    const harness = createHarness({ tickets: [secretTicket] })

    const lease = await harness.coordinator.begin({
      accountId: 'bot-1',
      to: PEER,
      contextToken: secretContext
    })
    harness.ticks[0]()
    await Promise.resolve()
    await lease.stop()

    const joined = harness.logs.join('\n')
    expect(joined).not.toContain(secretTicket)
    expect(joined).not.toContain(secretContext)
    // 也不该出现 openid 原文。
    expect(joined).not.toContain(PEER)
    // 但要有可诊断的信息。
    expect(joined).toContain('typing.start')
    expect(joined).toContain('ticketPresent=true')
  })

  it('空 to 直接返回空实现，不打任何接口', async () => {
    const harness = createHarness()

    const lease = await harness.coordinator.begin({ accountId: 'bot-1', to: '   ' })
    await lease.stop()

    expect(harness.ticketCalls()).toBe(0)
    expect(harness.typingCalls).toHaveLength(0)
  })
})
