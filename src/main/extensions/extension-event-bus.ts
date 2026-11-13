import { createHash } from 'node:crypto'
import type { ExtensionEventEnvelope } from '../../shared/extensions/events'
import {
  buildExtensionMessageEvent,
  EXTENSION_EVENT_PROTOCOL_VERSION,
  shouldDeliverExtensionEvent,
  type ExtensionMessageEvent
} from '../../shared/extensions/events'
import type { ExtensionSubscriptions } from '../../shared/extensions/manifest'
import type { NormalizedIncomingMessage } from '../services/message-listener-service'

const DEDUPE_TTL_MS = 10 * 60 * 1000
const DEDUPE_MAX_ENTRIES = 5_000

export interface ExtensionEventSubscriber {
  extensionId: string
  subscriptions: ExtensionSubscriptions | undefined
  deliver: (envelope: ExtensionEventEnvelope) => boolean
}

export interface ExtensionEventBusDependencies {
  listSubscribers: () => ExtensionEventSubscriber[]
  getAccountId: () => string
  getSelfUsernames: () => string[]
  now?: () => number
  onDelivered?: (extensionId: string, event: ExtensionMessageEvent) => void
}

export interface ExtensionEventBusStats {
  received: number
  deduped: number
  delivered: number
  dropped: number
}

/**
 * 把 MessageListener 的规范化消息分发给扩展。
 *
 * 去重键 `sessionId:localId`，扩展侧独立保留一层，避免进程重启后补投重复；
 * 旧 Runtime 只能回读最近活跃会话，能力诊断会如实标记降级。
 */
export class ExtensionEventBus {
  private readonly seen = new Map<string, number>()
  private readonly now: () => number
  private accountId = ''
  private counters: ExtensionEventBusStats = { received: 0, deduped: 0, delivered: 0, dropped: 0 }

  constructor(private readonly dependencies: ExtensionEventBusDependencies) {
    this.now = dependencies.now ?? (() => Date.now())
  }

  /** 切换账号时清空去重表：旧账号的 localId 不能在新账号下命中。 */
  setAccountId(accountId: string): void {
    const next = String(accountId || '').trim()
    if (next === this.accountId) return
    this.accountId = next
    this.seen.clear()
  }

  stats(): ExtensionEventBusStats {
    return { ...this.counters }
  }

  /** 入口**绝不抛**：它挂在 MessageListener 的投递循环上。 */
  handleMessage(message: NormalizedIncomingMessage): void {
    try {
      this.counters.received += 1
      const eventId = buildEventId(message.sessionId, message.localId)
      if (!this.markSeen(eventId)) {
        this.counters.deduped += 1
        return
      }
      const selfUsernames = new Set(this.dependencies.getSelfUsernames())
      const event = buildExtensionMessageEvent({
        eventId,
        accountId: this.accountId,
        conversationId: message.sessionId,
        messageId: message.serverId || message.localId,
        ...(message.senderId ? { senderId: message.senderId } : {}),
        ...(message.senderNickname ? { senderName: message.senderNickname } : {}),
        isGroup: message.isGroup,
        isSelf: message.isSelf,
        messageType: message.messageType,
        ...(message.content !== undefined ? { content: message.content } : {}),
        // 只有 source 里真实出现当前账号 username 才算 @我；拿不到自身身份时一律 false。
        mentionsMe: message.mentionTargets.some((target) => selfUsernames.has(target)),
        createTimeSeconds: message.createTime
      })
      const envelope: ExtensionEventEnvelope = {
        version: EXTENSION_EVENT_PROTOCOL_VERSION,
        kind: 'message.received',
        event
      }
      for (const subscriber of this.dependencies.listSubscribers()) {
        if (!shouldDeliverExtensionEvent(subscriber.subscriptions, event)) continue
        if (subscriber.deliver(envelope)) {
          this.counters.delivered += 1
          this.dependencies.onDelivered?.(subscriber.extensionId, event)
        } else {
          this.counters.dropped += 1
        }
      }
    } catch (error) {
      console.warn(
        `[ExtensionEventBus] dispatch failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  private markSeen(eventId: string): boolean {
    const now = this.now()
    if (this.seen.has(eventId)) return false
    this.seen.set(eventId, now)
    if (this.seen.size > DEDUPE_MAX_ENTRIES) {
      for (const [key, at] of this.seen) {
        if (now - at > DEDUPE_TTL_MS) this.seen.delete(key)
      }
      if (this.seen.size > DEDUPE_MAX_ENTRIES) {
        const overflow = this.seen.size - DEDUPE_MAX_ENTRIES
        let removed = 0
        for (const key of this.seen.keys()) {
          this.seen.delete(key)
          removed += 1
          if (removed >= overflow) break
        }
      }
    }
    return true
  }
}

export function buildEventId(sessionId: string, localId: string): string {
  const digest = createHash('sha1').update(`${sessionId}\u0001${localId}`).digest('hex')
  return `message:${digest}`
}
