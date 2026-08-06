/**
 * Contracts for the local, derived knowledge base. These values deliberately
 * contain no WCDB handles, Electron objects, database keys, or UI state so the
 * indexer can run in an isolated process.
 */

export const KNOWLEDGE_SCHEMA_VERSION = 1
export const DEFAULT_CHUNKER_VERSION = 'conversation-v1'

export type KnowledgeMessageKind = 'text' | 'voice' | 'file' | 'link' | 'system' | 'other'
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
}

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
}

export interface KnowledgeIndexRequest {
  accountId: string
  databaseRoot: string
  conversations: KnowledgeConversationInput[]
  chunker: KnowledgeChunkerConfig
  fts: KnowledgeFtsConfig
  /** Written only after a complete source pass; used for truthful coverage. */
  sourceMessageCount?: number
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
  score?: number
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
  /** Reading source message rows from matching chunks. */
  messageLoadMs: number
  /** Expanding chunk members, scoring terms and per-chunk de-duplication. */
  chunkExpandMs: number
  /** Final result ordering and limit application. */
  rankingMs: number
  /** Worker-side local search total. */
  totalMs: number
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
  timings: KnowledgeSearchTimings
  conversationRetrieval?: KnowledgeConversationRetrieval
  voiceCoverage?: KnowledgeVoiceCoverage
}

/** Renderer-facing request. Chat timestamps use Unix seconds in the existing UI. */
export interface KnowledgeSearchIpcRequest {
  text: string
  terms: string[]
  conversationIds?: string[]
  senderIds?: string[]
  startTime?: number
  endTime?: number
  limit?: number
}

export interface KnowledgeSearchIpcResult extends KnowledgeSearchResult {
  source: 'knowledge' | 'fallback'
  totalMessages: number
  fallbackReason?: 'unavailable' | 'indexing' | 'error'
}

export type KnowledgeRuntimeState = 'unavailable' | 'building' | 'syncing' | 'ready' | 'error'

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
}

export interface KnowledgeStatusRequest {
  accountId: string
  databaseRoot: string
  fts: KnowledgeFtsConfig
}

export interface KnowledgeWorkerRequest {
  version: 1
  type: 'index' | 'preflight' | 'search' | 'status' | 'remove' | 'cancel' | 'close'
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
    workerReceivedAt: number
    workerCompletedAt: number
    responseSerializeMs: number
  }
}

export const DEFAULT_KNOWLEDGE_CHUNKER: KnowledgeChunkerConfig = {
  version: DEFAULT_CHUNKER_VERSION,
  maxGapMs: 10 * 60 * 1000,
  maxMessages: 12,
  maxCharacters: 1200,
  overlapMessages: 3
}
