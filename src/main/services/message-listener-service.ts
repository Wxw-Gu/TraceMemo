import { decompress as zstdDecompress } from 'fzstd'
import type { Wcdb4Client, Wcdb4Message, Wcdb4MonitorEvent } from '../wcdb4-client'

/**
 * MessageListener —— 实时消息回读底座。
 *
 * **职责边界（刻意很窄）**：
 *
 * ```
 * WCDB native change
 *         ↓
 *      coalesce
 *         ↓
 *   bounded DB readback
 *         ↓
 *       dedup
 *         ↓
 *   NormalizedIncomingMessage   →  onMessage(callback)
 * ```
 *
 * **不负责**（这些属于下一层，本模块不许碰）：关键词匹配、@我业务判断、日报、
 * 自动回复、AI 调用、Agent 调度、发送消息。
 *
 * 设计约束：一次写入会触发**一连串** native event（十几条），
 * 所以**绝不能**一个事件触发一次业务动作。
 */

/** zstd 帧魔数（微信 `source` 列是 zstd 压缩）。 */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/**
 * coalesce 窗口。
 *
 * 实测同一批 native event 会**同时**到达（同一毫秒内十几个），所以只需要一个极短的
 * 合并窗口就能把它们收敛成一次回读。取 120ms：
 * - 足够吃掉同一批事件（实测事件间隔 < 5ms）；
 * - 相对「event → 可读」本身就有 ~1.2s 的落库延迟，这点等待**不构成额外延迟**；
 * - 与项目既有 `wcdb-change` 消费端的 350ms debounce 相比更短，不会叠加成明显卡顿。
 */
const DEFAULT_COALESCE_MS = 120

/** 回读窗口：只看最近这么久，绝不扫历史。 */
const DEFAULT_LOOKBACK_SEC = 30
/** 未来容忍（时钟漂移 + 秒级取整）。 */
const DEFAULT_LOOKAHEAD_SEC = 2
/** 单次回读条数上限。 */
const DEFAULT_READ_LIMIT = 50

/** dedup 条目存活时间：超过它就可以被淘汰（同一条消息不会在窗口外再被读到）。 */
const DEFAULT_DEDUP_TTL_MS = 5 * 60 * 1000
/** dedup 容量上限，防止长时间运行后无限增长。 */
const DEFAULT_DEDUP_MAX_ENTRIES = 5_000

/**
 * 规范化后的入站消息。
 *
 * 刻意**克制**：只包含 Trigger 后续真正需要的字段，不做「万能 Message DTO」。
 * 原始行（`raw`）、未解压的 Buffer、头像等一律不往外传。
 */
export interface NormalizedIncomingMessage {
  sessionId: string
  /** 会话内序号。**单独不保证跨 shard 唯一**，去重必须带上 sessionId。 */
  localId: string
  /** 服务器侧全局标识。**可能缺失**，所以只作强标识、不作必需字段。 */
  serverId?: string
  /**
   * Unix **epoch 秒** —— 与 WCDB `create_time` / `getMessages` 参数同口径。
   *
   * ⚠️ 本项目另有模块使用 epoch 毫秒。**换算只允许集中在本层**：
   * 凡是需要毫秒的消费者，自己明确 `/1000` 的**唯一**位置就是这里之后的调用点，
   * 不许在任意函数里散落 `* 1000` / `/ 1000`。
   */
  createTime: number
  messageType: number
  /** `mesDes === 0` 表示自己发送（字段语义与直觉相反）。 */
  isSelf: boolean
  senderId?: string
  senderNickname?: string
  content?: string
  /** **已解压**的 source XML；原始 zstd Buffer 不往外传。 */
  source?: string
  isGroup: boolean
  /**
   * 从 `source` 解析出的 @ 目标（**微信 username，不是昵称**）。
   *
   * 本轮只产出数据，**不做「是否 @ 我」的业务判断** —— 那需要与
   * `getMyUsernameCandidates()` 求交集，属于下一层。
   */
  mentionTargets: string[]
}

/** 监听统计（不含任何身份信息，可安全记录）。 */
export interface MessageListenerStats {
  /** 收到的 native change event 数。 */
  nativeEvents: number
  /** 被 coalesce 合并掉的事件数（未单独触发回读）。 */
  coalescedEvents: number
  /** 实际执行的回读次数。 */
  readbacks: number
  /** 通过 dedup 并投递出去的消息数。 */
  delivered: number
  /** 因 dedup 被丢弃的重复投递数。 */
  deduped: number
}

export interface MessageListenerOptions {
  coalesceMs?: number
  lookbackSec?: number
  lookaheadSec?: number
  readLimit?: number
  dedupTtlMs?: number
  dedupMaxEntries?: number
}

/**
 * 从 `source`（**已解压的 XML 文本**）提取 @ 目标。
 *
 * 纯函数：不依赖任何运行时状态，便于单测。
 *
 * 实测两种形式都真实存在，**都必须支持**：
 * ```xml
 * <atuserlist><![CDATA[SELF_USERNAME]]></atuserlist>
 * <atuserlist>SELF_USERNAME</atuserlist>
 * ```
 *
 * ⚠️ 三条硬规则：
 * 1. **CDATA 外壳必须剥掉**，否则拿到的是 `<![CDATA[xxx]]>` 字面量；
 * 2. **值就是微信 username，不保证以 `wxid_` 开头** —— 绝不能用前缀做过滤/校验；
 * 3. **不允许多人分隔符的猜测** —— 多人 @ 的格式尚未在真实样本中验证过，
 *    这里按「单个值原样返回」处理；一旦拿到真实多人样本需补解析与测试
 *    （当前形状已经预留为 `string[]`）。
 */
export function extractMentionTargets(source: string | undefined): string[] {
  const text = String(source ?? '')
  if (!text) return []
  const match = /<atuserlist>([\s\S]*?)<\/atuserlist>/i.exec(text)
  if (!match) return []
  const inner = match[1].trim()
  const unwrapped = inner.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim()
  return unwrapped ? [unwrapped] : []
}

/** 把 WCDB 的 `source` 列（zstd 压缩的 Buffer）还原成 XML 文本。 */
export function decodeSourcePayload(value: unknown): string | undefined {
  let buffer: Buffer | null = null
  if (Buffer.isBuffer(value)) {
    buffer = value
  } else {
    const candidate = value as { type?: string; data?: unknown } | null
    if (candidate?.type === 'Buffer' && Array.isArray(candidate.data)) {
      buffer = Buffer.from(candidate.data as number[])
    }
  }
  if (!buffer || buffer.length === 0) return undefined
  const isZstd = ZSTD_MAGIC.every((byte, index) => buffer![index] === byte)
  if (!isZstd) return buffer.toString('utf8')
  try {
    return Buffer.from(zstdDecompress(buffer)).toString('utf8')
  } catch {
    return undefined
  }
}

/**
 * 实时消息监听。
 *
 * ⚠️ **已知 BLOCKER（必须如实标注）**：
 * 本实现**无法从 native event 判断是哪个会话发生了变化** —— 事件 payload 只有
 * `{db, table, action}`（native 侧 `MonitorEvent` 结构就这两个字段）。
 * 因此当前策略是**回读「最近活跃会话」**（`sessions[0]`，按 `last_timestamp` 排序），
 * 这在「刚刚收到消息的会话」这一场景下成立，但：
 *
 * - **不是**「全局监听所有微信会话」；
 * - 若同一窗口内有**多个会话**同时来消息，只会回读到其中最近的那个；
 * - 正式扩展需要解决「如何从 table event 推断需要回读哪些会话」。
 *
 * 详见 `NEXT_STEPS` 注释与 Spike 报告。
 */
export class MessageListenerService {
  private readonly listeners = new Set<(message: NormalizedIncomingMessage) => void>()
  /**
   * dedup 缓存：`sessionId:localId` → 首次见到的时间戳。
   *
   * 必须有界 —— Spike 里用的是无上限 `Set`，长时间运行会持续吃内存。
   */
  private readonly seen = new Map<string, number>()
  /**
   * 本批 coalesce 窗口内**出现过精确会话**的事件收集到的 session 集合。
   *
   * v2 事件（Native Monitor Event v2）会带上发生变化的 sessionId，这里用 **Set** 收集 ——
   * 120ms 内收到 `A B A C B` 必须回读 A/B/C 三个，绝不能「最后一个 wins」。
   */
  private readonly pendingSessions = new Set<string>()
  private coalesceTimer: ReturnType<typeof setTimeout> | null = null
  private readbackInFlight = false
  private disposed = false

  private readonly coalesceMs: number
  private readonly lookbackSec: number
  private readonly lookaheadSec: number
  private readonly readLimit: number
  private readonly dedupTtlMs: number
  private readonly dedupMaxEntries: number

  private counters: MessageListenerStats = {
    nativeEvents: 0,
    coalescedEvents: 0,
    readbacks: 0,
    delivered: 0,
    deduped: 0
  }

  constructor(
    private readonly client: Wcdb4Client,
    options: MessageListenerOptions = {}
  ) {
    this.coalesceMs = options.coalesceMs ?? DEFAULT_COALESCE_MS
    this.lookbackSec = options.lookbackSec ?? DEFAULT_LOOKBACK_SEC
    this.lookaheadSec = options.lookaheadSec ?? DEFAULT_LOOKAHEAD_SEC
    this.readLimit = options.readLimit ?? DEFAULT_READ_LIMIT
    this.dedupTtlMs = options.dedupTtlMs ?? DEFAULT_DEDUP_TTL_MS
    this.dedupMaxEntries = options.dedupMaxEntries ?? DEFAULT_DEDUP_MAX_ENTRIES
  }

  /**
   * 订阅新消息。返回取消订阅函数。
   *
   * 刻意**只提供回调**：当前规模不需要 EventEmitter / RxJS / 内部队列。
   */
  onMessage(listener: (message: NormalizedIncomingMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  stats(): MessageListenerStats {
    return { ...this.counters }
  }

  dispose(): void {
    this.disposed = true
    if (this.coalesceTimer) {
      clearTimeout(this.coalesceTimer)
      this.coalesceTimer = null
    }
    this.listeners.clear()
    this.seen.clear()
  }

  /**
   * 接 native change event。
   *
   * 只做计数、收集会话与 coalesce —— **绝不**在这里回读，更不触发任何业务。
   *
   * `event.protocol === 2` 时把 `sessionId` 收进本批的集合；legacy 事件（v1，不带会话）
   * 走到回读时仍然只能退化成「最近活跃会话」。
   */
  handleNativeChange(event?: Wcdb4MonitorEvent): void {
    if (this.disposed) return
    this.counters.nativeEvents += 1
    if (event?.protocol === 2 && event.sessionId) {
      this.pendingSessions.add(event.sessionId)
    }
    if (this.coalesceTimer) {
      // 已经在同一个窗口里：直接合并掉，这就是 17:1 那个比值的收敛点。
      this.counters.coalescedEvents += 1
      return
    }
    this.coalesceTimer = setTimeout(() => {
      this.coalesceTimer = null
      void this.readback()
    }, this.coalesceMs)
  }

  /**
   * 有界回读 → normalize → dedup → 投递。
   *
   * 回读范围严格受限：**按会话** + **小时间窗口** + **条数上限**。不遍历会话、不扫全库。
   *
   * 目标会话的来源有两种：
   * - **precise（protocol v2）**：本批事件收集到的 `sessionId` 集合，逐个回读
   *   （多个会话同时来消息时，A/B/C 都会被读到）；
   * - **legacy（protocol v1，旧 runtime）**：只能退回「最近活跃会话」`getSessions()[0]`。
   */
  private async readback(): Promise<void> {
    if (this.disposed || this.readbackInFlight) return
    this.readbackInFlight = true
    const startedAt = Date.now()

    const preciseSessions = Array.from(this.pendingSessions)
    this.pendingSessions.clear()

    try {
      let delivered = 0
      let sessions = 0

      if (preciseSessions.length > 0) {
        for (const sessionId of preciseSessions) {
          if (this.disposed) return
          delivered += await this.readbackSession(sessionId)
          sessions += 1
        }
      } else {
        // legacy：旧 runtime 的 payload 不带会话，只能回读「最近活跃会话」。
        const session = this.client.getSessions()[0]
        if (!session?.username) return
        delivered = await this.readbackSession(session.username)
        sessions = 1
      }

      if (delivered > 0) {
        // 日志只记录协议版本、数量与耗时 —— **不含** wxid / 群名 / 昵称 / 正文 / source / sessionId。
        console.log(
          `[MessageListener] protocol=${preciseSessions.length > 0 ? 'v2' : 'v1'}` +
            ` sessions=${sessions} delivered=${delivered} readbackMs=${Date.now() - startedAt}` +
            ` events=${this.counters.nativeEvents} coalesced=${this.counters.coalescedEvents}`
        )
      }
    } catch (error) {
      console.warn(
        `[MessageListener] readback failed: ${error instanceof Error ? error.message : String(error)}`
      )
    } finally {
      this.readbackInFlight = false
    }
  }

  /** 回读**单个**会话并投递。返回本次真正投递出去的条数。 */
  private async readbackSession(sessionId: string): Promise<number> {
    const nowSec = Math.floor(Date.now() / 1000)
    this.counters.readbacks += 1
    const messages = await this.client.getMessagesAsync(
      sessionId,
      nowSec - this.lookbackSec,
      nowSec + this.lookaheadSec,
      { limit: this.readLimit }
    )
    if (this.disposed) return 0

    let delivered = 0
    for (const message of messages) {
      const normalized = this.normalize(sessionId, message)
      if (!normalized) continue
      // dedup：同一条消息可能在多个读回窗口中反复出现（native 事件本身也可能重复）。
      if (!this.markSeen(normalized)) {
        this.counters.deduped += 1
        continue
      }
      this.counters.delivered += 1
      delivered += 1
      this.deliver(normalized)
    }
    return delivered
  }

  private deliver(message: NormalizedIncomingMessage): void {
    for (const listener of this.listeners) {
      try {
        listener(message)
      } catch (error) {
        console.warn(
          `[MessageListener] listener threw: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
    }
  }

  /** 把 WCDB 行规范化为克制的 DTO。返回 null 表示这条行缺关键标识，无法投递。 */
  private normalize(
    sessionUsername: string,
    message: Wcdb4Message
  ): NormalizedIncomingMessage | null {
    const localId = message.mesLocalID === undefined ? '' : String(message.mesLocalID)
    if (!localId) return null

    const createTime = Number(message.msgCreateTime) || 0
    if (!createTime) return null

    const raw = (message.raw ?? {}) as Record<string, unknown>
    const source = decodeSourcePayload(raw.source)
    const senderId = message.sender ? String(message.sender) : undefined

    return {
      sessionId: sessionUsername,
      localId,
      serverId: message.serverId ? String(message.serverId) : undefined,
      createTime,
      messageType: Number(message.messageType) || 0,
      // `mesDes === 0` 是自己发送。不用昵称 / sender 文本 / content / username 前缀判断。
      isSelf: Number(message.mesDes) === 0,
      senderId,
      senderNickname: message.senderNickname ? String(message.senderNickname) : undefined,
      content: message.msgContent ? String(message.msgContent) : undefined,
      source,
      isGroup: sessionUsername.endsWith('@chatroom'),
      mentionTargets: extractMentionTargets(source)
    }
  }

  /** 登记并返回「是否是第一次见到」。同时做 TTL + 容量淘汰。 */
  private markSeen(message: NormalizedIncomingMessage): boolean {
    const key = `${message.sessionId}:${message.localId}`
    const now = Date.now()
    if (this.seen.has(key)) return false

    this.seen.set(key, now)
    if (this.seen.size > this.dedupMaxEntries) this.evict(now)
    return true
  }

  /**
   * 淘汰策略：先按 TTL 清理过期条目；若仍然超限，再按插入顺序丢掉最旧的一批
   * （Map 保持插入顺序，所以从头删就是删最旧）。
   */
  private evict(now: number): void {
    for (const [key, seenAt] of this.seen) {
      if (now - seenAt > this.dedupTtlMs) this.seen.delete(key)
    }
    if (this.seen.size <= this.dedupMaxEntries) return
    const overflow = this.seen.size - this.dedupMaxEntries
    let removed = 0
    for (const key of this.seen.keys()) {
      this.seen.delete(key)
      removed += 1
      if (removed >= overflow) break
    }
  }
}

/**
 * NEXT STEPS（不在本轮范围）
 *
 * 1. **会话定位（BLOCKER）**：目前只能回读「最近活跃会话」。要真正监听全部会话，
 *    需要解决「从 table event 推断变更会话」。可能的路线：
 *    - 观察 native 侧能否在事件里补上 table 所属的会话标识（需改 dll）；
 *    - 或改成按 `Session` 表的 `last_timestamp` 变化做「有界的多会话回读」。
 * 2. **多人 @**：`extractMentionTargets` 目前按单值返回，多人格式**未验证**，不得猜分隔符。
 * 3. **isMentionedMe**：`mentionTargets` ∩ `getMyUsernameCandidates()`，再接 Trigger。
 * 4. 本轮**不做**：关键词 / @触发 / 自动回复 / 日报 / AI / Agent / 发送。
 */
