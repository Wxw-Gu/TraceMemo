import * as chat from '../services/chat-service'
import type {
  ConversationMessageCountEntry,
  ConversationMessageCountSnapshot
} from '../../shared/conversation-message-count'
import { EMPTY_CONVERSATION_MESSAGE_COUNT } from '../../shared/conversation-message-count'

/** 成功结果的有效期。聊天记录会增长，缓存不能永久有效。 */
const CACHE_TTL_MS = 10 * 60 * 1000
/** 失败结果只短暂记住，避免每次打开下拉框都对同一批坏分片重试。 */
const FAILURE_TTL_MS = 60 * 1000
/** 同时在跑的 `COUNT(*)` 条数上限。 */
const MAX_CONCURRENT = 4
/** 合并推送的窗口，避免上千个会话逐条打 IPC。 */
const FLUSH_INTERVAL_MS = 80

/** 只读 COUNT(*)：为排序去加载正文正是 #75 的写法；失败返回 null，不是 0。 */
export class ConversationMessageCountService {
  private readonly cache = new Map<string, ConversationMessageCountEntry>()
  private readonly inFlight = new Set<string>()
  private readonly listeners = new Set<(entries: ConversationMessageCountEntry[]) => void>()
  private queue: string[] = []
  private active = 0
  private generation = 0
  private flushTimer: NodeJS.Timeout | null = null
  private readonly dirty = new Map<string, ConversationMessageCountEntry>()
  /** 统计按账号隔离：换账号后旧 md5 的条数一个都不能复用。 */
  private accountId = ''

  onCountsChange(listener: (entries: ConversationMessageCountEntry[]) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 立即返回快照（含缓存与「尚未统计」占位），并把未知项排进后台队列。 */
  read(conversationIds: string[]): ConversationMessageCountSnapshot {
    this.syncAccount()
    const entries = conversationIds.map((id) => this.cached(id))
    this.enqueue(conversationIds.filter((id) => entries.find((e) => e.conversationId === id)?.measuredAt === 0))
    return { entries }
  }

  /** 只读缓存，不触发统计。 */
  peek(conversationIds: string[]): ConversationMessageCountEntry[] {
    return conversationIds.map((id) => this.cached(id))
  }

  enqueue(conversationIds: string[]): void {
    this.syncAccount()
    for (const id of conversationIds) {
      if (!id || this.inFlight.has(id)) continue
      const cached = this.cache.get(id)
      if (cached && Date.now() - cached.measuredAt < this.ttl(cached)) continue
      this.inFlight.add(id)
      this.queue.push(id)
    }
    this.pump()
  }

  /** 停止推进并丢弃队列；已算出的结果保留（它们仍然有效）。 */
  cancel(): void {
    this.generation += 1
    this.queue = []
    this.inFlight.clear()
  }

  dispose(): void {
    this.cancel()
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    this.listeners.clear()
    this.dirty.clear()
    this.cache.clear()
  }

  private syncAccount(): void {
    const next = chat.isReady() ? chat.getSelfAccountInfo()?.wxid || '' : ''
    if (next === this.accountId) return
    this.accountId = next
    this.cancel()
    this.cache.clear()
    this.dirty.clear()
  }

  private ttl(entry: ConversationMessageCountEntry): number {
    return entry.count === null ? FAILURE_TTL_MS : CACHE_TTL_MS
  }

  private cached(conversationId: string): ConversationMessageCountEntry {
    const hit = this.cache.get(conversationId)
    if (hit && Date.now() - hit.measuredAt < this.ttl(hit)) return hit
    return { ...EMPTY_CONVERSATION_MESSAGE_COUNT, conversationId }
  }

  private pump(): void {
    while (this.active < MAX_CONCURRENT && this.queue.length) {
      const conversationId = this.queue.shift() as string
      const generation = this.generation
      this.active += 1
      void this.measure(conversationId)
        .then((result) => {
          if (generation !== this.generation) return
          this.publish({ conversationId, ...result, measuredAt: Date.now() })
        })
        .catch(() => {
          if (generation !== this.generation) return
          // 统计失败必须是「未知」：0 会让一个真有 57 万条的群排到最后并显示误导性数字。
          this.publish({ conversationId, count: null, approximate: false, measuredAt: Date.now() })
        })
        .finally(() => {
          this.inFlight.delete(conversationId)
          this.active -= 1
          this.pump()
        })
    }
  }

  private async measure(
    conversationId: string
  ): Promise<{ count: number | null; approximate: boolean }> {
    if (!chat.isReady()) return { count: null, approximate: false }
    const result = await chat.countConversationMessagesAsync(conversationId)
    return { count: result.count, approximate: result.approximate }
  }

  private publish(entry: ConversationMessageCountEntry): void {
    this.cache.set(entry.conversationId, entry)
    this.dirty.set(entry.conversationId, entry)
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      const batch = Array.from(this.dirty.values())
      this.dirty.clear()
      if (!batch.length) return
      for (const listener of this.listeners) listener(batch)
    }, FLUSH_INTERVAL_MS)
  }
}
