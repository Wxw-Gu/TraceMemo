/**
 * Contracts for the local, derived knowledge base. These values deliberately
 * contain no WCDB handles, Electron objects, database keys, or UI state so the
 * indexer can run in an isolated process.
 */

export const KNOWLEDGE_SCHEMA_VERSION = 1
export const DEFAULT_CHUNKER_VERSION = 'conversation-v1'

export type KnowledgeMessageKind = 'text' | 'voice' | 'file' | 'link' | 'image' | 'video' | 'sticker' | 'system' | 'other'
export type KnowledgeIndexPhase =
  | 'idle'
  | 'preflight'
  | 'indexing'
  | 'ready'
  | 'cancelled'
  | 'error'
export type KnowledgeTemporalIntent = 'none' | 'current' | 'historical' | 'timeline'
export type KnowledgeFtsTokenizer = 'unicode61' | 'trigram'
export type KnowledgeFtsContentMode = 'external' | 'internal'
export type KnowledgeFtsDetail = 'full' | 'column' | 'none'

export interface KnowledgeAttachmentMetadata {
  name: string
  kind?: 'file' | 'link' | 'image' | 'video' | 'other'
  url?: string
  sizeBytes?: number
}

/** A read-only source record prepared by the future WCDB adapter. */
export interface KnowledgeSourceMessage {
  accountId: string
  conversationId: string
  messageId: string
  /** Unix epoch milliseconds. Adapters must convert source-specific units. */
  createTime: number
  senderId?: string
  senderName?: string
  kind: KnowledgeMessageKind
  text?: string
  attachment?: KnowledgeAttachmentMetadata
  voiceTranscript?: string
  /** Local coverage state only. Error text is never copied into the index. */
  voiceTranscriptState?: 'pending' | 'transcribed' | 'failed'
  /**
   * 图片里的文字（本地 System OCR 的派生结果）。
   *
   * 与 voiceTranscript 同构：这是 **derived content**，原图片消息仍然是
   * authoritative source。它绝不写回 message.body，也绝不产生"OCR 消息"。
   */
  imageOcrText?: string
  /** 图片 OCR 的本地状态；与 voiceTranscriptState 一样不含错误正文。 */
  imageOcrState?: KnowledgeImageOcrState
}

/** 图片 OCR 的本地覆盖状态（错误详情绝不进索引）。 */
export type KnowledgeImageOcrState =
  | 'pending'
  | 'indexed'
  | 'empty'
  | 'metadata_missing'
  | 'image_missing'
  | 'decrypt_unavailable'
  | 'decrypt_failed'
  | 'decode_failed'
  | 'ocr_failed'
  | 'cancelled'

export interface KnowledgeNormalizedMessage extends KnowledgeSourceMessage {
  searchableText: string
  contentHash: string
}

export interface KnowledgeChunkerConfig {
  version: string
  maxGapMs: number
  maxMessages: number
  maxCharacters: number
  overlapMessages: number
}

export interface KnowledgeChunk {
  chunkId: string
  accountId: string
  conversationId: string
  startTime: number
  endTime: number
  text: string
  messageIds: string[]
  participantIds: string[]
  messageKinds: KnowledgeMessageKind[]
  contentHash: string
  chunkerVersion: string
}

/**
 * Every FTS choice is explicit. The first production profile must be selected
 * from the Task 0 report rather than being silently hard-coded in the UI.
 */
export interface KnowledgeFtsConfig {
  profileId: string
  tokenizer: KnowledgeFtsTokenizer
  contentMode: KnowledgeFtsContentMode
  detail: KnowledgeFtsDetail
  columnsize: 0 | 1
}

/**
 * Chosen after the realistic desensitized WeChat benchmark: trigram preserves
 * Chinese-substring recall while external content avoids a second text copy.
 */
export const DEFAULT_KNOWLEDGE_FTS_CONFIG: KnowledgeFtsConfig = {
  profileId: 'trigram-external-full-columnsize-v1',
  tokenizer: 'trigram',
  contentMode: 'external',
  detail: 'full',
  columnsize: 1
}

export interface KnowledgeConversationInput {
  conversationId: string
  /** true means this is a complete read-only snapshot of the conversation. */
  completeSnapshot: boolean
  messages: KnowledgeSourceMessage[]
  /**
   * 这个会话在**源侧**（WCDB Session.last_timestamp）已经覆盖到的最后活跃时间（epoch ms）。
   *
   * 与 `KnowledgeIndexRequest.sourceLatestAt` 的区别：后者是整遍 pass 级别的边界，这里是
   * per-conversation checkpoint —— 增量 pass 用它判断「这个会话有没有新消息」，
   * 从而跳过整个会话（不读 WCDB、不传 IPC、不写索引）。
   *
   * 记录**源侧**时间而不是「索引里最后一条可建模消息的时间」：否则最后一条恰好落在
   * 图片/空正文上的会话会永远被判定为「有新消息」，增量永远跳不过它。
   */
  sourceHighWaterTime?: number
}

export interface KnowledgeIndexRequest {
  accountId: string
  databaseRoot: string
  conversations: KnowledgeConversationInput[]
  chunker: KnowledgeChunkerConfig
  fts: KnowledgeFtsConfig
  /** Written only after a complete source pass; used for truthful coverage. */
  sourceMessageCount?: number
  /**
   * 这一遍完整 pass 实际扫到的源数据最新消息时间（epoch ms）。
   *
   * 与 `sourceMessageCount` 一样，只在读完全部会话的那一次写入。它是 freshness 的权威口径：
   * 拿它与当前源数据最新活跃时间比较，就能确定索引是否已经追上，而不必猜测派生索引的过滤落差。
   */
  sourceLatestAt?: number
}

export interface KnowledgeIndexProgress {
  accountId: string
  phase: KnowledgeIndexPhase
  conversationId?: string
  processedMessages: number
  totalMessages: number
  indexedChunks: number
  error?: string
}

export interface KnowledgeIndexResult {
  accountId: string
  processedMessages: number
  indexedChunks: number
  updatedChunks: number
  unchangedConversations: number
  databaseBytes: number
  walBytes: number
  elapsedMs: number
  cancelled: boolean
}

export interface KnowledgeCapacityPreflightRequest {
  accountId: string
  databaseRoot: string
  conversations: KnowledgeConversationInput[]
  chunker: KnowledgeChunkerConfig
  /** Optional free space supplied by the platform layer; this module never probes WCDB paths. */
  availableDiskBytes?: number
}

export interface KnowledgeCapacityPreflight {
  accountId: string
  sourceMessageCount: number
  indexableMessageCount: number
  indexableTextBytes: number
  voiceTranscriptCount: number
  attachmentMetadataCount: number
  sampledChunkCount: number
  estimatedChunkCount: number
  estimatedDatabaseBytesLow: number
  estimatedDatabaseBytesHigh: number
  estimatedBuildPeakBytesLow: number
  estimatedBuildPeakBytesHigh: number
  availableDiskBytes?: number
  hasSufficientDiskSpace?: boolean
  warnings: string[]
}

export interface KnowledgeEvidence {
  chunkId: string
  conversationId: string
  startTime: number
  endTime: number
  /** Stable source-message identity used by the archive jump action. */
  messageId: string
  senderId?: string
  sender: string
  /** Unix epoch milliseconds. */
  timestamp: number
  messageIds: string[]
  /** The source type belongs to the original message, not the retrieval method. */
  sourceKind: KnowledgeMessageKind
  text: string
  /**
   * 这条证据里「从图片里读出来的文字」（本地 System OCR 的派生结果）。
   *
   * 只用于**来源解释**：让用户/模型知道这段内容来自图片，而不是群友真的发了一条文字消息。
   * authoritative source 始终是原始图片消息 —— 这里不产生任何"OCR 消息"。
   */
  imageOcrText?: string
  /**
   * 命中所依赖的**派生来源**。
   *
   * 有值 = 这条结果依赖本地派生内容才能命中（而不是原始消息本身的文字）。
   * 与 `sourceKind` 正交：`sourceKind` 说的是原始消息是什么，这里说的是"靠什么搜到的"。
   */
  derivedSource?: 'image_ocr'
  score?: number
}

/**
 * 证据文本面向用户 / 模型时的可读化处理。
 *
 * `searchableText` 里的 `图片文字：` 只是索引期用来区分派生内容的内部标签，
 * 它**绝不能出现在 Evidence 里**：用户不该看到引擎内部前缀，
 * 而且"这段文字来自图片"应该由结构化的来源标记表达，而不是靠一个冒号前缀。
 */
export function toEvidenceDisplayText(searchableText: string): string {
  return searchableText
    .split('\n')
    .map((line) => line.replace(/^\s*(?:图片文字|OCR|system-ocr)\s*[：:]\s*/i, ''))
    .join('\n')
    .trim()
}

export interface KnowledgeVoiceCoverage {
  voiceMessageCount: number
  transcribedVoiceCount: number
  failedVoiceCount: number
  voiceCoverageComplete: boolean
}

/** A bounded, local summary of a single conversation retrieval. */
export interface KnowledgeConversationRetrieval {
  conversationId: string
  totalMessages: number
  chunkCount: number
  candidateMessages: number
  systemMessagesDeprioritized: number
  complete: boolean
}

export interface KnowledgeQuery {
  accountId: string
  text: string
  /** Query-router terms. The raw question remains available for diagnostics. */
  terms?: string[]
  limit: number
  conversationId?: string
  conversationIds?: string[]
  senderIds?: string[]
  /** Unix epoch milliseconds. */
  startTime?: number
  /** Unix epoch milliseconds. */
  endTime?: number
  temporalIntent?: KnowledgeTemporalIntent
  conversationBoundary?: 'first' | 'last'
}

export interface KnowledgeSearchRequest extends KnowledgeQuery {
  databaseRoot: string
  fts: KnowledgeFtsConfig
}

export type KnowledgeSearchState = 'unavailable' | 'indexing' | 'ready'

/** Measured in the Worker; never inferred from message counts or UI timers. */
export interface KnowledgeSearchTimings {
  /** Parent/child-process transport and host scheduling outside SQLite work. */
  workerIpcMs: number
  /** First request only: child process spawn and Node initialization until it received the request. */
  workerBootMs: number
  /** Parent send → Worker handler start. */
  dispatchMs: number
  /** Worker local SQLite/chunk work; equals the Worker-side search total. */
  workerSqlMs: number
  /** Worker response preparation → parent receipt; includes IPC serialization/transfer. */
  responseTransferMs: number
  /** Worker-side serialization preflight for the result payload. */
  responseSerializeMs: number
  /** FTS (or short-term database lookup) query time. */
  ftsMs: number
  /**
   * `ftsMs` 中**短词回退路径**（<3 字的中文词，走 `LIKE` 而非 FTS `MATCH`）占用的时间。
   *
   * 跨会话 lexical probe 里最常见的 2 字中文词只能走这条路径，没有这个分解就无法区分
   * 「FTS MATCH 慢」和「短词全表 LIKE 慢」。
   */
  shortTermSearchMs?: number
  /**
   * `getSearchStatus()`（含统计快照判定）占用的时间。
   * 用于验证「搜索热路径不再做全表聚合」这一性能约束没有被回退。
   */
  statusMs?: number
  /** Reading source message rows from matching chunks. */
  messageLoadMs: number
  /** Expanding chunk members, scoring terms and per-chunk de-duplication. */
  chunkExpandMs: number
  /** Final result ordering and limit application. */
  rankingMs: number
  /** Worker-side local search total. */
  totalMs: number
  /** Time spent refreshing a stale on-disk statistics snapshot. */
  globalCountMs?: number
  /** Voice coverage aggregation time for this query. */
  voiceCoverageMs?: number
  /** Full Worker handler execution, including status and coverage bookkeeping. */
  workerExecutionMs?: number
  /** Worker queue wait in the main-process host, when observable. */
  workerQueueMs?: number
  /** Main-process WCDB FIFO wait, when observable. */
  wcdbQueueMs?: number
  /** Main-process WCDB operation execution, when observable. */
  wcdbExecutionMs?: number
  /** Main-process sender/contact enrichment duration. */
  senderEnrichmentMs?: number
  /** Main-process IPC/transport duration, when separated from Worker execution. */
  ipcMs?: number
  /** Serialization/encoding duration outside the Worker SQL timer. */
  serializationMs?: number
  /** Other unclassified waiting in the retrieval path. */
  otherMs?: number
}

export const emptyKnowledgeSearchTimings = (): KnowledgeSearchTimings => ({
  workerIpcMs: 0,
  workerBootMs: 0,
  dispatchMs: 0,
  workerSqlMs: 0,
  responseTransferMs: 0,
  responseSerializeMs: 0,
  ftsMs: 0,
  messageLoadMs: 0,
  chunkExpandMs: 0,
  rankingMs: 0,
  totalMs: 0
})

export interface KnowledgeSearchResult {
  state: KnowledgeSearchState
  evidence: KnowledgeEvidence[]
  indexedMessageCount: number
  indexedChunkCount: number
  /**
   * 派生索引里最新的消息时间（epoch ms）；null 表示无法判定。
   *
   * `state: 'ready'` 只说明「这个派生库可以被查询」，**不等于**它已经追到源数据最新位置。
   * 调用方必须把它与请求的时间范围比较，才能判断本次检索是否覆盖了用户问的时间。
   */
  indexLatestAt: number | null
  timings: KnowledgeSearchTimings
  conversationRetrieval?: KnowledgeConversationRetrieval
  voiceCoverage?: KnowledgeVoiceCoverage
}

/** Renderer-facing request. Chat timestamps use Unix seconds in the existing UI. */
export interface KnowledgeSearchIpcRequest {
  text: string
  terms: string[]
  /** Bounded request/session cache key for sender enrichment only. */
  retrievalSessionId?: string
  conversationIds?: string[]
  senderIds?: string[]
  startTime?: number
  endTime?: number
  conversationBoundary?: 'first' | 'last'
  limit?: number
}

export interface KnowledgeSearchIpcResult extends KnowledgeSearchResult {
  source: 'knowledge' | 'fallback'
  totalMessages: number
  fallbackReason?: 'unavailable' | 'indexing' | 'error'
  /**
   * 源数据（WCDB Session）里最新的活跃时间（epoch ms）；null 表示无法判定。
   *
   * 与 `indexLatestAt` 一起构成 freshness 判据：`sourceLatestAt > indexLatestAt`
   * 说明源数据里已经有了索引还没覆盖的内容。
   */
  sourceLatestAt: number | null
}

export type KnowledgeRuntimeState = 'unavailable' | 'building' | 'syncing' | 'ready' | 'error' | 'cancelled'

/**
 * 一次后台索引 pass 的真实进度（ADDITIVE）。
 *
 * 与新鲜度（`indexLatestAt` / `sourceLatestAt`）回答的是不同问题：这里描述这一遍**在做什么、
 * 扫了多少、真正写了多少**。
 */
export interface KnowledgePassProgress {
  /**
   * 这一遍在做什么：
   * - `full`     首次全量建立（还没有任何可用分片）
   * - `catchup`  追最新：已建立 checkpoint 的会话出现了新消息
   * - `backfill` 补历史：从来没有 checkpoint 的会话（历史缺口）
   * - `cancelled` / `error` / `idle`
   */
  phase: 'idle' | 'full' | 'catchup' | 'backfill' | 'cancelled' | 'error'
  /** 现在是否可以取消（真实在跑且未收到取消请求时才是 true）。 */
  cancellable: boolean
  /** 开始时间（epoch ms）。 */
  startedAt: number
  /** 这一遍从 WCDB **读取/扫描**的源消息条数（含被可索引性过滤掉的）。 */
  scannedMessages: number
  /** 这一遍真正**进入索引**的源消息条数。 */
  indexedMessages: number
  processedConversations: number
  totalConversations: number
  /** 因为「没有任何新消息」而整段跳过的会话数（增量 pass 的核心指标）。 */
  skippedConversations: number
  /** 需要「追最新」的会话数（已建立 checkpoint，且源侧有更新）。 */
  catchupConversations: number
  /** 需要「补历史」的会话数（从来没有 checkpoint，必须整段读）。 */
  backfillConversations: number
  /** 这一遍已经补齐的历史会话数。 */
  backfillCompletedConversations: number
  /** 主线程 event loop 在这一遍期间的最大滞后。用于验证重活没有压在 Main 上。 */
  mainLoopLagMs: number
}

export interface KnowledgeRuntimeStatus {
  accountId: string
  state: KnowledgeRuntimeState
  indexedMessageCount: number
  indexedChunkCount: number
  /** Null means this source pass has not yet counted every source message. */
  sourceMessageCount: number | null
  processedMessages: number
  totalMessages: number | null
  currentConversationId?: string
  /** Null is displayed as unavailable rather than a fabricated ETA. */
  estimatedRemainingMs: number | null
  databaseBytes: number
  walBytes: number
  shmBytes: number
  lastError?: string
  /**
   * 派生索引里最新的消息时间（epoch ms）；null 表示无法判定。
   * `state: 'ready'`（READY）与「已追到源数据最新」（FRESH）是两个概念，它就是两者的判据之一。
   */
  indexLatestAt: number | null
  /** 源数据（WCDB Session）最新活跃时间（epoch ms）；null 表示无法判定。 */
  sourceLatestAt: number | null
  /**
   * 当前/最近一次后台索引 pass 的真实进度（ADDITIVE）。
   *
   * 与 `indexLatestAt` 是**两个不同维度**：前者回答"这一遍在补什么、进度多少"，
   * 后者回答"索引已经覆盖到源数据的哪个时刻"。UI 不能再用一个「已同步」把两者混为一谈。
   */
  pass?: KnowledgePassProgress
}

export interface KnowledgeStatusRequest {
  accountId: string
  databaseRoot: string
  fts: KnowledgeFtsConfig
}

/**
 * 索引「已覆盖到的源数据时间」与源数据「当前最新活跃时间」之间允许的固定落差。
 *
 * 两侧都来自消息的 create_time（索引侧 = 完整 pass 扫到的最大 create_time，
 * 源侧 = Session 行的 last_timestamp），用于吸收 Session 元数据晚于消息落库的漂移。
 * main 与 renderer 共用这一份定义，避免 UI 与 Engine 的 freshness 口径漂移。
 */
export const KNOWLEDGE_FRESHNESS_TOLERANCE_MS = 60 * 1000

/**
 * 索引是否已经追到源数据最新（FRESH）。
 *
 * 注意与 `state === 'ready'`（READY：这个派生库**可以被查询**）区分：
 * READY 不代表 FRESH。任一侧口径缺失时返回 null 表示无法判定。
 */
export function isKnowledgeFresh(
  status: Pick<KnowledgeRuntimeStatus, 'indexLatestAt' | 'sourceLatestAt'>
): boolean | null {
  if (status.indexLatestAt === null || status.sourceLatestAt === null) return null
  return status.indexLatestAt + KNOWLEDGE_FRESHNESS_TOLERANCE_MS >= status.sourceLatestAt
}

export interface KnowledgeWorkerRequest {
  version: 1
  type: 'index' | 'preflight' | 'search' | 'status' | 'remove' | 'cancel' | 'close' | 'highWater'
  requestId: string
  /** Parent monotonic wall-clock used only for transport timing. */
  sentAt?: number
  payload:
    | KnowledgeIndexRequest
    | KnowledgeCapacityPreflightRequest
    | KnowledgeSearchRequest
    | KnowledgeStatusRequest
    | { accountId: string; databaseRoot: string }
    | { targetRequestId: string }
    | Record<string, never>
}

export interface KnowledgeWorkerResponse {
  version: 1
  type: 'progress' | 'result' | 'error'
  requestId: string
  payload?:
    | KnowledgeIndexProgress
    | KnowledgeIndexResult
    | KnowledgeCapacityPreflight
    | KnowledgeSearchResult
    | KnowledgeRuntimeStatus
    | { removed: true }
  error?: string
  transport?: {
    /** IPC message arrival timestamp in the Worker event loop. */
    messageReceivedAt?: number
    workerReceivedAt: number
    workerCompletedAt: number
    responseSerializeMs: number
    workerQueueMs?: number
  }
}

export const DEFAULT_KNOWLEDGE_CHUNKER: KnowledgeChunkerConfig = {
  version: DEFAULT_CHUNKER_VERSION,
  maxGapMs: 10 * 60 * 1000,
  maxMessages: 12,
  maxCharacters: 1200,
  overlapMessages: 3
}
