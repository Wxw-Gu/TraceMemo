import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WechatInboundInbox } from '../../src/main/services/wechat-inbound-inbox'
import type { WechatInboundMessage } from '../../src/main/services/wechat-ilink/types'

function inbound(messageId: string, text = 'hello'): WechatInboundMessage {
  return {
    accountId: 'bot-1',
    fromUserId: 'user@im.wechat',
    messageId,
    messageType: 1,
    contextToken: `ctx-${messageId}`,
    items: [{ type: 1, text }],
    receivedAt: 1_700_000_000_000
  }
}

describe('WechatInboundInbox', () => {
  const roots: string[] = []

  afterEach(() => {
    while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
  })

  function createInbox(options: { maxAttempts?: number } = {}): {
    inbox: WechatInboundInbox
    filePath: string
    root: string
  } {
    const root = mkdtempSync(join(tmpdir(), 'tracememo-inbox-'))
    roots.push(root)
    const filePath = join(root, 'agent-hub', 'inbound-inbox.json')
    const inbox = new WechatInboundInbox({
      filePath: () => filePath,
      ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {})
    })
    return { inbox, filePath, root }
  }

  it('接收即落盘，并保留 context_token 供后续回复使用', () => {
    const { inbox, filePath } = createInbox()
    const accepted = inbox.accept([inbound('1'), inbound('2')])

    expect(accepted.map((entry) => entry.messageId)).toEqual(['1', '2'])
    expect(accepted[0].contextToken).toBe('ctx-1')
    expect(statSync(filePath).mode & 0o777).toBe(0o600)
    expect(inbox.size()).toBe(2)
  })

  it('重复投递同一 message_id 时不会重复接收', () => {
    const { inbox } = createInbox()
    inbox.accept([inbound('1')])

    expect(inbox.accept([inbound('1')])).toEqual([])
    expect(inbox.size()).toBe(1)
  })

  it('重新实例化后仍能读到未处理的消息（崩溃恢复）', () => {
    const { inbox, filePath } = createInbox()
    inbox.accept([inbound('7')])

    const reopened = new WechatInboundInbox({ filePath: () => filePath })
    expect(reopened.pending().map((entry) => entry.messageId)).toEqual(['7'])
  })

  it('处理成功后从收件箱移除', () => {
    const { inbox } = createInbox()
    const [entry] = inbox.accept([inbound('1')])

    inbox.complete(entry.key)

    expect(inbox.size()).toBe(0)
    expect(inbox.contains(entry.key)).toBe(false)
  })

  it('失败累加尝试次数，达到上限后放弃但可被上层观测', () => {
    const { inbox } = createInbox({ maxAttempts: 2 })
    const [entry] = inbox.accept([inbound('1')])

    expect(inbox.recordFailure(entry.key)).toEqual({ attempts: 1, abandoned: false })
    expect(inbox.contains(entry.key)).toBe(true)

    expect(inbox.recordFailure(entry.key)).toEqual({ attempts: 2, abandoned: true })
    expect(inbox.contains(entry.key)).toBe(false)
  })

  it('没有 message_id 时使用回退键，仍然可追踪', () => {
    const { inbox } = createInbox()
    const message = { ...inbound(''), messageId: '' }
    const [entry] = inbox.accept([message])

    expect(entry.key).toContain('bot-1::user@im.wechat::')
    expect(inbox.pending()).toHaveLength(1)
  })

  it('落盘失败时向上抛错，调用方据此放弃推进游标', () => {
    const root = mkdtempSync(join(tmpdir(), 'tracememo-inbox-fail-'))
    roots.push(root)
    const asDirectory = join(root, 'blocked.json')
    mkdirSync(asDirectory, { recursive: true })

    const inbox = new WechatInboundInbox({ filePath: () => asDirectory })
    expect(() => inbox.accept([inbound('1')])).toThrow()
  })

  it('落盘内容包含聊天文本，但仅限 userData 下的 0600 文件', () => {
    const { inbox, filePath } = createInbox()
    inbox.accept([inbound('1', '机密内容')])

    const raw = readFileSync(filePath, 'utf8')
    expect(raw).toContain('机密内容')
    expect(statSync(filePath).mode & 0o777).toBe(0o600)
  })
})
