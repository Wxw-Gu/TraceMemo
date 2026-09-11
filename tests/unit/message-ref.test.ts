import { describe, expect, it } from 'vitest'
import {
  decodeMessageRef,
  encodeMessageRef,
  normalizeMessageIdentity
} from '../../src/shared/local-query-api'
import {
  MESSAGES_AROUND_MAX_WINDOW,
  messagesAroundRadii,
  normalizeRadiusSeconds,
  sliceMessagesAroundWindow,
  widenRadiusSeconds
} from '../../src/main/services/messages-around'

/**
 * 「跳到原聊天」的稳定身份。
 *
 * 只靠「会话 + 秒级时间戳」定位不到**这一条**消息：同一秒可能有多条，
 * 时间戳也只能定位到"附近"。messageRef 是唯一跨层可用的稳定身份，
 * 所以它的编解码必须与 Buffer / Node API 解耦（renderer 在 contextIsolation 下没有 Buffer）。
 */
describe('messageRef codec', () => {
  it('round-trips conversation and message identity', () => {
    const ref = encodeMessageRef('conversation-md5', '17078')
    expect(decodeMessageRef(ref)).toEqual({
      conversationId: 'conversation-md5',
      messageId: '17078'
    })
  })

  it('strips the synthetic local: prefix so both sides normalize to the same identity', () => {
    const ref = encodeMessageRef('conversation-md5', 'local:17078')
    expect(decodeMessageRef(ref)).toEqual({
      conversationId: 'conversation-md5',
      messageId: '17078'
    })
    // 两条不同的入参（带/不带前缀）必须归一到同一个身份。
    expect(encodeMessageRef('conversation-md5', '17078')).toBe(ref)
  })

  it('produces an opaque, URL-safe token that does not leak raw ids', () => {
    const ref = encodeMessageRef('conversation-md5', '17078')
    expect(ref).not.toContain('conversation-md5')
    expect(ref).not.toContain('17078')
    expect(ref).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(ref).not.toMatch(/[+/=]/)
  })

  it('returns null instead of throwing for garbage, tampered or empty references', () => {
    expect(decodeMessageRef('')).toBeNull()
    expect(decodeMessageRef('not-base64!!')).toBeNull()
    expect(decodeMessageRef(encodeMessageRef('conversation-md5', '17078') + 'x')).toBeNull()
    expect(decodeMessageRef(undefined)).toBeNull()
    expect(decodeMessageRef(42)).toBeNull()
    expect(decodeMessageRef({ c: 'a', m: 'b' })).toBeNull()
    // 合法 base64 但不是我们的结构。
    expect(decodeMessageRef(btoa('{"x":1}').replace(/=+$/, ''))).toBeNull()
  })

  it('rejects identities missing either half', () => {
    expect(normalizeMessageIdentity('', '17078')).toBeNull()
    expect(normalizeMessageIdentity('conversation-md5', '   ')).toBeNull()
    expect(normalizeMessageIdentity('conversation-md5', '17078')).toEqual({
      conversationId: 'conversation-md5',
      messageId: '17078'
    })
  })
})

/**
 * 锚点窗口规则：加载必须围绕这条消息，**不能**退化成整段历史。
 */
describe('messages around anchor window', () => {
  it('never plans an unbounded read when the anchor time is missing', () => {
    const base = normalizeRadiusSeconds(undefined)
    // 没有锚点 = 没有半径可试：调用方必须走「已打开会话但无法定位原消息」的降级文案。
    expect(messagesAroundRadii(undefined, base, widenRadiusSeconds(base))).toEqual([])
    expect(messagesAroundRadii(0, base, widenRadiusSeconds(base))).toEqual([])
    expect(messagesAroundRadii(-5, base, widenRadiusSeconds(base))).toEqual([])
  })

  it('tries the narrow window first, then one bounded widening', () => {
    const base = normalizeRadiusSeconds(undefined)
    const widened = widenRadiusSeconds(base)
    expect(messagesAroundRadii(1_785_900_000, base, widened)).toEqual([base, widened])
    // 放宽有上限：一次点击不许变成全库扫描。
    expect(widened).toBeLessThanOrEqual(3 * 24 * 3600)
    expect(widened).toBeGreaterThanOrEqual(base)
  })

  it('clamps the requested radius into a sane band', () => {
    expect(normalizeRadiusSeconds(1)).toBe(60)
    expect(normalizeRadiusSeconds(6 * 3600)).toBe(6 * 3600)
    expect(normalizeRadiusSeconds(365 * 24 * 3600)).toBe(24 * 3600)
  })

  it('caps the returned window so a huge conversation cannot flood the IPC payload', () => {
    const messages = Array.from({ length: 5000 }, (_, index) => ({ id: `local:${index}` }))
    const { window, index, truncated } = sliceMessagesAroundWindow(
      messages,
      'conversation-md5',
      '4999'
    )
    expect(truncated).toBe(true)
    expect(window).toHaveLength(MESSAGES_AROUND_MAX_WINDOW)
    // 目标落在被截断的部分之外 → 如实报告"没找到"，而不是伪装成找到。
    expect(index).toBe(-1)
  })

  it('locates the exact message by normalized identity, not by position', () => {
    const messages = [{ id: 'local:17076' }, { id: '17077' }, { id: 'local:17078' }]
    const { window, index, truncated } = sliceMessagesAroundWindow(
      messages,
      'conversation-md5',
      '17078'
    )
    expect(truncated).toBe(false)
    expect(index).toBe(2)
    expect(window[index]).toEqual({ id: 'local:17078' })
  })
})
