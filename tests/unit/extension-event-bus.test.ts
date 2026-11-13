import { describe, expect, it } from 'vitest'
import { ExtensionEventBus } from '../../src/main/extensions/extension-event-bus'
import type { ExtensionEventEnvelope } from '../../src/shared/extensions/events'
import type { ExtensionSubscriptions } from '../../src/shared/extensions/manifest'
import type { NormalizedIncomingMessage } from '../../src/main/services/message-listener-service'

function message(overrides: Partial<NormalizedIncomingMessage> = {}): NormalizedIncomingMessage {
  return {
    sessionId: 'fixture-room@chatroom',
    localId: '1001',
    serverId: '9001',
    createTime: 1_700_000_000,
    messageType: 1,
    isSelf: false,
    senderId: 'wxid_peer',
    senderNickname: '张三',
    content: '你好',
    isGroup: true,
    mentionTargets: [],
    ...overrides
  }
}

function subscriptions(overrides: Partial<ExtensionSubscriptions> = {}): ExtensionSubscriptions {
  return {
    messageTypes: ['text'],
    conversationIds: [],
    requireMentionMe: false,
    includeSelf: false,
    ...overrides
  }
}

describe('extension event bus', () => {
  it('为同一条消息生成稳定 eventId，并做跨扩展去重', () => {
    const first: ExtensionEventEnvelope[] = []
    const second: ExtensionEventEnvelope[] = []
    const bus = new ExtensionEventBus({
      listSubscribers: () => [
        {
          extensionId: 'com.example.a',
          subscriptions: subscriptions(),
          deliver: (e) => (first.push(e), true)
        },
        {
          extensionId: 'com.example.b',
          subscriptions: subscriptions(),
          deliver: (e) => (second.push(e), true)
        }
      ],
      getAccountId: () => 'wxid_self',
      getSelfUsernames: () => ['wxid_self']
    })
    bus.handleMessage(message())
    bus.handleMessage(message())
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
    expect(first[0].event.eventId).toMatch(/^message:[0-9a-f]{40}$/)
    expect(bus.stats().deduped).toBe(1)
  })

  it('按消息类型与会话范围过滤', () => {
    const delivered: ExtensionEventEnvelope[] = []
    const bus = new ExtensionEventBus({
      listSubscribers: () => [
        {
          extensionId: 'com.example.a',
          subscriptions: subscriptions({
            messageTypes: ['text'],
            conversationIds: ['other@chatroom']
          }),
          deliver: (e) => (delivered.push(e), true)
        }
      ],
      getAccountId: () => 'wxid_self',
      getSelfUsernames: () => ['wxid_self']
    })
    bus.handleMessage(message())
    bus.handleMessage(message({ localId: '1002', messageType: 3 }))
    expect(delivered).toHaveLength(0)
  })

  it('mentionsMe 只认真实 atuserlist 与自身 username 的交集', () => {
    const delivered: ExtensionEventEnvelope[] = []
    const bus = new ExtensionEventBus({
      listSubscribers: () => [
        {
          extensionId: 'com.example.a',
          subscriptions: subscriptions(),
          deliver: (e) => (delivered.push(e), true)
        }
      ],
      getAccountId: () => 'wxid_self',
      getSelfUsernames: () => ['wxid_self']
    })
    bus.handleMessage(message({ content: '@someone 你好', mentionTargets: ['wxid_other'] }))
    bus.handleMessage(
      message({ localId: '1002', content: '@张三 你好', mentionTargets: ['wxid_self'] })
    )
    expect(delivered[0].event.mentionsMe).toBe(false)
    expect(delivered[1].event.mentionsMe).toBe(true)
  })

  it('拿不到自身身份时绝不猜测 @我', () => {
    const delivered: ExtensionEventEnvelope[] = []
    const bus = new ExtensionEventBus({
      listSubscribers: () => [
        {
          extensionId: 'com.example.a',
          subscriptions: subscriptions(),
          deliver: (e) => (delivered.push(e), true)
        }
      ],
      getAccountId: () => '',
      getSelfUsernames: () => []
    })
    bus.handleMessage(message({ mentionTargets: ['wxid_fixture'] }))
    expect(delivered[0].event.mentionsMe).toBe(false)
  })

  it('默认不投递自己发送的消息', () => {
    const delivered: ExtensionEventEnvelope[] = []
    const bus = new ExtensionEventBus({
      listSubscribers: () => [
        {
          extensionId: 'com.example.a',
          subscriptions: subscriptions(),
          deliver: (e) => (delivered.push(e), true)
        }
      ],
      getAccountId: () => 'wxid_self',
      getSelfUsernames: () => ['wxid_self']
    })
    bus.handleMessage(message({ isSelf: true }))
    expect(delivered).toHaveLength(0)
  })

  it('账号切换后旧账号相同 localId 的消息会重新投递', () => {
    const delivered: ExtensionEventEnvelope[] = []
    const accountId = 'wxid_a'
    const bus = new ExtensionEventBus({
      listSubscribers: () => [
        {
          extensionId: 'com.example.a',
          subscriptions: subscriptions(),
          deliver: (e) => (delivered.push(e), true)
        }
      ],
      getAccountId: () => accountId,
      getSelfUsernames: () => ['wxid_self']
    })
    bus.handleMessage(message())
    bus.setAccountId('wxid_b')
    bus.handleMessage(message())
    expect(delivered).toHaveLength(2)
    expect(delivered[1].event.accountId).toBe('wxid_b')
  })

  it('扩展投递失败计入 dropped，不影响其它订阅者', () => {
    const delivered: ExtensionEventEnvelope[] = []
    const bus = new ExtensionEventBus({
      listSubscribers: () => [
        { extensionId: 'com.example.a', subscriptions: subscriptions(), deliver: () => false },
        {
          extensionId: 'com.example.b',
          subscriptions: subscriptions(),
          deliver: (e) => (delivered.push(e), true)
        }
      ],
      getAccountId: () => 'wxid_self',
      getSelfUsernames: () => []
    })
    bus.handleMessage(message())
    expect(delivered).toHaveLength(1)
    expect(bus.stats().dropped).toBe(1)
  })
})
