import { createHash, randomUUID } from 'node:crypto'
import { encodeMessageRef } from '../../shared/local-query-api'
import {
  normalizeIncomingMessage,
  type NormalizedIncomingMessage
} from './message-listener-service'
import type { Wcdb4Message } from '../wcdb4-client'

/**
 * MessageEventBroker —— 实时消息事件的唯一分发层。
 *
 * ```text
 * MessageListenerService.onMessage
 *        ↓  NormalizedIncomingMessage
 *    MessageEventBroker
 *        ├─ 事件 ID / 规范化 / 有界环形缓冲 / 每订阅者游标
 *        ├─ 已产生事件的重放（replay）
 *        └─ 数据库消息回补（db_backfill，独立标记）
 * ```
 *
 * **刻意不做的事**：不监听数据库（监听只有 `MessageListenerService` 一套）、
 * 不触发自动化、不调用 AI、不发送微信消息。本模块只负责「把已经产生的事件可靠地交出去」。
 *
 * **两类补偿必须可区分**：
 * - `replay`：事件曾经真实产生过，仍在本进程的环形缓冲里；
 * - `db_backfill`：缓冲已经覆盖不到，只能从数据库按时间窗重读。它可能包含
 *   从未产生过事件的普通消息，也可能因为窗口/条数上限而不完整。
 *
 * **单位契约**：`timestamp` 是 epoch **秒**（与 WCDB `create_time`、`getMessagesAsync` 一致）；
 * 缓冲 TTL / 去重 TTL 是毫秒。跨这条边界只允许在本文件里换算一次。
 */

/** 单条事件的文本上限。超出时显式标记 `textTruncated`，不静默截断。 */
const DEFAULT_MAX_TEXT_CHARS = 4000
/** 环形缓冲默认容量（条）。 */
const DEFAULT_BUFFER_SIZE = 500
/** 环形缓冲默认存活时间（毫秒）。 */
const DEFAULT_BUFFER_TTL_MS = 5 * 60 * 1000
/** 发布去重表默认存活时间（毫秒）。 */
const DEFAULT_SEEN_TTL_MS = 10 * 60 * 1000
/** 发布去重表默认容量。 */
const DEFAULT_SEEN_MAX_ENTRIES = 5000
/** 单订阅者「已投递 ID」记忆容量，用于避免回补与实时重叠时重复投递。 */
const DEFAULT_SUBSCRIBER_SEEN_MAX = 2000
/** 数据库回补的时间窗默认值（秒）。 */
const DEFAULT_BACKFILL_LOOKBACK_SEC = 300
/** 单会话回补条数默认上限。 */
const DEFAULT_BACKFILL_LIMIT = 100
/** 单次回补最多涉及的会话数。 */
const DEFAULT_BACKFILL_MAX_CONVERSATIONS = 20
/** 单个进程允许的并发 SSE 订阅数。 */
const DEFAULT_MAX_SUBSCRIBERS = 32

export type MessageEventOrigin = 'live' | 'replay' | 'db_backfill'

export interface MessageEventRecord {
  /** 确定性 ID：同一会话 + 同一条消息永远得到同一个值（跨进程稳定）。 */
  id: string
  /** 进程内单调序号，用于 SSE `Last-Event-ID` 的缓冲定位。 */
  seq: number
  /** **会话 md5**，与 `messageRef` 的 `c` 字段同口径（不是微信 username）。 */
  conversationId: string
  messageRef: string
  /** epoch 秒。 */
  timestamp: number
  messageType: number
  isSelf: boolean
  isGroup: boolean
  senderId?: string
  senderNickname?: string
  text?: string
  textTruncated?: boolean
  mentionTargets: string[]
}

export interface MessageBrokerStatus {
  database: 'ready' | 'unavailable'
  subscribers: number
  buffered: number
  oldestSeq: number | null
  newestSeq: number | null
}

export interface MessageGap {
  reason: 'buffer_overflow' | 'invalid_cursor' | 'cursor_from_previous_process'
  requestedLastEventId: string
  oldestSeq: number | null
  newestSeq: number | null
  /** 是否触发了数据库回补。为 false 时必须让客户端知道这段空档没有补齐。 */
  backfill:
    | 'scheduled'
    | 'skipped_no_conversation_filter'
    | 'skipped_database_unavailable'
    | 'skipped_no_reader'
    | 'disabled'
}

export interface MessageEventSink {
  onStatus(status: MessageBrokerStatus & { subscriptionId: string }): void
  onEvent(event: MessageEventRecord, origin: MessageEventOrigin): void
  onGap(gap: MessageGap): void
}

export interface MessageSubscribeOptions {
  /** 会话 md5 白名单；空/省略 = 全部会话（此时无法做有界回补）。 */
  conversationIds?: string[]
  /** 上一次收到的 SSE id（`Last-Event-ID`）。 */
  lastEventId?: string
  /** 是否允许在缓冲覆盖不到时从数据库回补。默认 true。 */
  backfill?: boolean
}

export interface MessageSubscription {
  readonly id: string
  /** 该订阅已经投递到的最新序号（诊断用）。 */
  readonly lastDeliveredSeq: number
  close(): void
}

export interface MessageEventBrokerOptions {
  /**
   * username → 会话 md5。
   *
   * 事件必须携带与 `encodeMessageRef()` 同口径的 conversationId（md5），
   * 否则 `/query/message-context` 无法反查会话。返回 undefined 表示当前无法映射，
   * 该消息会被计入 `unmapped` 并**不投递**（避免发出不可用的 messageRef）。
   */
  resolveConversationId: (sessionId: string) => string | undefined
  /** 数据库当前是否可用。用于 status 事件，不做连接管理。 */
  isDatabaseReady?: () => boolean
  /** 回补读取器。参数与 `getMessagesAsync(usernameOrMd5, startSec, endSec, {limit})` 一致。 */
  readMessages?: (
    sessionIdOrMd5: string,
    startTimeSec: number,
    endTimeSec: number,
    limit: number
  ) => Promise<Wcdb4Message[]>
  /** md5 → username，仅回补时用于还原 `isGroup` 与 sender 语义。 */
  resolveSessionId?: (conversationId: string) => string | undefined
  bufferSize?: number
  bufferTtlMs?: number
  seenTtlMs?: number
  seenMaxEntries?: number
  backfillLookbackSec?: number
  backfillLimit?: number
  backfillMaxConversations?: number
  maxSubscribers?: number
  maxTextChars?: number
  now?: () => number
}

interface SubscriberState {
  id: string
  conversationIds: Set<string> | null
  sink: MessageEventSink
  deliveredIds: Map<string, number>
  lastDeliveredSeq: number
  delivered: number
  closed: boolean
  backfillEnabled: boolean
}

export class MessageEventBroker {
  private readonly subscribers = new Map<string, SubscriberState>()
  private buffer: MessageEventRecord[] = []
  /** 事件 ID → 序号。只保留仍在缓冲里的条目。 */
  private readonly index = new Map<string, number>()
  private nextSeq = 1
  private disposed = false

  private readonly seen = new Map<string, number>()
  private readonly bufferSize: number
  private readonly bufferTtlMs: number
  private readonly seenTtlMs: number
  private readonly seenMaxEntries: number
  private readonly backfillLookbackSec: number
  private readonly backfillLimit: number
  private readonly backfillMaxConversations: number
  private readonly maxSubscribers: number
  private readonly maxTextChars: number
  private readonly now: () => number

  private counters = {
    published: 0,
    duplicates: 0,
    unmapped: 0,
    backfilled: 0,
    gaps: 0,
    rejected: 0
  }

  constructor(private readonly options: MessageEventBrokerOptions) {
    this.bufferSize = Math.max(1, options.bufferSize ?? DEFAULT_BUFFER_SIZE)
    this.bufferTtlMs = Math.max(1000, options.bufferTtlMs ?? DEFAULT_BUFFER_TTL_MS)
    this.seenTtlMs = Math.max(1000, options.seenTtlMs ?? DEFAULT_SEEN_TTL_MS)
    this.seenMaxEntries = Math.max(1, options.seenMaxEntries ?? DEFAULT_SEEN_MAX_ENTRIES)
    this.backfillLookbackSec = Math.max(
      1,
      options.backfillLookbackSec ?? DEFAULT_BACKFILL_LOOKBACK_SEC
    )
    this.backfillLimit = Math.max(1, options.backfillLimit ?? DEFAULT_BACKFILL_LIMIT)
    this.backfillMaxConversations = Math.max(
      1,
      options.backfillMaxConversations ?? DEFAULT_BACKFILL_MAX_CONVERSATIONS
    )
    this.maxSubscribers = Math.max(1, options.maxSubscribers ?? DEFAULT_MAX_SUBSCRIBERS)
    this.maxTextChars = Math.max(64, options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS)
    this.now = options.now ?? Date.now
  }

  /**
   * 发布一条已经由 MessageListener 回读并规范化的消息。
   *
   * 返回 null 表示消息无法形成可用事件（会话未映射 / messageRef 构造失败），
   * 或命中去重表（同一条消息被重复回读）。
   */
  publish(message: NormalizedIncomingMessage): MessageEventRecord | null {
    if (this.disposed) return null
    const record = this.toRecord(message)
    if (!record) return null

    this.evictSeen(this.now())
    if (this.seen.has(record.id)) {
      this.counters.duplicates += 1
      return null
    }

    this.seen.set(record.id, this.now())
    this.trimSeen()

    record.seq = this.nextSeq
    this.nextSeq += 1

    this.buffer.push(record)
    this.index.set(record.id, record.seq)
    this.trimBuffer()

    this.counters.published += 1
    this.deliverLive(record)
    return record
  }

  /**
   * 订阅消息事件。
   *
   * 订阅会立刻收到一条 `status`；随后按 `lastEventId` 决定重放还是回补。
   * 返回的句柄必须由调用方在连接关闭时 `close()`，否则会占用订阅配额。
   */
  subscribe(options: MessageSubscribeOptions, sink: MessageEventSink): MessageSubscription {
    if (this.subscribers.size >= this.maxSubscribers) {
      throw new Error('消息事件订阅数已达上限')
    }

    const state: SubscriberState = {
      id: randomUUID(),
      conversationIds:
        options.conversationIds && options.conversationIds.length > 0
          ? new Set(options.conversationIds)
          : null,
      sink,
      deliveredIds: new Map(),
      lastDeliveredSeq: 0,
      delivered: 0,
      closed: false,
      backfillEnabled: options.backfill !== false
    }
    this.subscribers.set(state.id, state)
    sink.onStatus({ ...this.status(), subscriptionId: state.id })
    void this.resume(state, options.lastEventId)

    return {
      id: state.id,
      get lastDeliveredSeq(): number {
        return state.lastDeliveredSeq
      },
      close: () => {
        state.closed = true
        this.subscribers.delete(state.id)
      }
    }
  }

  status(): MessageBrokerStatus {
    return {
      database: this.options.isDatabaseReady?.() === false ? 'unavailable' : 'ready',
      subscribers: this.subscribers.size,
      buffered: this.buffer.length,
      oldestSeq: this.buffer[0]?.seq ?? null,
      newestSeq: this.buffer[this.buffer.length - 1]?.seq ?? null
    }
  }

  stats(): typeof this.counters & MessageBrokerStatus {
    return { ...this.counters, ...this.status() }
  }

  dispose(): void {
    this.disposed = true
    for (const state of this.subscribers.values()) state.closed = true
    this.subscribers.clear()
    this.buffer = []
    this.index.clear()
    this.seen.clear()
  }

  private async resume(state: SubscriberState, lastEventId?: string): Promise<void> {
    const raw = typeof lastEventId === 'string' ? lastEventId.trim() : ''
    // 没带游标 = 首次订阅，只接实时事件，不需要 gap。
    if (!raw) return
    if (state.closed) return

    const oldest = this.buffer[0]?.seq ?? null
    const newest = this.buffer[this.buffer.length - 1]?.seq ?? null
    /** 本进程已经分配出去的最大序号（含未进缓冲的回补事件）。 */
    const maxAssigned = this.nextSeq - 1

    const lastSeq = parseLastEventId(raw)
    /*
     * 带了游标但解析不了：不能当成「首次订阅」静默跳过 ——
     * 那等于把客户端明确声明的断点吞掉。
     */
    if (lastSeq === null) {
      await this.emitGap(state, raw, 'invalid_cursor', oldest, newest)
      return
    }

    /*
     * 序号只在**本进程内**单调。客户端如果拿着上一个进程的游标（重启后
     * 序号会从 1 重新开始），它可能大于本进程已分配的任何序号 —— 这时
     * 既不能当成「已经收到最新」，也不能假装能重放，只能走 gap。
     */
    if (lastSeq > maxAssigned) {
      await this.emitGap(state, raw, 'cursor_from_previous_process', oldest, newest)
      return
    }

    /*
     * 只有「游标落在缓冲区间内」或「游标正好是本进程最后一个被淘汰的序号」
     * 才能保证重放完整。`lastSeq < oldest - 1` 说明中间已经有事件被淘汰，
     * 必须显式报 gap，不能假装重放是连续的。
     */
    if (oldest !== null && lastSeq >= oldest - 1) {
      for (const event of this.buffer) {
        if (state.closed) return
        if (event.seq <= lastSeq) continue
        this.deliver(state, event, 'replay')
      }
      return
    }

    /*
     * 缓冲为空但有本进程分配过的序号：可能只发生过回补事件（不进缓冲），
     * 也可能事件已按 TTL 全部淘汰。前者没有漏消息，后者必须报 gap。
     */
    if (oldest === null && lastSeq === maxAssigned) return

    await this.emitGap(state, raw, 'buffer_overflow', oldest, newest)
  }

  private async emitGap(
    state: SubscriberState,
    lastEventId: string,
    reason: MessageGap['reason'],
    oldest: number | null,
    newest: number | null
  ): Promise<void> {
    this.counters.gaps += 1
    /*
     * 先发 gap，再回补。反过来会让客户端先收到一批「来源不明」的消息，
     * 然后才被告知中间有断档 —— 顺序本身就是语义的一部分。
     */
    const plan = this.backfillPlan(state)
    state.sink.onGap({
      reason,
      requestedLastEventId: String(lastEventId),
      oldestSeq: oldest,
      newestSeq: newest,
      backfill: plan
    })
    if (plan === 'scheduled') await this.runBackfill(state)
  }

  /**
   * 有界数据库回补的前置判定。
   *
   * 边界（全部不可协商）：
   * - 只回补订阅时显式指定的会话；「全部会话」无法做有界回补；
   * - 时间窗 ≤ `backfillLookbackSec`，单会话 ≤ `backfillLimit` 条；
   * - 会话数 ≤ `backfillMaxConversations`；
   * - 数据库不可用 / 没有读取器时明确跳过，不伪造事件。
   */
  private backfillPlan(state: SubscriberState): MessageGap['backfill'] {
    if (!state.backfillEnabled) return 'disabled'
    if (!state.conversationIds || state.conversationIds.size === 0) {
      return 'skipped_no_conversation_filter'
    }
    if (!this.options.readMessages) return 'skipped_no_reader'
    if (this.options.isDatabaseReady?.() === false) return 'skipped_database_unavailable'
    return 'scheduled'
  }

  /** 执行已经通过 `backfillPlan` 判定的回补。 */
  private async runBackfill(state: SubscriberState): Promise<void> {
    if (!state.conversationIds || !this.options.readMessages) return

    const nowMs = this.now()
    const endSec = Math.floor(nowMs / 1000)
    const startSec = endSec - this.backfillLookbackSec
    const conversations = Array.from(state.conversationIds).slice(0, this.backfillMaxConversations)

    for (const conversationId of conversations) {
      if (state.closed) return
      const sessionId = this.options.resolveSessionId?.(conversationId) ?? conversationId
      let rows: Wcdb4Message[]
      try {
        rows = await this.options.readMessages(sessionId, startSec, endSec, this.backfillLimit)
      } catch (error) {
        console.warn(
          `[MessageEventBroker] backfill read failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
        continue
      }
      for (const row of rows) {
        if (state.closed) return
        const normalized = normalizeIncomingMessage(sessionId, row)
        if (!normalized) continue
        const record = this.toRecord(normalized)
        if (!record) continue
        // 回补事件不进入环形缓冲：它是补偿，不是「本进程产生过」的事实。
        record.seq = this.nextSeq
        this.nextSeq += 1
        this.counters.backfilled += 1
        this.deliver(state, record, 'db_backfill')
      }
    }
  }

  private deliverLive(record: MessageEventRecord): void {
    for (const state of this.subscribers.values()) {
      if (state.closed) continue
      if (state.conversationIds && !state.conversationIds.has(record.conversationId)) continue
      this.deliver(state, record, 'live')
    }
  }

  private deliver(
    state: SubscriberState,
    record: MessageEventRecord,
    origin: MessageEventOrigin
  ): void {
    if (state.closed) return
    if (state.conversationIds && !state.conversationIds.has(record.conversationId)) return
    if (state.deliveredIds.has(record.id)) return

    state.deliveredIds.set(record.id, this.now())
    this.trimSubscriberSeen(state)
    state.lastDeliveredSeq = record.seq
    state.delivered += 1
    try {
      state.sink.onEvent(record, origin)
    } catch (error) {
      console.warn(
        `[MessageEventBroker] subscriber sink threw: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }

  private toRecord(message: NormalizedIncomingMessage): MessageEventRecord | null {
    const conversationId = this.options.resolveConversationId(message.sessionId)
    if (!conversationId) {
      this.counters.unmapped += 1
      return null
    }
    let messageRef: string
    try {
      messageRef = encodeMessageRef(conversationId, message.localId)
    } catch (error) {
      this.counters.rejected += 1
      console.warn(
        `[MessageEventBroker] messageRef rejected: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
      return null
    }

    const rawText = message.content ?? ''
    const truncated = rawText.length > this.maxTextChars
    return {
      id: eventIdFor(conversationId, message.localId),
      seq: 0,
      conversationId,
      messageRef,
      timestamp: message.createTime,
      messageType: message.messageType,
      isSelf: message.isSelf,
      isGroup: message.isGroup,
      ...(message.senderId ? { senderId: message.senderId } : {}),
      ...(message.senderNickname ? { senderNickname: message.senderNickname } : {}),
      ...(rawText ? { text: truncated ? rawText.slice(0, this.maxTextChars) : rawText } : {}),
      ...(truncated ? { textTruncated: true } : {}),
      mentionTargets: message.mentionTargets
    }
  }

  private trimBuffer(): void {
    const cutoff = this.now() - this.bufferTtlMs
    while (this.buffer.length > 0) {
      const oldest = this.buffer[0]
      const expired = oldest.timestamp * 1000 < cutoff
      if (this.buffer.length <= this.bufferSize && !expired) break
      this.buffer.shift()
      if (this.index.get(oldest.id) === oldest.seq) this.index.delete(oldest.id)
    }
  }

  private evictSeen(now: number): void {
    for (const [id, seenAt] of this.seen) {
      if (now - seenAt <= this.seenTtlMs) break
      this.seen.delete(id)
    }
  }

  private trimSeen(): void {
    if (this.seen.size <= this.seenMaxEntries) return
    const overflow = this.seen.size - this.seenMaxEntries
    let removed = 0
    for (const id of this.seen.keys()) {
      this.seen.delete(id)
      removed += 1
      if (removed >= overflow) break
    }
  }

  private trimSubscriberSeen(state: SubscriberState): void {
    if (state.deliveredIds.size <= DEFAULT_SUBSCRIBER_SEEN_MAX) return
    const overflow = state.deliveredIds.size - DEFAULT_SUBSCRIBER_SEEN_MAX
    let removed = 0
    for (const id of state.deliveredIds.keys()) {
      state.deliveredIds.delete(id)
      removed += 1
      if (removed >= overflow) break
    }
  }
}

/** 同一会话 + 同一条消息的确定性事件 ID。 */
export function eventIdFor(conversationId: string, localId: string): string {
  return `evt_${createHash('sha256')
    .update(`${conversationId}\u0000${localId}`, 'utf8')
    .digest('hex')
    .slice(0, 24)}`
}

/**
 * 解析 SSE `Last-Event-ID`。
 *
 * 只接受纯数字序号；其它形态（含上一版本客户端可能发来的任意字符串）
 * 一律当成「没有游标」而不是猜一个位置 —— 猜错会导致静默漏消息。
 */
export function parseLastEventId(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const trimmed = value.trim()
  if (!/^\d{1,15}$/.test(trimmed)) return null
  const parsed = Number(trimmed)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}
