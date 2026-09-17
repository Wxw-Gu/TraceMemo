import { monitorEventLoopDelay } from 'perf_hooks'
import * as chat from '../services/chat-service'
import type {
  KnowledgeImageOcrState,
  KnowledgeAttachmentMetadata,
  KnowledgeEvidence,
  KnowledgeMessageKind,
  KnowledgePassProgress,
  KnowledgeRuntimeState,
  KnowledgeRuntimeStatus,
  KnowledgeSearchRequest,
  KnowledgeSearchIpcRequest,
  KnowledgeSearchIpcResult,
  KnowledgeSearchResult,
  KnowledgeSourceMessage
} from '../../shared/knowledge'
import type {
  VoiceMessageReference,
  VoiceTranscriptSnapshot,
  VoiceTranscriptUpdate
} from '../../shared/voice-recognition'
import {
  DEFAULT_KNOWLEDGE_CHUNKER,
  DEFAULT_KNOWLEDGE_FTS_CONFIG,
  emptyKnowledgeSearchTimings
} from '../../shared/knowledge'
import { KnowledgeService } from './knowledge-service'
import { sourceMessageId } from './message-identity'
import {
  voiceAccountIdentity,
  voiceMessageIdentity
} from '../voice-pipeline/voice-message-identity'

const FALLBACK_LIMIT = 240
const MAX_SENDER_NAME_CONVERSATIONS = 8
const MAX_CONVERSATION_FILTERS_PER_WORKER_SEARCH = 700
const MAX_SENDER_ENRICHMENT_SESSIONS = 32
const SENDER_ENRICHMENT_SESSION_TTL_MS = 5 * 60 * 1000

/**
 * 增量读取时向前回看的 overlap（epoch ms）。
 *
 * delta 下界 = `checkpoint - DELTA_OVERLAP_MS`，用来吸收 timestamp 边界碰撞。
 * 它必须远大于 chunker 的 `maxGapMs`，否则跨越下界的 chunk 会缺前半段消息、重建时丢前文。
 *
 * ⚠️ 单位：这里是**毫秒**（checkpoint 本身是毫秒）。传给 WCDB 读取层之前必须换成
 * epoch **秒**（`chat.listMessagesAsync` 的 start/end 是秒）。混用会让 delta 读恒为空，
 * 且**不会报错**。
 */
const DELTA_OVERLAP_MS = 24 * 60 * 60 * 1000

/**
 * event-loop 滞后采样的分辨率（ms）。
 *
 * 用 `monitorEventLoopDelay` 的 histogram 而不是手写 setInterval：后者只能以 interval
 * 为粒度发现 stall，给不出分位数。
 */
const LAG_PROBE_RESOLUTION_MS = 10

/** histogram 的纳秒读数转毫秒。 */
function roundMs(nanoseconds: number): number {
  if (!Number.isFinite(nanoseconds) || nanoseconds <= 0) return 0
  return Math.round(nanoseconds / 1e6)
}

/** WCDB 读取通道：`interactive` = 交互查询，`background` = 后台索引 pass。 */
type WcdbReadLane = 'interactive' | 'background'

type PendingWcdbRead = {
  high: boolean
  run: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

type PendingVoiceTranscriptIndex = {
  update: VoiceTranscriptUpdate
  waiters: Array<{
    resolve: () => void
    reject: (error: unknown) => void
  }>
}

type SenderEnrichmentSession = {
  lastUsedAt: number
  contacts?: Awaited<ReturnType<typeof chat.listContactsAsync>>
  /**
   * conversationId → (wxid → displayName)。
   *
   * 只缓存"这个群里这些 wxid 解析出来是什么名字"，不再缓存整群快照。
   * 空串表示「查过、确实没有可用名字」，用于避免同一 session 内重复查询。
   */
  groupMemberNames: Map<string, Map<string, string>>
}

function looksLikeOpaqueSenderId(value: string | undefined): boolean {
  const normalized = value?.trim() || ''
  return (
    normalized.startsWith('wxid_') ||
    normalized.endsWith('@chatroom') ||
    /^\d{6,}$/.test(normalized)
  )
}

function conversationAliases(contact: { md5: string; m_nsUsrName: string }): string[] {
  return Array.from(
    new Set(
      [contact.md5, contact.m_nsUsrName, `Chat_${contact.md5}`]
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    )
  )
}

function groupMemberDisplayName(member: chat.GroupSnapshot['members'][number]): string {
  return (
    [member.groupNickname, member.wechatNickname, member.nickname, member.remark]
      .map((value) => value.trim())
      .find((value) => value && !looksLikeOpaqueSenderId(value)) || ''
  )
}


function sourceKind(message: chat.FormattedMessage): KnowledgeMessageKind {
  if (message.voiceTranscript || message.type === '语音') return 'voice'
  if (message.exportMediaType === 'image' || message.exportMediaType === 'video' || message.exportMediaType === 'sticker') {
    return message.exportMediaType
  }
  if (message.exportMediaType === 'file') return 'file'
  // 索引路径上 `exportMediaType` **不会被赋值**（只有 export-service 会设它），
  // 所以图片/视频/表情包必须从 contentData.type 判定，否则图片会静默落成 'other'，
  // 进而让"图片文字索引"的 Evidence 丢掉真正的来源类型。
  if (
    message.contentData?.type === 'image' ||
    message.contentData?.type === 'video' ||
    message.contentData?.type === 'sticker'
  ) {
    return message.contentData.type
  }
  if (message.contentData?.type === 'share' || message.contentData?.type === 'miniProgram') {
    return message.contentData.type === 'share' && message.contentData.typeVal === '6'
      ? 'file'
      : 'link'
  }
  if (message.contentData?.type === 'system') return 'system'
  return message.content?.trim() ? 'text' : 'other'
}

function sourceTextAndAttachment(message: chat.FormattedMessage): {
  text?: string
  attachment?: KnowledgeAttachmentMetadata
} {
  const text = message.content?.trim() || ''
  const content = message.contentData
  if (!content) {
    return {
      text: text || undefined,
      attachment: message.exportMediaName
        ? {
            name: message.exportMediaName,
            kind: message.exportMediaType === 'file' ? 'file' : 'other'
          }
        : undefined
    }
  }
  if (content.type === 'share') {
    const title = content.title?.trim() || ''
    const description = content.des?.trim() || ''
    const articles = (content.articles || []).flatMap((article) =>
      [article.title, article.description].map((value) => value?.trim()).filter(Boolean)
    )
    return {
      text: [text, title, description, ...articles].filter(Boolean).join('\n') || undefined,
      attachment:
        title || content.url
          ? {
              name: title || content.url,
              kind: content.typeVal === '6' ? 'file' : 'link',
              url: content.url
            }
          : undefined
    }
  }
  if (content.type === 'miniProgram') {
    return {
      text: [text, content.title, content.description].filter(Boolean).join('\n') || undefined,
      attachment: content.title ? { name: content.title, kind: 'link' } : undefined
    }
  }
  if (content.type === 'quote') {
    return {
      text:
        [text, content.title, content.content, content.quotedContent].filter(Boolean).join('\n') ||
        undefined
    }
  }
  if (content.type === 'forwardBundle') {
    return {
      text: [text, content.title, content.description, ...content.items.map((item) => item.text)]
        .filter(Boolean)
        .join('\n')
    }
  }
  return { text: text || undefined }
}

function toSourceMessage(
  accountId: string,
  conversationId: string,
  message: chat.FormattedMessage,
  transcriptOverride?: string,
  imageOcr?: { state: KnowledgeImageOcrState; text: string }
): KnowledgeSourceMessage | null {
  if (!message.createTime) return null
  const extracted = sourceTextAndAttachment(message)
  const voiceTranscript = transcriptOverride?.trim() || message.voiceTranscript?.trim() || undefined
  // 图片 OCR 文本走与语音转写完全相同的派生通道：有文本才入库，
  // 没有文字的图片（表情包/风景）不会污染索引。
  const imageOcrText = imageOcr?.text?.trim() || undefined
  if (!extracted.text && !extracted.attachment && !voiceTranscript && !imageOcrText) return null
  return {
    accountId,
    conversationId,
    messageId: sourceMessageId(message),
    // Existing chat messages use Unix seconds; the knowledge contract uses milliseconds.
    createTime: message.createTime * 1000,
    senderId: message.senderId || message.from || undefined,
    senderName: message.isSender ? '我' : message.name || undefined,
    kind: sourceKind(message),
    text: extracted.text,
    attachment: extracted.attachment,
    voiceTranscript,
    ...(imageOcrText ? { imageOcrText } : {}),
    ...(imageOcrText && imageOcr?.state ? { imageOcrState: imageOcr.state } : {})
  }
}

function normalizeComparable(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/g, '')
}

function fallbackTermScore(message: chat.FormattedMessage, terms: string[]): number {
  const source = toSourceMessage('fallback', 'fallback', message)
  const text = `${source?.text || ''}\n${source?.voiceTranscript || ''}\n${source?.attachment?.name || ''}`
  const normalized = normalizeComparable(text)
  return terms.reduce((score, term) => {
    const normalizedTerm = normalizeComparable(term)
    return normalizedTerm && normalized.includes(normalizedTerm)
      ? score + normalizedTerm.length
      : score
  }, 0)
}

/**
 * Main-process adapter for the read-only chat archive. It never passes source
 * database handles or keys to the worker; only normalized serializable values.
 */
export class KnowledgeSearchService {
  private readonly service: KnowledgeService
  private readonly indexing = new Map<string, Promise<void>>()
  private readonly statusByAccount = new Map<string, KnowledgeRuntimeStatus>()
  private readonly statusListeners = new Set<(status: KnowledgeRuntimeStatus) => void>()
  private readonly senderEnrichmentSessions = new Map<string, SenderEnrichmentSession>()
  /** WCDB 读取的两条通道：交互（查询）优先于后台（索引 pass）。 */
  private readonly wcdbPending: PendingWcdbRead[] = []
  private wcdbReadBusy = false
  private interactiveQueryDepth = 0
  private interactiveIdle: Promise<void> = Promise.resolve()
  private interactiveIdleResolve: (() => void) | null = null
  private wcdbQueueMsTotal = 0
  private wcdbExecutionMsTotal = 0
  /**
   * 图片 OCR 文本解析器（由 main 注入）。
   *
   * 与语音同构：派生文本在**主进程**解析后贴到消息上，派生库不进 worker。
   */
  private imageOcrResolver:
    | ((conversationId: string, messageId: string) => { state: KnowledgeImageOcrState; text: string } | undefined)
    | undefined
  private voiceTranscriptResolver:
    | ((reference: VoiceMessageReference) => VoiceTranscriptSnapshot)
    | undefined
  private voiceIndexTail: Promise<void> = Promise.resolve()
  private voiceIndexFlushScheduled = false
  private readonly pendingVoiceIndexes = new Map<string, PendingVoiceTranscriptIndex>()
  /** 上次由查询触发的追赶同步时间，用于节流（避免每个 Query 都重跑一次索引）。 */
  private lastCatchUpRequestedAt = 0
  /** 上一遍完整索引 pass 的实际耗时；用于让"是否值得再追一遍"的门槛自我校准。 */
  private lastIndexPassMs = 0
  /** 当前/最近一次 pass 的真实进度（供 UI 区分"追新"与"补历史"）。 */
  private passProgress: KnowledgePassProgress | null = null
  /** 用户是否已经请求取消当前 pass。取消后主循环在下一个安全点退出。 */
  private cancelRequested = false
  private lagHistogram: ReturnType<typeof monitorEventLoopDelay> | null = null
  private lagMaxMs = 0
  private lagStats: { p50: number; p95: number; p99: number; max: number } | null = null

  constructor(userDataPath: string, workerPath: string) {
    this.service = new KnowledgeService(userDataPath, workerPath)
  }

  startCurrentAccountIndex(): KnowledgeRuntimeStatus {
    const accountId = this.currentAccountId()
    if (!accountId) return this.emptyStatus('')
    const current = this.statusByAccount.get(accountId) || this.emptyStatus(accountId)
    if (this.indexing.has(accountId)) return current
    this.cancelRequested = false
    const startedAt = Date.now()
    this.startLagProbe()
    this.passProgress = {
      // 已经有分片 = 增量追新；完全没有 = 首次全量建立。
      phase: current.indexedChunkCount > 0 || current.indexedMessageCount > 0 ? 'catchup' : 'full',
      cancellable: true,
      startedAt,
      scannedMessages: 0,
      indexedMessages: 0,
      processedConversations: 0,
      totalConversations: 0,
      skippedConversations: 0,
      catchupConversations: 0,
      backfillConversations: 0,
      backfillCompletedConversations: 0,
      mainLoopLagMs: 0
    }
    const started: KnowledgeRuntimeStatus = {
      ...current,
      state: current.indexedMessageCount ? 'syncing' : 'building',
      processedMessages: 0,
      totalMessages: current.sourceMessageCount,
      estimatedRemainingMs: null,
      lastError: undefined,
      pass: { ...this.passProgress }
    }
    this.publishStatus(started)
    const task = this.indexAccount(accountId)
      .catch((error) => {
        const previous = this.statusByAccount.get(accountId)
        this.publishStatus({
          ...(previous || this.emptyStatus(accountId)),
          state: 'error',
          lastError: error instanceof Error ? error.message : String(error)
        })
        throw error
      })
      .finally(() => {
        this.indexing.delete(accountId)
        this.stopLagProbe()
        const finishedPass = this.passProgress
        if (finishedPass) {
          // 真实结束状态：取消就是取消，绝不留一个假的 indexing。
          finishedPass.cancellable = false
          finishedPass.mainLoopLagMs = this.lagMaxMs
          if (finishedPass.phase !== 'cancelled' && finishedPass.phase !== 'error') {
            finishedPass.phase = 'idle'
          }
        }
        void this.refreshStatus(accountId).catch(() => undefined)
      })
    this.indexing.set(accountId, task)
    void task.catch((error) => {
      console.warn('[Knowledge] background index failed:', error)
    })
    return started
  }

  /**
   * 取消当前正在跑的索引 pass。
   *
   * 只中止**索引**（与并发查询是两套独立 Abort scope）；当前 batch 安全收尾、
   * 已提交会话保留不回滚；`run_state` 落到 `cancelled`，不残留 `indexing`；
   * 下一次 catch-up / 手动同步从 per-conversation checkpoint 继续，不从头全量重扫。
   */
  async cancelCurrentAccountIndex(): Promise<{ cancellable: boolean; cancelled: boolean }> {
    if (!this.indexing.size) return { cancellable: false, cancelled: false }
    this.cancelRequested = true
    if (this.passProgress) this.passProgress.cancellable = false
    const accountId = this.currentAccountId()
    if (accountId) {
      const current = this.statusByAccount.get(accountId)
      if (current) this.publishStatus({ ...current, pass: this.passSnapshot() })
    }
    const cancelled = await this.service.cancelIndex().catch(() => false)
    return { cancellable: true, cancelled }
  }

  /**
   * The voice cache remains owned by the voice pipeline. Knowledge only reads
   * a current-account snapshot while constructing a derived local index.
   */
  setVoiceTranscriptResolver(
    resolver: (reference: VoiceMessageReference) => VoiceTranscriptSnapshot
  ): void {
    this.voiceTranscriptResolver = resolver
  }

  /** 注入图片 OCR 文本解析器（本地 System OCR 的派生结果）。 */
  setImageOcrResolver(
    resolver:
      | ((conversationId: string, messageId: string) => { state: KnowledgeImageOcrState; text: string } | undefined)
      | undefined
  ): void {
    this.imageOcrResolver = resolver
  }

  /**
   * A successful recognition updates its source conversation. Consecutive
   * updates for the same conversation are coalesced because a complete
   * snapshot already includes every finished transcript for that conversation.
   */
  indexVoiceTranscript(update: VoiceTranscriptUpdate): Promise<void> {
    const key = this.voiceIndexKey(update)
    return new Promise<void>((resolve, reject) => {
      const existing = this.pendingVoiceIndexes.get(key)
      if (existing) {
        existing.update = update
        existing.waiters.push({ resolve, reject })
      } else {
        this.pendingVoiceIndexes.set(key, {
          update,
          waiters: [{ resolve, reject }]
        })
      }
      this.scheduleVoiceIndexFlush()
    })
  }

  private voiceIndexKey(update: VoiceTranscriptUpdate): string {
    return `${update.accountIdentity}:${update.reference.sessionId}`
  }

  private scheduleVoiceIndexFlush(): void {
    if (this.voiceIndexFlushScheduled) return
    this.voiceIndexFlushScheduled = true
    const task = this.voiceIndexTail.then(() => this.flushPendingVoiceIndexes())
    this.voiceIndexTail = task.catch(() => undefined)
    void task.then(
      () => this.finishVoiceIndexFlush(),
      () => this.finishVoiceIndexFlush()
    )
  }

  private async flushPendingVoiceIndexes(): Promise<void> {
    while (this.pendingVoiceIndexes.size) {
      const pending = Array.from(this.pendingVoiceIndexes.values())
      this.pendingVoiceIndexes.clear()
      for (const entry of pending) {
        try {
          await this.indexVoiceTranscriptNow(entry.update)
          entry.waiters.forEach((waiter) => waiter.resolve())
        } catch (error) {
          entry.waiters.forEach((waiter) => waiter.reject(error))
        }
      }
    }
  }

  private finishVoiceIndexFlush(): void {
    this.voiceIndexFlushScheduled = false
    if (this.pendingVoiceIndexes.size) this.scheduleVoiceIndexFlush()
  }

  async search(request: KnowledgeSearchIpcRequest): Promise<KnowledgeSearchIpcResult> {
    // 源数据最新活跃时间与索引状态无关，先取一次（零额外 WCDB 调用：读的是已缓存的 Session 列表）。
    const sourceLatestAt = this.sourceLatestAt()
    const accountId = this.currentAccountId()
    if (!accountId) return { ...(await this.searchFallback(request, 'unavailable')), sourceLatestAt }
    try {
      const searchRequest: Omit<KnowledgeSearchRequest, 'databaseRoot'> = {
        accountId,
        fts: DEFAULT_KNOWLEDGE_FTS_CONFIG,
        text: request.text,
        terms: request.terms,
        limit: Math.max(1, Math.min(request.limit || FALLBACK_LIMIT, FALLBACK_LIMIT)),
        conversationIds: request.conversationIds,
        senderIds: request.senderIds,
        startTime: request.startTime === undefined ? undefined : request.startTime * 1000,
        endTime: request.endTime === undefined ? undefined : request.endTime * 1000
        ,conversationBoundary: request.conversationBoundary
      }
      const result = await this.searchKnowledge(searchRequest)
      // An existing derived database can answer while its next incremental pass is running.
      // Never turn an interactive global search into another full WCDB scan during that pass.
      if (result.state === 'ready' || result.evidence.length) {
        return { ...(await this.toKnowledgeResult(result, request.retrievalSessionId)), sourceLatestAt }
      }
      if (this.indexing.has(accountId)) {
        return {
          ...result,
          source: 'knowledge',
          totalMessages: result.indexedMessageCount,
          sourceLatestAt
        }
      }
      return { ...(await this.searchFallback(request, 'unavailable')), sourceLatestAt }
    } catch (error) {
      console.warn('[Knowledge] search failed, using legacy fallback:', error)
      return { ...(await this.searchFallback(request, 'error')), sourceLatestAt }
    }
  }

  /**
   * 源数据最新活跃时间（epoch ms）。派生索引看到不源数据，freshness 判定由它 + `indexLatestAt` 组成。
   */
  sourceLatestAt(): number | null {
    return chat.getSourceLatestActivityMs()
  }

  /**
   * 上一遍完整索引 pass 的耗时（ms）。0 表示本进程还没有跑完过一遍。
   * 调用方用它作为"落后多少才值得再追一遍"的门槛下限，避免在活跃源数据上无限连续索引。
   */
  lastPassDurationMs(): number {
    return this.lastIndexPassMs
  }

  /** 当前是否有索引任务在跑（用于「复用当前任务」而不是再启动一个）。 */
  isIndexing(): boolean {
    // 用 Map 是否为空判断，而不是用当前 accountId 去查：
    // `currentAccountId()` 会在 `getSelfAccountInfo()` 就绪前后返回不同的值，
    // 只按单键查会漏掉"其实已经有 pass 在跑"，于是又启动一个（两个 pass 抢同一个派生库）。
    return this.indexing.size > 0
  }

  /**
   * 主动请求一次追赶同步。
   *
   * 复用现有增量通道（`startCurrentAccountIndex` 内部是增量的：未变化的会话不会重建分片）；
   * 如果已经在跑就**不**再启动第二个，并把 `triggered` 标为 false，让调用方知道这是复用。
   */
  requestCatchUp(minIntervalMs: number): { triggered: boolean; inProgress: boolean } {
    const accountId = this.currentAccountId()
    if (!accountId) return { triggered: false, inProgress: false }
    if (this.isIndexing()) return { triggered: false, inProgress: true }
    const now = Date.now()
    if (now - this.lastCatchUpRequestedAt < minIntervalMs) {
      return { triggered: false, inProgress: false }
    }
    this.lastCatchUpRequestedAt = now
    this.startCurrentAccountIndex()
    return { triggered: true, inProgress: this.isIndexing() }
  }

  /**
   * 等当前索引任务结束，最多等 `budgetMs`。返回是否已经结束。
   * 全量追赶可能远超查询预算，所以这里必须是**有界**等待，不能无限阻塞交互查询。
   */
  async waitForIndexingComplete(budgetMs: number): Promise<boolean> {
    const task = this.indexing.values().next().value as Promise<void> | undefined
    if (!task) return true
    if (budgetMs <= 0) return false
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), budgetMs)
    })
    try {
      return await Promise.race([task.then(() => true, () => true), timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async dispose(): Promise<void> {
    await this.service.dispose()
  }

  /** Safely release derived SQLite handles before the cache screen removes them. */
  async prepareForCacheClear(): Promise<void> {
    if (this.indexing.size) {
      throw new Error('本地知识库正在同步，请等待同步完成后再清理')
    }
    await this.service.dispose()
    const accountIds = Array.from(this.statusByAccount.keys())
    this.statusByAccount.clear()
    accountIds.forEach((accountId) => this.publishStatus(this.emptyStatus(accountId)))
  }

  onStatusChange(listener: (status: KnowledgeRuntimeStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  async getStatus(): Promise<KnowledgeRuntimeStatus> {
    const accountId = this.currentAccountId()
    if (!accountId) return this.emptyStatus('')
    return this.refreshStatus(accountId)
  }

  private currentAccountId(): string {
    if (!chat.isReady()) return ''
    return chat.getSelfAccountInfo()?.wxid || chat.getCurrentAccountRoot()
  }

  private async indexAccount(accountId: string): Promise<void> {
    // 整遍后台索引走 background 通道：交互查询可以插到它前面，不至于被 pass 拖慢。
    const contacts = await this.listContacts('background')
    const startedAt = Date.now()
    // 源侧每会话最后活跃时间（零额外 WCDB 调用：直接来自 Session 列表）。
    const activity = chat.getConversationActivityMs()
    // 每个会话已经索引到哪（per-conversation checkpoint）。
    const marks = await this.service
      .highWaterMarks({ accountId, fts: DEFAULT_KNOWLEDGE_FTS_CONFIG })
      .catch(() => ({}) as Record<string, number>)
    // 上一遍记录的源侧边界：被跳过的会话已覆盖到它，不能因为"这一遍没读"而回退。
    const previouslyCoveredLatestAt =
      this.statusByAccount.get(accountId)?.indexLatestAt ?? 0

    let scannedMessages = 0
    let indexedMessages = 0
    let sourceLatestAt = previouslyCoveredLatestAt
    let skippedConversations = 0
    let backfillCompletedConversations = 0

    // 「追最新」与「补历史」是两个工作概念，顺序不能反：
    // catch-up：已建立 checkpoint、源侧出现新消息 → 用户最关心，排在最前；
    // backfill：从来没有 checkpoint（历史缺口）→ 必须整段读，排在后面慢慢补。
    // 这个顺序保证今天的新消息不会被历史缺口堵住。
    const catchUpContacts: typeof contacts = []
    const backfillContacts: typeof contacts = []
    for (const contact of contacts) {
      const mark = marks[contact.md5]
      if (mark !== undefined && mark > 0) {
        const previousActivity = activity.get(contact.md5)
        // 源侧最后活跃时间不晚于"已经索引到的位置"→ 这个会话没有任何新消息。
        // 直接跳过：**不读 WCDB、不传 IPC、不写索引**。
        // 这正是把「一次 pass 处理百万级消息」变成「只处理真正变过的会话」的地方。
        if (previousActivity !== undefined && previousActivity <= mark) {
          skippedConversations += 1
          continue
        }
        catchUpContacts.push(contact)
        continue
      }
      // 没有 checkpoint → 没有"已经覆盖到哪"的证据，只能整段读（历史 backfill）。
      //
      // 这里**不**用「源侧活动（Session 表）里没有它」推断「它不可能有消息」。
      // 那确实能省掉读一批空联系人的开销，但只要 Session 表在某次读取里不完整
      // （或用户删过会话），这个推断就会把一个真有消息的会话变成**永久静默不索引**。
      // 省下来的时间换不来这个风险。
      backfillContacts.push(contact)
    }
    const orderedContacts = [...catchUpContacts, ...backfillContacts]

    if (this.passProgress) {
      this.passProgress.totalConversations = contacts.length
      this.passProgress.startedAt = startedAt
      this.passProgress.skippedConversations = skippedConversations
      this.passProgress.catchupConversations = catchUpContacts.length
      this.passProgress.backfillConversations = backfillContacts.length
      this.passProgress.backfillCompletedConversations = 0
      this.passProgress.processedConversations = skippedConversations
    }
    this.publishStatus({
      ...(this.statusByAccount.get(accountId) || this.emptyStatus(accountId)),
      state: this.statusByAccount.get(accountId)?.indexedMessageCount ? 'syncing' : 'building',
      processedMessages: 0,
      totalMessages: null,
      estimatedRemainingMs: null,
      pass: this.passSnapshot()
    })
    let cancelled = false
    for (const [index, contact] of orderedContacts.entries()) {
      if (this.cancelRequested) {
        cancelled = true
        break
      }
      // 交互查询进行中就让路：背景索引绝不能把用户查询拖慢（见 beginInteractiveQuery）。
      await this.interactiveIdle
      const isBackfill = index >= catchUpContacts.length
      if (this.passProgress) {
        this.passProgress.phase = isBackfill ? 'backfill' : 'catchup'
        this.passProgress.processedConversations = skippedConversations + index
      }
      const previousActivity = activity.get(contact.md5)
      const mark = marks[contact.md5]
      // WCDB rejects overlapping async pagination. Queue every archive read so
      // background indexing and an interactive fallback search can interleave safely.
      //
      // delta 读取：已建立 checkpoint 时只读 checkpoint 之后的源消息（外加有界 overlap），
      // 而不是"从历史开头全扫一遍、再判断哪些已经索引过"。
      //
      // ⚠️ 单位契约见 `DELTA_OVERLAP_MS`：checkpoint 是**毫秒**，传给 WCDB 读取层
      // 必须是**秒**，否则 delta 读会被静默过滤成空。
      const isDelta = mark !== undefined && mark > 0
      const sinceTime = isDelta
        ? Math.max(0, Math.floor((mark - DELTA_OVERLAP_MS) / 1000))
        : undefined
      const messages = await this.listMessages(contact.md5, sinceTime, undefined, 'background')
      scannedMessages += messages.length
      // 这一遍扫到的源数据最新时间：用**未过滤**的原始消息计算，
      // 这样「不可建模」的消息（图片/空正文）不会让 freshness 口径偏旧。
      let conversationLatest = 0
      for (const message of messages) {
        const createTime = (message.createTime || 0) * 1000
        if (createTime > conversationLatest) conversationLatest = createTime
      }
      if (conversationLatest > sourceLatestAt) sourceLatestAt = conversationLatest
      const sourceMessages = messages
        .map((message) => this.toSourceMessage(accountId, contact.md5, message))
        .filter((message): message is KnowledgeSourceMessage => Boolean(message))
      // 记录**源侧**边界（而不是索引里最后一条可建模消息的时间）：
      // 否则"最后一条恰好落在图片上"的会话会永远被判成有新消息，增量永远跳不过它。
      //
      // 安全阀：delta 范围读**空**、但源侧声称有新消息 → **不推进** checkpoint。
      // 宁可下一遍重试，也不让"一次可疑的空读"升级成"谎报已覆盖"（那会静默丢消息）。
      const suspiciousEmptyDelta =
        isDelta && messages.length === 0 && (previousActivity ?? 0) > (mark ?? 0)
      const sourceHighWaterTime = suspiciousEmptyDelta
        ? undefined
        : Math.max(previousActivity ?? 0, conversationLatest)
      const result = await this.service.index(
        {
          accountId,
          conversations: [
            {
              conversationId: contact.md5,
              // delta 模式下绝不能声明"完整快照"：否则 store 会把"不在 delta 里的历史消息"
              // 误判为被删除，从而整段重建这个会话，增量就白做了。
              completeSnapshot: !isDelta,
              messages: sourceMessages,
              ...(sourceHighWaterTime && sourceHighWaterTime > 0 ? { sourceHighWaterTime } : {})
            }
          ],
          chunker: DEFAULT_KNOWLEDGE_CHUNKER,
          fts: DEFAULT_KNOWLEDGE_FTS_CONFIG,
          // 只有「这一遍真的读完了全部会话」（没有任何跳过、没有取消）才写入总量口径，
          // 否则会把增量 pass 的部分计数冒充成全量。
          //
          // 这里数的是真正被建模进索引的源消息，不是"扫到的原始条数"；后者（含不可建模的
          // 图片/空正文）另走 pass 进度里的 scannedMessages。两个数字回答不同问题。
          sourceMessageCount:
            index === orderedContacts.length - 1 && skippedConversations === 0
              ? indexedMessages + sourceMessages.length
              : undefined,
          sourceLatestAt:
            index === orderedContacts.length - 1 && sourceLatestAt > 0 ? sourceLatestAt : undefined
        },
        (progress) => {
          const current = this.statusByAccount.get(accountId) || this.emptyStatus(accountId)
          this.publishStatus({
            ...current,
            state: current.indexedMessageCount ? 'syncing' : 'building',
            processedMessages: indexedMessages + progress.processedMessages,
            totalMessages: null,
            currentConversationId: progress.conversationId,
            estimatedRemainingMs: null,
            pass: this.passSnapshot()
          })
        }
      )
      if (result.cancelled) {
        cancelled = true
        indexedMessages += result.processedMessages
        break
      }
      indexedMessages += sourceMessages.length
      if (isBackfill) backfillCompletedConversations += 1
      if (this.passProgress) {
        this.passProgress.scannedMessages = scannedMessages
        this.passProgress.indexedMessages = indexedMessages
        this.passProgress.processedConversations = skippedConversations + index + 1
        this.passProgress.backfillCompletedConversations = backfillCompletedConversations
      }
      const current = this.statusByAccount.get(accountId) || this.emptyStatus(accountId)
      this.publishStatus({
        ...current,
        state: current.indexedMessageCount ? 'syncing' : 'building',
        processedMessages: indexedMessages,
        totalMessages: null,
        currentConversationId: contact.md5,
        estimatedRemainingMs: null,
        pass: this.passSnapshot()
      })
    }
    if (cancelled && this.passProgress) this.passProgress.phase = 'cancelled'
    // 一遍 pass 一行汇总（低频、只在结束时输出一次）。这些数字同时喂给 UI 的 pass 进度；
    // lag 输出分位数而不是单点，因为"最大值看着还行"不能说明没有 stall。
    console.info(
      `[Knowledge] pass ${cancelled ? 'cancelled' : 'done'} conversations=${contacts.length} ` +
        `skipped=${skippedConversations} scanned=${scannedMessages} indexed=${indexedMessages} ` +
        `catchup=${catchUpContacts.length} backfill=${backfillContacts.length}/${backfillCompletedConversations} ` +
        `elapsedMs=${Date.now() - startedAt} ` +
        `lagP50=${this.lagStats?.p50 ?? 0} lagP95=${this.lagStats?.p95 ?? 0} ` +
        `lagP99=${this.lagStats?.p99 ?? 0} lagMax=${this.lagStats?.max ?? this.lagMaxMs} ` +
        `activityEntries=${activity.size} checkpointMarks=${Object.keys(marks).length}`
    )
    await this.refreshStatus(accountId, {
      processedMessages: indexedMessages,
      totalMessages: null,
      startedAt
    })
    // 取消的一遍不计入"上一遍耗时"，否则查询侧的门槛会被一次提前结束的 pass 带偏。
    if (!cancelled) this.lastIndexPassMs = Date.now() - startedAt
  }

  /** 当前 pass 进度的不可变快照（含实时采样到的主线程滞后）。 */
  private passSnapshot(): KnowledgePassProgress | undefined {
    if (!this.passProgress) return undefined
    // 运行期间也要能读到"此刻为止"的最大滞后，而不是等 pass 结束才有数字。
    const liveMax = this.lagHistogram ? roundMs(this.lagHistogram.max) : this.lagMaxMs
    return { ...this.passProgress, mainLoopLagMs: Math.max(liveMax, 0) }
  }

  /**
   * 在 pass 开始时启动主线程滞后采样。这是"重活没有压在主线程上"的直接证据。
   */
  private startLagProbe(): void {
    if (this.lagHistogram) return
    this.lagMaxMs = 0
    this.lagStats = null
    try {
      const histogram = monitorEventLoopDelay({ resolution: LAG_PROBE_RESOLUTION_MS })
      histogram.enable()
      this.lagHistogram = histogram
    } catch {
      // 采样失败不应该影响索引本身；退化为"没有 lag 数据"。
      this.lagHistogram = null
    }
  }

  private stopLagProbe(): void {
    const histogram = this.lagHistogram
    if (!histogram) return
    histogram.disable()
    this.lagStats = {
      p50: roundMs(histogram.percentile(50)),
      p95: roundMs(histogram.percentile(95)),
      p99: roundMs(histogram.percentile(99)),
      max: roundMs(histogram.max)
    }
    this.lagMaxMs = Math.max(this.lagMaxMs, this.lagStats.max)
    this.lagHistogram = null
  }

  private async searchFallback(
    request: KnowledgeSearchIpcRequest,
    fallbackReason: 'unavailable' | 'indexing' | 'error'
  ): Promise<KnowledgeSearchIpcResult> {
    const startedAt = Date.now()
    const contacts = await this.listContacts()
    const allowedConversations = new Set(request.conversationIds || [])
    const sourceContacts = allowedConversations.size
      ? contacts.filter((contact) =>
          conversationAliases(contact).some((alias) => allowedConversations.has(alias))
        )
      : contacts
    const senderIds = new Set(request.senderIds || [])
    const terms = request.terms.filter((term) => term.trim().length >= 2)
    const matches: Array<{
      contact: (typeof sourceContacts)[number]
      message: chat.FormattedMessage
      score: number
    }> = []
    let totalMessages = 0

    for (const contact of sourceContacts) {
      const messages = await this.listMessages(contact.md5, request.startTime, request.endTime)
      totalMessages += messages.length
      for (const message of messages) {
        const hydrated = this.withVoiceTranscript(message)
        matches.push({
          contact,
          message: hydrated,
          score: fallbackTermScore(hydrated, terms)
        })
      }
    }
    const filtered = matches
      .filter(({ message, score }) => {
        const senderMatches = !senderIds.size || senderIds.has(message.senderId || message.from)
        const termMatches = !terms.length || score > 0
        const boundaryMatches = !request.conversationBoundary || message.contentData?.type !== 'system'
        return senderMatches && termMatches && boundaryMatches
      })
      .sort(
        (left, right) =>
          right.score - left.score ||
          (request.conversationBoundary === 'first' ? -1 : 1) *
            ((right.message.createTime || 0) - (left.message.createTime || 0))
      )
      .slice(0, Math.max(1, Math.min(request.limit || FALLBACK_LIMIT, FALLBACK_LIMIT)))
    const result: KnowledgeSearchIpcResult = {
      source: 'fallback',
      fallbackReason,
      state: fallbackReason === 'indexing' ? 'indexing' : 'unavailable',
      indexedMessageCount: 0,
      indexedChunkCount: 0,
      // fallback 是直接扫源数据，不走派生索引，因此没有索引覆盖口径可言。
      indexLatestAt: null,
      sourceLatestAt: this.sourceLatestAt(),
      totalMessages,
      timings: {
        ...emptyKnowledgeSearchTimings(),
        messageLoadMs: Date.now() - startedAt,
        totalMs: Date.now() - startedAt
      },
      evidence: filtered.map(({ contact, message, score }) => ({
        chunkId: `fallback:${contact.md5}:${sourceMessageId(message)}`,
        conversationId: contact.md5,
        startTime: (message.createTime || 0) * 1000,
        endTime: (message.createTime || 0) * 1000,
        messageId: sourceMessageId(message),
        senderId: message.senderId || message.from || undefined,
        sender: message.isSender ? '我' : message.name || '未知成员',
        timestamp: (message.createTime || 0) * 1000,
        messageIds: [sourceMessageId(message)],
        sourceKind: sourceKind(message),
        text:
          this.toSourceMessage('fallback', contact.md5, message)?.voiceTranscript ||
          sourceTextAndAttachment(message).text ||
          message.content ||
          `[${message.type}]`,
        score: -score
      }))
    }
    const beforeQueueMs = this.wcdbQueueMsTotal
    const beforeExecutionMs = this.wcdbExecutionMsTotal
    const enrichmentStartedAt = Date.now()
    const evidence = await this.enrichEvidenceSenders(result.evidence, request.retrievalSessionId)
    return {
      ...result,
      evidence,
      timings: {
        ...result.timings,
        senderEnrichmentMs: Date.now() - enrichmentStartedAt,
        wcdbQueueMs: this.wcdbQueueMsTotal - beforeQueueMs,
        wcdbExecutionMs: this.wcdbExecutionMsTotal - beforeExecutionMs
      }
    }
  }

  /**
   * SQLite has a finite bind-parameter limit. Group/one-to-one scope filters
   * can contain over one thousand conversations, so split only the Worker
   * query and merge real Evidence instead of dropping the selected scope.
   */
  private async searchKnowledge(
    request: Omit<KnowledgeSearchRequest, 'databaseRoot'>
  ): Promise<KnowledgeSearchResult> {
    const conversationIds = Array.from(new Set(request.conversationIds || []))
    if (conversationIds.length <= MAX_CONVERSATION_FILTERS_PER_WORKER_SEARCH) {
      return this.searchWorker(request)
    }
    const partialResults: KnowledgeSearchResult[] = []
    for (
      let start = 0;
      start < conversationIds.length;
      start += MAX_CONVERSATION_FILTERS_PER_WORKER_SEARCH
    ) {
      partialResults.push(
        await this.searchWorker({
          ...request,
          conversationIds: conversationIds.slice(
            start,
            start + MAX_CONVERSATION_FILTERS_PER_WORKER_SEARCH
          )
        })
      )
    }
    const evidenceByIdentity = new Map<string, KnowledgeEvidence>()
    partialResults
      .flatMap((result) => result.evidence)
      .forEach((item) => {
        const identity = `${item.conversationId}:${item.messageId}`
        const existing = evidenceByIdentity.get(identity)
        if (!existing || (item.score || 0) < (existing.score || 0)) {
          evidenceByIdentity.set(identity, item)
        }
      })
    const mergeStartedAt = Date.now()
    const mergedEvidence = Array.from(evidenceByIdentity.values())
      .sort(
        (left, right) => (left.score || 0) - (right.score || 0) || right.timestamp - left.timestamp
      )
      .slice(0, request.limit)
    const timings = partialResults.reduce(
      (total, result) => ({
        workerIpcMs: total.workerIpcMs + (result.timings?.workerIpcMs || 0),
        workerBootMs: total.workerBootMs + (result.timings?.workerBootMs || 0),
        dispatchMs: total.dispatchMs + (result.timings?.dispatchMs || 0),
        workerSqlMs: total.workerSqlMs + (result.timings?.workerSqlMs || 0),
        responseTransferMs: total.responseTransferMs + (result.timings?.responseTransferMs || 0),
        responseSerializeMs: total.responseSerializeMs + (result.timings?.responseSerializeMs || 0),
        ftsMs: total.ftsMs + (result.timings?.ftsMs || 0),
        messageLoadMs: total.messageLoadMs + (result.timings?.messageLoadMs || 0),
        chunkExpandMs: total.chunkExpandMs + (result.timings?.chunkExpandMs || 0),
        rankingMs: total.rankingMs + (result.timings?.rankingMs || 0),
        totalMs: total.totalMs + (result.timings?.totalMs || 0),
        globalCountMs: (total.globalCountMs || 0) + (result.timings?.globalCountMs || 0),
        voiceCoverageMs: (total.voiceCoverageMs || 0) + (result.timings?.voiceCoverageMs || 0),
        workerExecutionMs:
          (total.workerExecutionMs || 0) +
          (result.timings?.workerExecutionMs || result.timings?.totalMs || 0),
        workerQueueMs: (total.workerQueueMs || 0) + (result.timings?.workerQueueMs || 0),
        ipcMs: (total.ipcMs || 0) + (result.timings?.ipcMs || result.timings?.workerIpcMs || 0),
        serializationMs:
          (total.serializationMs || 0) +
          (result.timings?.serializationMs || result.timings?.responseSerializeMs || 0)
      }),
      emptyKnowledgeSearchTimings()
    )
    const mergeRankingMs = Date.now() - mergeStartedAt
    timings.rankingMs += mergeRankingMs
    timings.totalMs += mergeRankingMs
    const voiceCoverageParts = partialResults
      .map((result) => result.voiceCoverage)
      .filter((coverage): coverage is NonNullable<typeof coverage> => Boolean(coverage))
    const voiceCoverage = voiceCoverageParts.length
      ? voiceCoverageParts.reduce(
          (total, coverage) => ({
            voiceMessageCount: total.voiceMessageCount + coverage.voiceMessageCount,
            transcribedVoiceCount: total.transcribedVoiceCount + coverage.transcribedVoiceCount,
            failedVoiceCount: total.failedVoiceCount + coverage.failedVoiceCount,
            voiceCoverageComplete: false
          }),
          {
            voiceMessageCount: 0,
            transcribedVoiceCount: 0,
            failedVoiceCount: 0,
            voiceCoverageComplete: false
          }
        )
      : undefined
    if (voiceCoverage) {
      voiceCoverage.voiceCoverageComplete =
        voiceCoverage.voiceMessageCount === voiceCoverage.transcribedVoiceCount
    }
    const indexLatestParts = partialResults
      .map((result) => result.indexLatestAt)
      .filter((value): value is number => typeof value === 'number' && value > 0)
    return {
      state: partialResults.some((result) => result.state === 'ready')
        ? 'ready'
        : partialResults.some((result) => result.state === 'indexing')
          ? 'indexing'
          : 'unavailable',
      indexedMessageCount: Math.max(...partialResults.map((result) => result.indexedMessageCount)),
      indexedChunkCount: Math.max(...partialResults.map((result) => result.indexedChunkCount)),
      // 多个分片取最新的那个：只要有一部分索引更新，整体覆盖口径就按它算。
      indexLatestAt: indexLatestParts.length ? Math.max(...indexLatestParts) : null,
      evidence: mergedEvidence,
      timings,
      voiceCoverage
    }
  }

  private async searchWorker(
    request: Omit<KnowledgeSearchRequest, 'databaseRoot'>
  ): Promise<KnowledgeSearchResult> {
    const startedAt = Date.now()
    const result = await this.service.search(request)
    const timings = result.timings || emptyKnowledgeSearchTimings()
    const workerExecutionMs = timings.workerExecutionMs ?? timings.totalMs
    const ipcMs = timings.ipcMs ?? timings.workerIpcMs
    const serializationMs = timings.serializationMs ?? timings.responseSerializeMs
    return {
      ...result,
      timings: {
        ...timings,
        // Do not infer IPC by subtracting the Worker timer from wall clock:
        // that previously hid unmeasured Worker execution inside “通信”.
        workerIpcMs: timings.workerIpcMs,
        ipcMs,
        workerSqlMs: timings.workerSqlMs || timings.totalMs,
        workerExecutionMs,
        serializationMs,
        otherMs:
          timings.otherMs ??
          Math.max(0, Date.now() - startedAt - workerExecutionMs - ipcMs - serializationMs)
      }
    }
  }

  private listContacts(lane: WcdbReadLane = 'interactive'): ReturnType<typeof chat.listContactsAsync> {
    return this.enqueueWcdbRead(() => chat.listContactsAsync(), lane)
  }

  private listMessages(
    conversationId: string,
    startTime?: number,
    endTime?: number,
    lane: WcdbReadLane = 'interactive'
  ): ReturnType<typeof chat.listMessagesAsync> {
    return this.enqueueWcdbRead(
      () => chat.listMessagesAsync(conversationId, startTime, endTime, undefined, undefined, 'knowledge'),
      lane
    )
  }

  private withVoiceTranscript(message: chat.FormattedMessage): chat.FormattedMessage {
    const reference = this.voiceReferenceFromMessage(message)
    if (!reference || !this.voiceTranscriptResolver) return message
    const snapshot = this.voiceTranscriptResolver(reference)
    if (snapshot.state !== 'transcribed' || !snapshot.transcript?.trim()) return message
    return { ...message, voiceTranscript: snapshot.transcript.trim() }
  }

  private toSourceMessage(
    accountId: string,
    conversationId: string,
    message: chat.FormattedMessage,
    transcriptOverride?: string,
    stateOverride?: 'pending' | 'transcribed' | 'failed'
  ): KnowledgeSourceMessage | null {
    const reference = this.voiceReferenceFromMessage(message)
    const snapshot = reference ? this.voiceTranscriptResolver?.(reference) : undefined
    const hydrated = this.withVoiceTranscript(message)
    const imageOcr = this.imageOcrResolver?.(conversationId, sourceMessageId(message))
    const source = toSourceMessage(
      accountId,
      conversationId,
      hydrated,
      transcriptOverride,
      imageOcr
    )
    if (!source) return source
    if (source.kind !== 'image' && source.kind !== 'voice') return source
    return {
      ...source,
      voiceTranscriptState:
        stateOverride ||
        (transcriptOverride?.trim() ? 'transcribed' : undefined) ||
        snapshot?.state ||
        (source.voiceTranscript ? 'transcribed' : 'pending')
    }
  }

  private voiceReferenceFromMessage(
    message: chat.FormattedMessage
  ): VoiceMessageReference | undefined {
    if (
      message.type !== '语音' ||
      !message.sessionId ||
      message.localId === undefined ||
      !message.createTime
    ) {
      return undefined
    }
    return {
      sessionId: message.sessionId,
      localId: message.localId,
      createTime: message.createTime,
      svrId: message.serverId
    }
  }

  /**
   * 某个会话的图片 OCR 处理完成 → 重建该会话的索引。
   *
   * 与"语音转写完成后单会话重索引"完全同构：整会话重读 + completeSnapshot 重建，
   * 让 OCR 派生文本进入 chunks/FTS，从而可被 search_messages 检索。
   * 原图片消息仍然是 authoritative source —— 这里只是让它多了一段派生文本，
   * 不产生任何"OCR 消息"。
   */
  async indexImageOcr(conversationId: string): Promise<void> {
    if (!chat.isReady()) return
    const accountId = this.currentAccountId()
    if (!accountId) return
    const activeIndex = this.indexing.get(accountId)
    if (activeIndex) await activeIndex
    const contacts = await this.listContacts()
    const contact = contacts.find((item) => item.md5 === conversationId)
    if (!contact) return
    const messages = await this.listMessages(contact.md5, undefined, undefined, 'background')
    const sourceMessages = messages
      .map((message) => this.toSourceMessage(accountId, contact.md5, message))
      .filter((message): message is KnowledgeSourceMessage => Boolean(message))
    await this.service.index({
      accountId,
      conversations: [
        { conversationId: contact.md5, completeSnapshot: true, messages: sourceMessages }
      ],
      chunker: DEFAULT_KNOWLEDGE_CHUNKER,
      fts: DEFAULT_KNOWLEDGE_FTS_CONFIG
    })
    await this.refreshStatus(accountId)
  }

  private async indexVoiceTranscriptNow(update: VoiceTranscriptUpdate): Promise<void> {
    if (!chat.isReady()) return
    if (update.state === 'transcribed' && !update.transcript?.trim()) return
    if (voiceAccountIdentity(chat.getCurrentAccountRoot()) !== update.accountIdentity) {
      return
    }
    const accountId = this.currentAccountId()
    if (!accountId) return
    const activeIndex = this.indexing.get(accountId)
    if (activeIndex) await activeIndex
    if (voiceAccountIdentity(chat.getCurrentAccountRoot()) !== update.accountIdentity) {
      return
    }
    const contacts = await this.listContacts()
    const contact = contacts.find((item) => item.m_nsUsrName === update.reference.sessionId)
    if (!contact) return
    const messages = await this.listMessages(contact.md5)
    const sourceMessages = messages
      .map((message) => {
        const reference = this.voiceReferenceFromMessage(message)
        const transcriptOverride =
          reference && voiceMessageIdentity(reference) === update.messageIdentity
            ? update.transcript
            : undefined
        const stateOverride =
          reference && voiceMessageIdentity(reference) === update.messageIdentity
            ? update.state
            : undefined
        return this.toSourceMessage(
          accountId,
          contact.md5,
          message,
          transcriptOverride,
          stateOverride
        )
      })
      .filter((message): message is KnowledgeSourceMessage => Boolean(message))
    await this.service.index({
      accountId,
      conversations: [
        {
          conversationId: contact.md5,
          completeSnapshot: true,
          messages: sourceMessages
        }
      ],
      chunker: DEFAULT_KNOWLEDGE_CHUNKER,
      fts: DEFAULT_KNOWLEDGE_FTS_CONFIG
    })
    await this.refreshStatus(accountId)
  }

  private async toKnowledgeResult(
    result: KnowledgeSearchResult,
    retrievalSessionId?: string
  ): Promise<KnowledgeSearchIpcResult> {
    const beforeQueueMs = this.wcdbQueueMsTotal
    const beforeExecutionMs = this.wcdbExecutionMsTotal
    const enrichmentStartedAt = Date.now()
    const evidence = await this.enrichEvidenceSenders(result.evidence, retrievalSessionId)
    return {
      ...result,
      evidence,
      timings: {
        ...result.timings,
        senderEnrichmentMs: Date.now() - enrichmentStartedAt,
        wcdbQueueMs: this.wcdbQueueMsTotal - beforeQueueMs,
        wcdbExecutionMs: this.wcdbExecutionMsTotal - beforeExecutionMs
      },
      source: 'knowledge',
      totalMessages: result.indexedMessageCount,
      sourceLatestAt: this.sourceLatestAt()
    }
  }

  /**
   * Evidence 的 sender 显示名 enrichment。
   *
   * 只做「取名字」这一件事：按 conversation 聚合 evidence 真正需要的 wxid（不是整群成员），
   * 每群一次批量 name lookup（`getGroupMemberNamesAsync`），**不**构造完整 GroupSnapshot、
   * **不** hydrate 头像 —— 后者会把整群成员的头像一起读出来，为拿几个名字付整群成本。
   *
   * 头像不属于 Query Tool 的成本；若 Evidence UI 将来要头像，走 lazy 路径。
   */
  private async enrichEvidenceSenders(
    evidence: KnowledgeEvidence[],
    retrievalSessionId?: string
  ): Promise<KnowledgeEvidence[]> {
    // 先按会话聚合需要的 sender，避免"每条 evidence 一次调用"。
    const wxidsByConversation = new Map<string, Set<string>>()
    for (const item of evidence) {
      if (!item.senderId || !looksLikeOpaqueSenderId(item.sender)) continue
      let bucket = wxidsByConversation.get(item.conversationId)
      if (!bucket) {
        bucket = new Set<string>()
        wxidsByConversation.set(item.conversationId, bucket)
      }
      bucket.add(item.senderId)
    }
    if (!wxidsByConversation.size) return evidence

    const session = retrievalSessionId
      ? this.senderEnrichmentSession(retrievalSessionId)
      : undefined
    const contacts = session?.contacts || (await this.listContacts())
    if (session && !session.contacts) session.contacts = contacts
    const groupConversationIds = new Set(
      contacts.filter((contact) => contact.type === 'group').map((contact) => contact.md5)
    )

    const candidateConversationIds = Array.from(wxidsByConversation.keys())
      .filter((conversationId) => groupConversationIds.has(conversationId))
      .slice(0, MAX_SENDER_NAME_CONVERSATIONS)

    const memberNamesByConversation = new Map<string, Map<string, string>>()
    for (const conversationId of candidateConversationIds) {
      const requested = Array.from(wxidsByConversation.get(conversationId) || [])
      if (!requested.length) continue
      let memberNames = session?.groupMemberNames.get(conversationId)
      // 只查缓存里还没有的 wxid —— 同一 session 的后续 probe 因此不会重复读 WCDB。
      const missing = requested.filter((wxid) => !memberNames?.has(wxid))
      if (missing.length) {
        const members = await this.enqueueWcdbRead(() =>
          chat.getGroupMemberNamesAsync(conversationId, missing)
        )
        if (!memberNames) {
          memberNames = new Map<string, string>()
          session?.groupMemberNames.set(conversationId, memberNames)
        }
        for (const member of members) {
          memberNames.set(member.wxid, groupMemberDisplayName(member))
        }
        // 请求了但没有返回名字的 wxid 也标记为"查过"，避免后续 probe 反复重查。
        for (const wxid of missing) {
          if (!memberNames.has(wxid)) memberNames.set(wxid, '')
        }
      }
      if (memberNames?.size) memberNamesByConversation.set(conversationId, memberNames)
    }

    return evidence.map((item) => {
      const sender = memberNamesByConversation.get(item.conversationId)?.get(item.senderId || '')
      return sender ? { ...item, sender } : item
    })
  }

  private senderEnrichmentSession(retrievalSessionId: string): SenderEnrichmentSession {
    const now = Date.now()
    for (const [key, value] of this.senderEnrichmentSessions) {
      if (now - value.lastUsedAt > SENDER_ENRICHMENT_SESSION_TTL_MS) {
        this.senderEnrichmentSessions.delete(key)
      }
    }
    let session = this.senderEnrichmentSessions.get(retrievalSessionId)
    if (!session) {
      session = { lastUsedAt: now, groupMemberNames: new Map() }
      this.senderEnrichmentSessions.set(retrievalSessionId, session)
    }
    session.lastUsedAt = now
    while (this.senderEnrichmentSessions.size > MAX_SENDER_ENRICHMENT_SESSIONS) {
      const oldest = this.senderEnrichmentSessions.keys().next().value as string | undefined
      if (!oldest) break
      this.senderEnrichmentSessions.delete(oldest)
    }
    return session
  }

  /**
   * 交互查询进行中：后台索引会让路。
   *
   * 追赶同步会自动遍历上千个会话；如果不让路，一次用户查询会和后台 pass 抢同一个
   * Worker 与 WCDB 读取通道，被拖到几十秒 —— 查询不能因为索引 backlog 卡住。
   */
  beginInteractiveQuery(): void {
    if (this.interactiveQueryDepth === 0) {
      this.interactiveIdle = new Promise<void>((resolve) => {
        this.interactiveIdleResolve = resolve
      })
    }
    this.interactiveQueryDepth += 1
  }

  endInteractiveQuery(): void {
    this.interactiveQueryDepth = Math.max(0, this.interactiveQueryDepth - 1)
    if (this.interactiveQueryDepth === 0) {
      this.interactiveIdleResolve?.()
      this.interactiveIdleResolve = null
    }
  }

  /**
   * WCDB 异步分页不允许重叠，所有会话读取都必须串行。
   *
   * 但**后台索引**与**交互查询**不能同权排队：追赶同步会在后台遍历上千个会话，
   * 交互读取排在它后面就会被拖成几十秒。因此分两条通道，交互读取优先于尚未开始的后台读取；
   * 交互查询最多只等"一个正在执行的读"（WCDB 不允许重叠，这点无法避免）。
   */
  private enqueueWcdbRead<T>(operation: () => Promise<T>, lane: WcdbReadLane = 'interactive'): Promise<T> {
    const enqueuedAt = Date.now()
    return new Promise<T>((resolve, reject) => {
      const pending: PendingWcdbRead = {
        high: lane === 'interactive',
        run: async () => {
          const startedAt = Date.now()
          this.wcdbQueueMsTotal += Math.max(0, startedAt - enqueuedAt)
          try {
            return await operation()
          } finally {
            this.wcdbExecutionMsTotal += Date.now() - startedAt
          }
        },
        resolve: resolve as (value: unknown) => void,
        reject
      }
      if (pending.high) {
        const firstBackground = this.wcdbPending.findIndex((item) => !item.high)
        if (firstBackground < 0) this.wcdbPending.push(pending)
        else this.wcdbPending.splice(firstBackground, 0, pending)
      } else {
        this.wcdbPending.push(pending)
      }
      this.drainWcdbReads()
    })
  }

  private drainWcdbReads(): void {
    if (this.wcdbReadBusy) return
    const next = this.wcdbPending.shift()
    if (!next) return
    this.wcdbReadBusy = true
    void next
      .run()
      .then(next.resolve, next.reject)
      .finally(() => {
        this.wcdbReadBusy = false
        this.drainWcdbReads()
      })
  }

  private emptyStatus(accountId: string): KnowledgeRuntimeStatus {
    return {
      accountId,
      state: 'unavailable',
      indexedMessageCount: 0,
      indexedChunkCount: 0,
      sourceMessageCount: null,
      processedMessages: 0,
      totalMessages: null,
      estimatedRemainingMs: null,
      databaseBytes: 0,
      walBytes: 0,
      shmBytes: 0,
      indexLatestAt: null,
      sourceLatestAt: null,
      pass: this.passSnapshot()
    }
  }

  private async refreshStatus(
    accountId: string,
    progress?: Pick<KnowledgeRuntimeStatus, 'processedMessages' | 'totalMessages'> & {
      startedAt?: number
    }
  ): Promise<KnowledgeRuntimeStatus> {
    const remote = await this.service.status({ accountId, fts: DEFAULT_KNOWLEDGE_FTS_CONFIG })
    const current = this.statusByAccount.get(accountId)
    const indexing = this.indexing.has(accountId)
    const pass = this.passProgress
    const processedMessages =
      progress?.processedMessages ?? current?.processedMessages ?? remote.processedMessages
    const totalMessages = progress?.totalMessages ?? remote.sourceMessageCount
    // 一遍 pass 结束后，worker 只知道「派生库能不能查」，不知道这一遍是**被取消**还是**出错**。
    // 这两个语义只在这里有（worker 侧的 run_state 已经落库），所以由本地 pass 覆盖，
    // 避免取消之后又冒充成一个干净的 ready。
    const state: KnowledgeRuntimeState = indexing
      ? remote.indexedMessageCount > 0
        ? 'syncing'
        : 'building'
      : pass && (pass.phase === 'cancelled' || pass.phase === 'error')
        ? pass.phase
        : remote.state
    const status: KnowledgeRuntimeStatus = {
      ...remote,
      state,
      processedMessages,
      totalMessages,
      estimatedRemainingMs: null,
      // 派生库自己看不到源数据；这里补上源侧最新活跃时间，UI 才能区分 READY 与 FRESH。
      sourceLatestAt: this.sourceLatestAt(),
      pass: this.passSnapshot()
    }
    this.publishStatus(status)
    return status
  }

  private publishStatus(status: KnowledgeRuntimeStatus): void {
    this.statusByAccount.set(status.accountId, status)
    for (const listener of this.statusListeners) listener(status)
  }
}
