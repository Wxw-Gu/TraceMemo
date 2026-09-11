import { describe, expect, it } from 'vitest'
import type { Message } from '../../src/shared/types'
import { buildMessageGroups } from '../../src/renderer/src/components/chat/messageGrouping'
import {
  normalizeJumpMessageId,
  resolveMessageJumpTarget
} from '../../src/renderer/src/components/chat/messageJump'

const message = (id: string, createTime: number, content = id): Message =>
  ({
    id,
    from: 'user',
    type: '普通文本',
    datetime: '',
    content,
    isSender: false,
    createTime
  }) as Message

/**
 * 「跳转到原聊天」的定位契约。
 *
 * 必须**真的**落在那一条消息上，而不是"路由切过去了"。
 * 秒级时间戳在群聊里对应多条消息，所以精确 id 必须优先。
 */
describe('resolveMessageJumpTarget', () => {
  it('prefers the exact stable identity over the timestamp', () => {
    const messages = [
      message('m1', 1_700_000_000),
      message('m2', 1_700_000_000),
      message('m3', 1_700_000_000)
    ]
    const groups = buildMessageGroups(messages)

    // 三条消息同一秒：只有 id 能定位到正确的那一条。
    const target = resolveMessageJumpTarget(groups, 1_700_000_000, 'm3')
    expect(target).toMatchObject({ messageId: 'm3', exact: true })
  })

  it('normalizes the synthetic local: prefix on both sides', () => {
    // 归档侧存的是 `local:42`，证据侧的 messageRef 解出来是 `42` —— 必须视为同一条。
    const groups = buildMessageGroups([message('local:42', 1_700_000_000)])
    expect(normalizeJumpMessageId('local:42')).toBe('42')
    expect(resolveMessageJumpTarget(groups, undefined, '42')).toMatchObject({
      messageId: 'local:42',
      exact: true
    })
    // 反过来也一样（证据侧带前缀、归档侧不带）。
    const plain = buildMessageGroups([message('42', 1_700_000_000)])
    expect(resolveMessageJumpTarget(plain, undefined, 'local:42')).toMatchObject({
      messageId: '42',
      exact: true
    })
  })

  it('returns the archive-side id so the highlight comparison cannot silently mismatch', () => {
    const groups = buildMessageGroups([message('local:17078', 1_700_000_000)])
    const target = resolveMessageJumpTarget(groups, undefined, '17078')
    // 传进去的是归一化后的 `17078`，但返回的必须是归档侧真实出现的 `local:17078`：
    // MessageGroup 用 message.id 直接比对高亮。
    expect(target?.messageId).toBe('local:17078')
  })

  it('falls back to the first message at or after the timestamp for legacy evidence', () => {
    const groups = buildMessageGroups([
      message('old', 1_690_000_000),
      message('hit', 1_700_000_100),
      message('newer', 1_700_000_200)
    ])
    expect(resolveMessageJumpTarget(groups, 1_700_000_000, undefined)).toMatchObject({
      messageId: 'hit',
      exact: false
    })
  })

  it('reports nothing to jump to when the message no longer exists', () => {
    const groups = buildMessageGroups([message('m1', 1_700_000_000)])
    // 目标已被删除 / 清理，且时间戳晚于所有消息 → 调用方必须走诚实降级文案。
    expect(resolveMessageJumpTarget(groups, 1_900_000_000, 'gone')).toBeNull()
    expect(resolveMessageJumpTarget(groups, undefined, 'gone')).toBeNull()
    expect(resolveMessageJumpTarget(groups, null, null)).toBeNull()
  })

  it('still resolves by id when the evidence carries no usable timestamp', () => {
    const groups = buildMessageGroups([message('m1', 1_700_000_000), message('m2', 1_700_000_600)])
    // 没有 createTime 的证据在真实数据里确实存在（老缓存），不能因此放弃定位。
    expect(resolveMessageJumpTarget(groups, undefined, 'm1')).toMatchObject({
      messageId: 'm1',
      exact: true,
      groupIndex: 0
    })
  })
})
