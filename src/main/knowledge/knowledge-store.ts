import { createHash } from 'crypto'
import { existsSync, mkdirSync, rmSync, statSync } from 'fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join, resolve } from 'path'
import type {
  KnowledgeCapacityPreflight,
  KnowledgeCapacityPreflightRequest,
  KnowledgeChunk,
  KnowledgeConversationRetrieval,
  KnowledgeEvidence,
  KnowledgeVoiceCoverage,
  KnowledgeFtsConfig,
  KnowledgeIndexProgress,
  KnowledgeIndexRequest,
  KnowledgeIndexResult,
  KnowledgeRuntimeStatus,
  KnowledgeNormalizedMessage,
  KnowledgeQuery,
  KnowledgeSearchTimings,
  KnowledgeSearchResult
} from '../../shared/knowledge'
import { emptyKnowledgeSearchTimings, KNOWLEDGE_SCHEMA_VERSION } from '../../shared/knowledge'
import { chunkConversation } from './chunker'
import { normalizeKnowledgeMessage } from './normalizer'

type DbRow = Record<string, unknown>

const YIELD_EVERY = 500
const MAX_SAFE_ACCOUNT_SEGMENT = /^[a-f0-9]{32}$/
const MAX_CONVERSATION_SUMMARY_SOURCE_MESSAGES = 2_000
const MAX_CONVERSATION_SUMMARY_CANDIDATES = 60
const CONVERSATION_SUMMARY_MAX_MESSAGES_PER_CHUNK = 24
const CONVERSATION_SUMMARY_GAP_MS = 2 * 60 * 60 * 1000

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function asRows(value: unknown): DbRow[] {
  return Array.isArray(value) ? (value as DbRow[]) : []
}

function encodedJson(value: unknown): string {
  return JSON.stringify(value)
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function normalizeComparable(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/g, '')
}

function normalizedQueryTerms(query: KnowledgeQuery): string[] {
  // An explicit empty term list means this is a person/session/time-only
  // query. Omitted terms retain the legacy direct-text behavior for callers.
  const values = query.terms === undefined ? [query.text] : query.terms
  return Array.from(
    new Set(
      values
        .map((value) => value.trim())
        .filter((value) => value.length >= 2 && value.length <= 160)
    )
  ).slice(0, 16)
}

function isTrigramEligible(term: string): boolean {
  const searchableCharacters = Array.from(term.replace(/[^\p{L}\p{N}_]+/gu, ''))
  return searchableCharacters.length >= 3
}

function messageTermScore(text: string, terms: string[]): number {
  const normalizedText = normalizeComparable(text)
  return terms.reduce((score, term) => {
    const comparable = normalizeComparable(term)
    return comparable && normalizedText.includes(comparable) ? score + comparable.length : score
  }, 0)
}

function waitForWorkerTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/** The on-disk directory never exposes the account identifier directly. */
export function knowledgeAccountKey(accountId: string): string {
  return digest(`knowledge-account-v1:${accountId}`).slice(0, 32)
}

export function getKnowledgeDatabasePath(databaseRoot: string, accountId: string): string {
  const accountKey = knowledgeAccountKey(accountId)
  if (!MAX_SAFE_ACCOUNT_SEGMENT.test(accountKey)) throw new Error('Invalid knowledge account key')
  return join(resolve(databaseRoot), accountKey, 'knowledge.sqlite')
}

export function removeKnowledgeDatabase(databaseRoot: string, accountId: string): void {
  const databasePath = getKnowledgeDatabasePath(databaseRoot, accountId)
  // Only remove known derived files; never recurse into, inspect, or modify the source archive.
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${databasePath}${suffix}`, { force: true })
}

function ftsTokenize(config: KnowledgeFtsConfig): string {
  return config.tokenizer === 'trigram' ? 'trigram' : 'unicode61 remove_diacritics 2'
}

function ftsConfigFingerprint(config: KnowledgeFtsConfig): string {
  return digest(JSON.stringify(config))
}

function normalizeFtsQuery(value: string, config: KnowledgeFtsConfig): string {
  const terms = value
    // FTS5 MATCH has its own punctuation grammar. URLs, file names and paths
    // are ordinary WeChat search inputs, so turn separators into independent
    // safe terms instead of passing `/`, `:`, `-`, or `.` through to MATCH.
    .replace(/[^\p{L}\p{N}_]+/gu, ' ')
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean)
    .slice(0, 12)
  if (config.detail === 'full') {
    return terms.map((term) => `"${term.replace(/"/g, ' ')}"`).join(' OR ')
  }
  // detail=column/none does not retain positional data. Avoid passing a
  // multi-token phrase to FTS5; a single trigram still gives a valid, lower-
  // fidelity candidate set for this benchmark profile.
  const tokens = terms
    .map((term) => {
      if (config.tokenizer !== 'trigram') return term
      const characters = Array.from(term)
      return characters.length >= 3 ? characters.slice(0, 3).join('') : ''
    })
    .filter(Boolean)
  return Array.from(new Set(tokens)).join(' OR ')
}

export class KnowledgeStore {
  private readonly database: DatabaseSync
  private readonly databasePath: string
  private readonly ftsExternalContent: boolean
  private pendingStatsRefreshMs = 0

  constructor(
    private readonly databaseRoot: string,
    private readonly accountId: string,
    private readonly fts: KnowledgeFtsConfig
  ) {
    this.databasePath = getKnowledgeDatabasePath(databaseRoot, accountId)
    mkdirSync(dirname(this.databasePath), { recursive: true, mode: 0o700 })
    this.database = new DatabaseSync(this.databasePath)
    this.ftsExternalContent = fts.contentMode === 'external'
    this.initialize()
  }

  close(): void {
    this.database.close()
  }

  get path(): string {
    return this.databasePath
  }

  getStorageStats(): {
    databaseBytes: number
    walBytes: number
    shmBytes: number
    pageSize: number
    pageCount: number
    freelistCount: number
  } {
    const pageSize = Number((this.database.prepare('PRAGMA page_size').get() as DbRow).page_size)
    const pageCount = Number((this.database.prepare('PRAGMA page_count').get() as DbRow).page_count)
    const freelistCount = Number(
      (this.database.prepare('PRAGMA freelist_count').get() as DbRow).freelist_count
    )
    const shmPath = `${this.databasePath}-shm`
    return {
      databaseBytes: this.databaseBytes(),
      walBytes: this.walBytes(),
      shmBytes: existsSync(shmPath) ? statSync(shmPath).size : 0,
      pageSize,
      pageCount,
      freelistCount
    }
  }

  /** Flush WAL into the main derived database before reporting final size. */
  checkpoint(): void {
    this.database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  }

  async index(
    request: Pick<KnowledgeIndexRequest, 'conversations' | 'chunker'> & {
      sourceMessageCount?: number
    },
    signal?: AbortSignal,
    onProgress?: (progress: KnowledgeIndexProgress) => void
  ): Promise<KnowledgeIndexResult> {
    const startedAt = Date.now()
    const totalMessages = request.conversations.reduce(
      (total, conversation) => total + conversation.messages.length,
      0
    )
    let processedMessages = 0
    let indexedChunks = 0
    let updatedChunks = 0
    let unchangedConversations = 0
    this.markStatsStale()
    this.setRunState('indexing')
    try {
      for (const conversation of request.conversations) {
        this.assertNotAborted(signal)
        const result = await this.indexConversation(
          conversation,
          request.chunker,
          signal,
          (processed, chunks) => {
            onProgress?.({
              accountId: this.accountId,
              phase: 'indexing',
              conversationId: conversation.conversationId,
              processedMessages: processedMessages + processed,
              totalMessages,
              indexedChunks: indexedChunks + chunks
            })
          }
        )
        processedMessages += conversation.messages.length
        indexedChunks += result.chunkCount
        updatedChunks += result.updatedChunks
        if (!result.updatedChunks) unchangedConversations += 1
        onProgress?.({
          accountId: this.accountId,
          phase: 'indexing',
          conversationId: conversation.conversationId,
          processedMessages,
          totalMessages,
          indexedChunks
        })
        await waitForWorkerTurn()
      }
      if (request.sourceMessageCount !== undefined) {
        this.writeMeta('source_message_count', String(request.sourceMessageCount))
        this.refreshStatsSnapshot()
      }
      this.setRunState('ready')
      return {
        accountId: this.accountId,
        processedMessages,
        indexedChunks,
        updatedChunks,
        unchangedConversations,
        databaseBytes: this.databaseBytes(),
        walBytes: this.walBytes(),
        elapsedMs: Date.now() - startedAt,
        cancelled: false
      }
    } catch (error) {
      const cancelled = signal?.aborted === true
      this.setRunState(
        cancelled ? 'cancelled' : 'error',
        error instanceof Error ? error.message : String(error)
      )
      // Per-conversation transactions may already have committed. Keep the
      // snapshot stale so the next status/search/open reconciles it once.
      if (cancelled) {
        return {
          accountId: this.accountId,
          processedMessages,
          indexedChunks,
          updatedChunks,
          unchangedConversations,
          databaseBytes: this.databaseBytes(),
          walBytes: this.walBytes(),
          elapsedMs: Date.now() - startedAt,
          cancelled: true
        }
      }
      throw error
    }
  }

  async preflight(
    request: Pick<
      KnowledgeCapacityPreflightRequest,
      'conversations' | 'chunker' | 'availableDiskBytes'
    >
  ): Promise<KnowledgeCapacityPreflight> {
    return estimateKnowledgeCapacityPreflight({
      ...request,
      accountId: this.accountId,
      databaseRoot: this.databaseRoot
    })
  }

  getSearchStatus(): Omit<KnowledgeSearchResult, 'evidence'> {
    this.ensureStatsSnapshot()
    const indexedMessageCount = this.readStatNumber('stats_message_count')
    const indexedChunkCount = this.readStatNumber('stats_chunk_count')
    const runState = this.readMeta('run_state')
    return {
      state:
        runState === 'indexing'
          ? 'indexing'
          : runState === 'ready' && indexedChunkCount > 0
            ? 'ready'
            : 'unavailable',
      indexedMessageCount,
      indexedChunkCount,
      timings: emptyKnowledgeSearchTimings()
    }
  }

  getRuntimeStatus(): KnowledgeRuntimeStatus {
    const search = this.getSearchStatus()
    const storage = this.getStorageStats()
    const sourceRaw = this.readMeta('source_message_count')
    const sourceMessageCount =
      sourceRaw && Number.isFinite(Number(sourceRaw)) ? Number(sourceRaw) : null
    const runState = this.readMeta('run_state')
    const error = this.readMeta('run_error') || undefined
    return {
      accountId: this.accountId,
      state: runState === 'error' ? 'error' : search.state === 'ready' ? 'ready' : 'unavailable',
      indexedMessageCount: search.indexedMessageCount,
      indexedChunkCount: search.indexedChunkCount,
      sourceMessageCount,
      processedMessages: search.indexedMessageCount,
      totalMessages: sourceMessageCount,
      estimatedRemainingMs: null,
      databaseBytes: storage.databaseBytes,
      walBytes: storage.walBytes,
      shmBytes: storage.shmBytes,
      lastError: error
    }
  }

  search(query: KnowledgeQuery): KnowledgeEvidence[] {
    return this.searchMeasured(query).evidence
  }

  private searchMeasured(query: KnowledgeQuery): {
    evidence: KnowledgeEvidence[]
    timings: KnowledgeSearchTimings
    conversationRetrieval?: KnowledgeConversationRetrieval
  } {
    const startedAt = Date.now()
    let ftsMs = 0
    let messageLoadMs = 0
    let chunkExpandMs = 0
    let rankingMs = 0
    if (query.accountId !== this.accountId)
      throw new Error('Knowledge query account does not match database')
    const terms = normalizedQueryTerms(query)
    const conversationIds = Array.from(
      new Set([
        ...(query.conversationIds || []),
        ...(query.conversationId ? [query.conversationId] : [])
      ])
    ).filter(Boolean)
    const senderIds = new Set(query.senderIds || [])
    if (!terms.length) {
      const messageLoadStartedAt = Date.now()
      const metadata = this.searchByMetadata(query, conversationIds, senderIds)
      messageLoadMs = Date.now() - messageLoadStartedAt
      return {
        evidence: metadata.evidence,
        conversationRetrieval: metadata.conversationRetrieval,
        timings: {
          ...emptyKnowledgeSearchTimings(),
          messageLoadMs,
          totalMs: Date.now() - startedAt
        }
      }
    }
    const ftsTerms = this.fts.tokenizer === 'trigram' ? terms.filter(isTrigramEligible) : terms
    const match = normalizeFtsQuery(ftsTerms.join(' '), this.fts)
    const clauses = match ? ['knowledge_fts MATCH ?'] : []
    const values: (string | number)[] = match ? [match] : []
    if (conversationIds.length) {
      clauses.push(`c.conversation_id IN (${conversationIds.map(() => '?').join(', ')})`)
      values.push(...conversationIds)
    }
    if (query.startTime !== undefined) {
      clauses.push('c.end_time >= ?')
      values.push(query.startTime)
    }
    if (query.endTime !== undefined) {
      clauses.push('c.start_time <= ?')
      values.push(query.endTime)
    }
    const ftsStartedAt = Date.now()
    const chunks = match
      ? asRows(
          this.database
            .prepare(
              `SELECT c.chunk_id, c.conversation_id, c.start_time, c.end_time, c.message_ids_json,
                      bm25(knowledge_fts) AS score
               FROM knowledge_fts
               JOIN knowledge_chunks c ON c.rowid = knowledge_fts.rowid
               WHERE ${clauses.join(' AND ')}
               ORDER BY score, c.end_time DESC
               LIMIT ?`
            )
            .all(...values, Math.max(1, Math.min(query.limit * 4, 100)))
        )
      : []
    ftsMs = Date.now() - ftsStartedAt
    const evidenceByMessage = new Map<string, KnowledgeEvidence>()
    for (const chunk of chunks) {
      const chunkExpandStartedAt = Date.now()
      const conversationId = String(chunk.conversation_id)
      const messageIds = JSON.parse(String(chunk.message_ids_json)) as string[]
      const messageLoadStartedAt = Date.now()
      const messages = asRows(
        this.database
          .prepare(
            `SELECT message_id, create_time, searchable_text, kind, sender_id, sender_name
             FROM knowledge_messages
             WHERE conversation_id = ? AND message_id IN (${messageIds.map(() => '?').join(', ')})`
          )
          .all(conversationId, ...messageIds)
      )
      messageLoadMs += Date.now() - messageLoadStartedAt
      const ranked = messages
        .filter((message) => !senderIds.size || senderIds.has(String(message.sender_id || '')))
        .map((message) => ({
          row: message,
          termScore: messageTermScore(String(message.searchable_text), terms)
        }))
        .filter((item) => item.termScore > 0 || senderIds.size > 0)
        .sort(
          (left, right) =>
            right.termScore - left.termScore ||
            Number(right.row.create_time) - Number(left.row.create_time)
        )
      for (const item of ranked) {
        const row = item.row
        const messageId = String(row.message_id)
        const identity = `${conversationId}\u0000${messageId}`
        if (evidenceByMessage.has(identity)) continue
        evidenceByMessage.set(identity, {
          chunkId: String(chunk.chunk_id),
          conversationId,
          startTime: Number(chunk.start_time),
          endTime: Number(chunk.end_time),
          messageId,
          senderId: row.sender_id ? String(row.sender_id) : undefined,
          sender: String(row.sender_name || row.sender_id || '未知成员'),
          timestamp: Number(row.create_time),
          messageIds,
          sourceKind: String(row.kind) as KnowledgeEvidence['sourceKind'],
          text: String(row.searchable_text),
          score: Number(chunk.score) - item.termScore / 1000
        })
      }
      chunkExpandMs += Date.now() - chunkExpandStartedAt
    }
    if (!chunks.length && this.fts.tokenizer === 'trigram') {
      const shortTermStartedAt = Date.now()
      for (const item of this.searchShortTerms(query, terms, conversationIds, senderIds)) {
        evidenceByMessage.set(`${item.conversationId}\u0000${item.messageId}`, item)
      }
      // The trigram short-term fallback uses a real local SQLite query but not MATCH.
      ftsMs += Date.now() - shortTermStartedAt
    }
    const rankingStartedAt = Date.now()
    const evidence = Array.from(evidenceByMessage.values())
      .sort(
        (left, right) => (left.score ?? 0) - (right.score ?? 0) || right.timestamp - left.timestamp
      )
      .slice(0, Math.max(1, Math.min(query.limit, 100)))
    rankingMs = Date.now() - rankingStartedAt
    return {
      evidence,
      timings: {
        ...emptyKnowledgeSearchTimings(),
        ftsMs,
        messageLoadMs,
        chunkExpandMs,
        rankingMs,
        totalMs: Date.now() - startedAt
      }
    }
  }

  private searchShortTerms(
    query: KnowledgeQuery,
    terms: string[],
    conversationIds: string[],
    senderIds: Set<string>
  ): KnowledgeEvidence[] {
    const shortTerms = terms.filter((term) => !isTrigramEligible(term))
    if (!shortTerms.length) return []
    const clauses = ['1 = 1']
    const values: (string | number)[] = []
    if (conversationIds.length) {
      clauses.push(`m.conversation_id IN (${conversationIds.map(() => '?').join(', ')})`)
      values.push(...conversationIds)
    }
    if (query.startTime !== undefined) {
      clauses.push('m.create_time >= ?')
      values.push(query.startTime)
    }
    if (query.endTime !== undefined) {
      clauses.push('m.create_time <= ?')
      values.push(query.endTime)
    }
    if (senderIds.size) {
      clauses.push(
        `m.sender_id IN (${Array.from(senderIds)
          .map(() => '?')
          .join(', ')})`
      )
      values.push(...senderIds)
    }
    clauses.push(
      `(${shortTerms.map(() => 'm.searchable_text LIKE ? COLLATE NOCASE').join(' OR ')})`
    )
    values.push(...shortTerms.map((term) => `%${term}%`))
    values.push(Math.max(1, Math.min(query.limit, 100)))
    return asRows(
      this.database
        .prepare(
          `SELECT m.conversation_id, m.message_id, m.create_time, m.searchable_text, m.kind, m.sender_id, m.sender_name
           FROM knowledge_messages m
           WHERE ${clauses.join(' AND ')}
           ORDER BY m.create_time DESC
           LIMIT ?`
        )
        .all(...values)
    )
      .map((row) => ({
        messageId: String(row.message_id),
        text: String(row.searchable_text),
        termScore: messageTermScore(String(row.searchable_text), shortTerms),
        row
      }))
      .sort(
        (left, right) =>
          right.termScore - left.termScore ||
          Number(right.row.create_time) - Number(left.row.create_time)
      )
      .map(({ messageId, text, row, termScore }) => ({
        chunkId: `short-exact:${String(row.conversation_id)}:${messageId}`,
        conversationId: String(row.conversation_id),
        startTime: Number(row.create_time),
        endTime: Number(row.create_time),
        messageId,
        senderId: row.sender_id ? String(row.sender_id) : undefined,
        sender: String(row.sender_name || row.sender_id || '未知成员'),
        timestamp: Number(row.create_time),
        messageIds: [messageId],
        sourceKind: String(row.kind) as KnowledgeEvidence['sourceKind'],
        text,
        score: -termScore / 1000
      }))
  }

  private searchByMetadata(
    query: KnowledgeQuery,
    conversationIds: string[],
    senderIds: Set<string>
  ): {
    evidence: KnowledgeEvidence[]
    conversationRetrieval?: KnowledgeConversationRetrieval
  } {
    const clauses = ['1 = 1']
    const values: (string | number)[] = []
    if (conversationIds.length) {
      clauses.push(`m.conversation_id IN (${conversationIds.map(() => '?').join(', ')})`)
      values.push(...conversationIds)
    }
    if (query.startTime !== undefined) {
      clauses.push('m.create_time >= ?')
      values.push(query.startTime)
    }
    if (query.endTime !== undefined) {
      clauses.push('m.create_time <= ?')
      values.push(query.endTime)
    }
    if (senderIds.size) {
      clauses.push(
        `m.sender_id IN (${Array.from(senderIds)
          .map(() => '?')
          .join(', ')})`
      )
      values.push(...senderIds)
    }
    const singleConversation = conversationIds.length === 1 && senderIds.size === 0
    if (singleConversation) {
      const count = this.database
        .prepare(
          `SELECT COUNT(*) AS total FROM knowledge_messages m WHERE ${clauses.join(' AND ')}`
        )
        .get(...values) as DbRow | undefined
      const totalMessages = Number(count?.total || 0)
      const rows = asRows(
        this.database
          .prepare(
            `SELECT m.conversation_id, m.message_id, m.create_time, m.searchable_text, m.kind,
                    m.sender_id, m.sender_name
             FROM knowledge_messages m
             WHERE ${clauses.join(' AND ')}
             ORDER BY m.create_time ASC
             LIMIT ?`
          )
          .all(...values, MAX_CONVERSATION_SUMMARY_SOURCE_MESSAGES)
      )
      const chunks: DbRow[][] = []
      for (const row of rows) {
        const previous = chunks.at(-1)?.at(-1)
        const isNewChunk =
          !previous ||
          Number(row.create_time) - Number(previous.create_time) > CONVERSATION_SUMMARY_GAP_MS ||
          chunks.at(-1)!.length >= CONVERSATION_SUMMARY_MAX_MESSAGES_PER_CHUNK
        if (isNewChunk) chunks.push([])
        chunks.at(-1)!.push(row)
      }
      const representativesByChunk: Array<Array<{ row: DbRow; chunk: DbRow[] }>> = []
      for (const chunk of chunks) {
        const preferred = chunk.filter((row) => String(row.kind) !== 'system')
        const pool = preferred.length ? preferred : chunk
        const ranked = [...pool].sort(
          (left, right) =>
            String(right.searchable_text).length - String(left.searchable_text).length ||
            Number(right.create_time) - Number(left.create_time)
        )
        const representatives = [ranked[0], pool[0], pool.at(-1)].filter(
          (row, index, items): row is DbRow => Boolean(row) && items.indexOf(row) === index
        )
        representativesByChunk.push(representatives.map((row) => ({ row, chunk })))
      }
      // Preserve at least one representative from every time slice before
      // adding a second/third. A simple first-60 cap would silently discard
      // the latest slices in long conversations, which is the opposite of a
      // useful "最近聊了什么" recap.
      const selected: Array<{ row: DbRow; chunk: DbRow[] }> = []
      for (
        let representativeIndex = 0;
        selected.length < MAX_CONVERSATION_SUMMARY_CANDIDATES;
        representativeIndex += 1
      ) {
        let added = false
        for (const representatives of representativesByChunk) {
          const representative = representatives[representativeIndex]
          if (representative && selected.length < MAX_CONVERSATION_SUMMARY_CANDIDATES) {
            selected.push(representative)
            added = true
          }
        }
        if (!added) break
      }
      const systemMessagesDeprioritized = rows.filter((row) => String(row.kind) === 'system').length
      return {
        evidence: selected.map(({ row, chunk }) => this.metadataEvidence(row, chunk)),
        conversationRetrieval: {
          conversationId: conversationIds[0],
          totalMessages,
          chunkCount: chunks.length,
          candidateMessages: selected.length,
          systemMessagesDeprioritized,
          complete: totalMessages <= MAX_CONVERSATION_SUMMARY_SOURCE_MESSAGES
        }
      }
    }
    values.push(Math.max(1, Math.min(query.limit, 100)))
    return {
      evidence: asRows(
        this.database
          .prepare(
            `SELECT m.conversation_id, m.message_id, m.create_time, m.searchable_text, m.kind, m.sender_id, m.sender_name
           FROM knowledge_messages m
           WHERE ${clauses.join(' AND ')}
           ORDER BY m.create_time DESC
           LIMIT ?`
          )
          .all(...values)
      ).map((row) => this.metadataEvidence(row))
    }
  }

  private metadataEvidence(row: DbRow, chunk?: DbRow[]): KnowledgeEvidence {
    const messageId = String(row.message_id)
    const first = chunk?.[0]
    const last = chunk?.at(-1)
    return {
      chunkId: chunk
        ? `conversation-summary:${String(row.conversation_id)}:${Number(first?.create_time || row.create_time)}`
        : `metadata:${String(row.conversation_id)}:${messageId}`,
      conversationId: String(row.conversation_id),
      startTime: Number(first?.create_time || row.create_time),
      endTime: Number(last?.create_time || row.create_time),
      messageId,
      senderId: row.sender_id ? String(row.sender_id) : undefined,
      sender: String(row.sender_name || row.sender_id || '未知成员'),
      timestamp: Number(row.create_time),
      messageIds: chunk ? chunk.map((item) => String(item.message_id)) : [messageId],
      sourceKind: String(row.kind) as KnowledgeEvidence['sourceKind'],
      text: String(row.searchable_text),
      score: String(row.kind) === 'system' ? 1 : 0
    }
  }

  searchWithStatus(query: KnowledgeQuery): KnowledgeSearchResult {
    const startedAt = Date.now()
    const status = this.getSearchStatus()
    const measured = status.indexedChunkCount > 0 ? this.searchMeasured(query) : null
    const voiceStartedAt = Date.now()
    const voiceCoverage = this.getVoiceCoverage(query)
    const voiceCoverageMs = Date.now() - voiceStartedAt
    const workerExecutionMs = Date.now() - startedAt
    const statsRefreshMs = this.consumeStatsRefreshMs()
    return {
      ...status,
      // A long incremental pass can already have durable chunks. Those chunks are
      // safe to query and avoid falling back to a second scan of the source archive.
      evidence: measured?.evidence || [],
      timings: {
        ...(measured?.timings || emptyKnowledgeSearchTimings()),
        totalMs: workerExecutionMs,
        globalCountMs: statsRefreshMs,
        voiceCoverageMs,
        workerExecutionMs
      },
      conversationRetrieval: measured?.conversationRetrieval,
      voiceCoverage
    }
  }

  private getVoiceCoverage(query: KnowledgeQuery): KnowledgeVoiceCoverage {
    const clauses = ["kind = 'voice'"]
    const values: (string | number)[] = []
    const conversationIds = Array.from(
      new Set([
        ...(query.conversationIds || []),
        ...(query.conversationId ? [query.conversationId] : [])
      ])
    ).filter(Boolean)
    // The common global query can use the same truthful snapshot as status.
    // Scoped or time-bounded coverage remains a real SQL aggregation because
    // its answer depends on the requested slice.
    if (!conversationIds.length && query.startTime === undefined && query.endTime === undefined) {
      return {
        voiceMessageCount: this.readStatNumber('stats_voice_message_count'),
        transcribedVoiceCount: this.readStatNumber('stats_transcribed_voice_count'),
        failedVoiceCount: this.readStatNumber('stats_failed_voice_count'),
        voiceCoverageComplete:
          this.readStatNumber('stats_voice_message_count') ===
          this.readStatNumber('stats_transcribed_voice_count')
      }
    }
    if (conversationIds.length) {
      clauses.push(`conversation_id IN (${conversationIds.map(() => '?').join(', ')})`)
      values.push(...conversationIds)
    }
    if (query.startTime !== undefined) {
      clauses.push('create_time >= ?')
      values.push(query.startTime)
    }
    if (query.endTime !== undefined) {
      clauses.push('create_time <= ?')
      values.push(query.endTime)
    }
    const row = this.database
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN voice_transcript IS NOT NULL AND trim(voice_transcript) <> '' THEN 1 ELSE 0 END) AS transcribed,
                SUM(CASE WHEN voice_transcript_state = 'failed' THEN 1 ELSE 0 END) AS failed
         FROM knowledge_messages WHERE ${clauses.join(' AND ')}`
      )
      .get(...values) as DbRow | undefined
    const voiceMessageCount = Number(row?.total || 0)
    const transcribedVoiceCount = Number(row?.transcribed || 0)
    const failedVoiceCount = Number(row?.failed || 0)
    return {
      voiceMessageCount,
      transcribedVoiceCount,
      failedVoiceCount,
      voiceCoverageComplete: voiceMessageCount === transcribedVoiceCount
    }
  }

  private initialize(): void {
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS knowledge_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS knowledge_messages (
        account_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        create_time INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        searchable_text TEXT NOT NULL,
        kind TEXT NOT NULL,
        sender_id TEXT,
        sender_name TEXT,
        attachment_json TEXT,
        voice_transcript TEXT,
        voice_transcript_state TEXT,
        PRIMARY KEY (conversation_id, message_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS knowledge_messages_conversation_time
        ON knowledge_messages (conversation_id, create_time);
      CREATE TABLE IF NOT EXISTS knowledge_chunks (
        rowid INTEGER PRIMARY KEY,
        chunk_id TEXT NOT NULL UNIQUE,
        account_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        start_time INTEGER NOT NULL,
        end_time INTEGER NOT NULL,
        text TEXT NOT NULL,
        message_ids_json TEXT NOT NULL,
        participant_ids_json TEXT NOT NULL,
        message_kinds_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        chunker_version TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS knowledge_chunks_conversation_time
        ON knowledge_chunks (conversation_id, end_time);
      CREATE TABLE IF NOT EXISTS knowledge_index_state (
        conversation_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        chunker_version TEXT NOT NULL,
        state TEXT NOT NULL,
        high_water_time INTEGER,
        indexed_message_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `)
    const messageColumns = new Set(
      asRows(this.database.prepare('PRAGMA table_info(knowledge_messages)').all()).map((row) =>
        String(row.name)
      )
    )
    if (!messageColumns.has('voice_transcript_state')) {
      this.database.exec('ALTER TABLE knowledge_messages ADD COLUMN voice_transcript_state TEXT')
    }
    this.writeMetaIfMissing('schema_version', String(KNOWLEDGE_SCHEMA_VERSION))
    const storedAccount = this.readMeta('account_id')
    if (storedAccount && storedAccount !== this.accountId) {
      throw new Error('Knowledge database account isolation check failed')
    }
    this.writeMetaIfMissing('account_id', this.accountId)
    const fingerprint = ftsConfigFingerprint(this.fts)
    const existingFingerprint = this.readMeta('fts_config')
    if (existingFingerprint && existingFingerprint !== fingerprint) {
      throw new Error('Knowledge FTS profile changed; rebuild this derived index before reuse')
    }
    this.writeMetaIfMissing('fts_config', fingerprint)
    this.createFtsTable()
    this.ensureStatsSnapshot()
  }

  private createFtsTable(): void {
    const content = this.ftsExternalContent
      ? ", content = 'knowledge_chunks', content_rowid = 'rowid'"
      : ''
    this.database.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
        text,
        tokenize = '${ftsTokenize(this.fts)}'${content},
        detail = '${this.fts.detail}',
        columnsize = ${this.fts.columnsize}
      );
    `)
  }

  private async indexConversation(
    conversation: KnowledgeCapacityPreflightRequest['conversations'][number],
    chunker: KnowledgeCapacityPreflightRequest['chunker'],
    signal: AbortSignal | undefined,
    onProgress: (processed: number, chunks: number) => void
  ): Promise<{ chunkCount: number; updatedChunks: number }> {
    if (!conversation.conversationId) throw new Error('Knowledge conversation id is required')
    const normalized = conversation.messages.map((message) => {
      if (message.accountId !== this.accountId)
        throw new Error('Knowledge source account does not match database')
      if (message.conversationId !== conversation.conversationId) {
        throw new Error('Knowledge source conversation does not match request')
      }
      return normalizeKnowledgeMessage(message)
    })
    normalized.sort(
      (left, right) =>
        left.createTime - right.createTime || left.messageId.localeCompare(right.messageId)
    )

    const existingState = this.database
      .prepare('SELECT state FROM knowledge_index_state WHERE conversation_id = ?')
      .get(conversation.conversationId) as DbRow | undefined
    const existingMessages = new Map(
      asRows(
        this.database
          .prepare(
            'SELECT message_id, create_time, content_hash FROM knowledge_messages WHERE conversation_id = ?'
          )
          .all(conversation.conversationId)
      ).map((row) => [String(row.message_id), row])
    )
    const incomingIds = new Set(normalized.map((message) => message.messageId))
    let changedAt = existingState?.state === 'ready' ? -1 : 0
    for (let index = 0; index < normalized.length; index += 1) {
      const message = normalized[index]
      const existing = existingMessages.get(message.messageId)
      if (!existing || String(existing.content_hash) !== message.contentHash) {
        changedAt = changedAt < 0 ? index : Math.min(changedAt, index)
      }
    }
    if (conversation.completeSnapshot) {
      for (const messageId of existingMessages.keys()) {
        if (!incomingIds.has(messageId)) {
          // A removal can change any following chunk boundary, so safely rebuild this conversation.
          changedAt = 0
          break
        }
      }
    }
    if (changedAt < 0) return { chunkCount: 0, updatedChunks: 0 }

    const rebuildStart = Math.max(0, changedAt - chunker.overlapMessages)
    const boundaryTime = normalized[rebuildStart]?.createTime ?? 0
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.upsertState(
        conversation.conversationId,
        chunker.version,
        'indexing',
        null,
        normalized.length
      )
      await this.writeMessageLedger(
        conversation.conversationId,
        normalized,
        conversation.completeSnapshot,
        signal,
        onProgress
      )

      const staleChunks = asRows(
        this.database
          .prepare(
            `SELECT rowid, text FROM knowledge_chunks
             WHERE conversation_id = ? AND chunker_version = ? AND end_time >= ?`
          )
          .all(conversation.conversationId, chunker.version, boundaryTime)
      )
      for (let index = 0; index < staleChunks.length; index += 1) {
        this.assertNotAborted(signal)
        this.deleteFtsRow(Number(staleChunks[index].rowid), String(staleChunks[index].text))
        if (index % YIELD_EVERY === 0) await waitForWorkerTurn()
      }
      this.database
        .prepare(
          'DELETE FROM knowledge_chunks WHERE conversation_id = ? AND chunker_version = ? AND end_time >= ?'
        )
        .run(conversation.conversationId, chunker.version, boundaryTime)

      const chunks = chunkConversation(normalized, chunker).filter(
        (chunk) => chunk.endTime >= boundaryTime
      )
      const now = Date.now()
      for (let index = 0; index < chunks.length; index += 1) {
        this.assertNotAborted(signal)
        this.upsertChunk(chunks[index], now)
        if (index % YIELD_EVERY === 0) {
          onProgress(normalized.length, index + 1)
          await waitForWorkerTurn()
        }
      }
      const highWater = normalized.length ? normalized[normalized.length - 1].createTime : null
      this.upsertState(
        conversation.conversationId,
        chunker.version,
        'ready',
        highWater,
        normalized.length
      )
      this.database.exec('COMMIT')
      return { chunkCount: chunks.length, updatedChunks: chunks.length }
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  private async writeMessageLedger(
    conversationId: string,
    messages: KnowledgeNormalizedMessage[],
    completeSnapshot: boolean,
    signal: AbortSignal | undefined,
    onProgress: (processed: number, chunks: number) => void
  ): Promise<void> {
    const upsert = this.database.prepare(
      `INSERT INTO knowledge_messages (
        account_id, conversation_id, message_id, create_time, content_hash, searchable_text,
        kind, sender_id, sender_name, attachment_json, voice_transcript, voice_transcript_state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id, message_id) DO UPDATE SET
        create_time = excluded.create_time,
        content_hash = excluded.content_hash,
        searchable_text = excluded.searchable_text,
        kind = excluded.kind,
        sender_id = excluded.sender_id,
        sender_name = excluded.sender_name,
        attachment_json = excluded.attachment_json,
        voice_transcript = excluded.voice_transcript,
        voice_transcript_state = excluded.voice_transcript_state`
    )
    for (let index = 0; index < messages.length; index += 1) {
      this.assertNotAborted(signal)
      const message = messages[index]
      upsert.run(
        this.accountId,
        conversationId,
        message.messageId,
        message.createTime,
        message.contentHash,
        message.searchableText,
        message.kind,
        message.senderId ?? null,
        message.senderName ?? null,
        message.attachment ? encodedJson(message.attachment) : null,
        message.voiceTranscript ?? null,
        message.voiceTranscriptState ?? null
      )
      if (index % YIELD_EVERY === 0) {
        onProgress(index + 1, 0)
        await waitForWorkerTurn()
      }
    }
    if (!completeSnapshot) return
    const incoming = new Set(messages.map((message) => message.messageId))
    const existing = asRows(
      this.database
        .prepare('SELECT message_id FROM knowledge_messages WHERE conversation_id = ?')
        .all(conversationId)
    )
    const remove = this.database.prepare(
      'DELETE FROM knowledge_messages WHERE conversation_id = ? AND message_id = ?'
    )
    for (const row of existing) {
      const messageId = String(row.message_id)
      if (!incoming.has(messageId)) remove.run(conversationId, messageId)
    }
  }

  private upsertChunk(chunk: KnowledgeChunk, now: number): void {
    this.database
      .prepare(
        `INSERT INTO knowledge_chunks (
          chunk_id, account_id, conversation_id, start_time, end_time, text, message_ids_json,
          participant_ids_json, message_kinds_json, content_hash, chunker_version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(chunk_id) DO UPDATE SET
          text = excluded.text,
          message_ids_json = excluded.message_ids_json,
          participant_ids_json = excluded.participant_ids_json,
          message_kinds_json = excluded.message_kinds_json,
          content_hash = excluded.content_hash,
          updated_at = excluded.updated_at`
      )
      .run(
        chunk.chunkId,
        this.accountId,
        chunk.conversationId,
        chunk.startTime,
        chunk.endTime,
        chunk.text,
        encodedJson(chunk.messageIds),
        encodedJson(chunk.participantIds),
        encodedJson(chunk.messageKinds),
        chunk.contentHash,
        chunk.chunkerVersion,
        now,
        now
      )
    const row = this.database
      .prepare('SELECT rowid FROM knowledge_chunks WHERE chunk_id = ?')
      .get(chunk.chunkId) as DbRow
    this.insertFtsRow(Number(row.rowid), chunk.text)
  }

  private insertFtsRow(rowid: number, text: string): void {
    if (this.ftsExternalContent) {
      this.database.prepare('INSERT INTO knowledge_fts(rowid, text) VALUES (?, ?)').run(rowid, text)
      return
    }
    // FTS5 virtual tables do not implement SQLite UPSERT. Replace the row in
    // two statements so the internal-content benchmark profile remains valid.
    this.database.prepare('DELETE FROM knowledge_fts WHERE rowid = ?').run(rowid)
    this.database.prepare('INSERT INTO knowledge_fts(rowid, text) VALUES (?, ?)').run(rowid, text)
  }

  private deleteFtsRow(rowid: number, text: string): void {
    if (this.ftsExternalContent) {
      this.database
        .prepare("INSERT INTO knowledge_fts(knowledge_fts, rowid, text) VALUES ('delete', ?, ?)")
        .run(rowid, text)
      return
    }
    this.database.prepare('DELETE FROM knowledge_fts WHERE rowid = ?').run(rowid)
  }

  private setRunState(state: string, error: string | null = null): void {
    this.writeMeta('run_state', state)
    this.writeMeta('run_error', error || '')
    this.writeMeta('updated_at', String(Date.now()))
  }

  private upsertState(
    conversationId: string,
    chunkerVersion: string,
    state: string,
    highWater: number | null,
    messageCount: number,
    error: string | null = null
  ): void {
    this.database
      .prepare(
        `INSERT INTO knowledge_index_state (
          conversation_id, account_id, chunker_version, state, high_water_time,
          indexed_message_count, last_error, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(conversation_id) DO UPDATE SET
          account_id = excluded.account_id,
          chunker_version = excluded.chunker_version,
          state = excluded.state,
          high_water_time = excluded.high_water_time,
          indexed_message_count = excluded.indexed_message_count,
          last_error = excluded.last_error,
          updated_at = excluded.updated_at`
      )
      .run(
        conversationId,
        this.accountId,
        chunkerVersion,
        state,
        highWater,
        messageCount,
        error,
        Date.now()
      )
  }

  private readMeta(key: string): string | null {
    const row = this.database.prepare('SELECT value FROM knowledge_meta WHERE key = ?').get(key) as
      | DbRow
      | undefined
    return row ? String(row.value) : null
  }

  private writeMetaIfMissing(key: string, value: string): void {
    this.database
      .prepare('INSERT INTO knowledge_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING')
      .run(key, value)
  }

  private writeMeta(key: string, value: string): void {
    this.database
      .prepare(
        'INSERT INTO knowledge_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(key, value)
  }

  /**
   * Counts are a database-state snapshot, not a per-search query. The snapshot
   * is marked stale before indexing and refreshed only after the final request
   * in a complete source pass. If the process is reopened while stale (for
   * example after an incremental update, cancellation or crash), the first
   * Worker operation reconciles it once before serving status/search.
   */
  private ensureStatsSnapshot(): void {
    if (this.readMeta('stats_state') === 'fresh') return
    this.refreshStatsSnapshot()
  }

  private markStatsStale(): void {
    this.writeMeta('stats_state', 'stale')
  }

  private refreshStatsSnapshot(): void {
    const startedAt = Date.now()
    const messageCount = Number(
      (this.database.prepare('SELECT COUNT(*) AS count FROM knowledge_messages').get() as DbRow)
        .count
    )
    const chunkCount = Number(
      (this.database.prepare('SELECT COUNT(*) AS count FROM knowledge_chunks').get() as DbRow).count
    )
    const voice = this.database
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN voice_transcript IS NOT NULL AND trim(voice_transcript) <> '' THEN 1 ELSE 0 END) AS transcribed,
                SUM(CASE WHEN voice_transcript_state = 'failed' THEN 1 ELSE 0 END) AS failed
         FROM knowledge_messages WHERE kind = 'voice'`
      )
      .get() as DbRow
    this.writeMeta('stats_message_count', String(messageCount))
    this.writeMeta('stats_chunk_count', String(chunkCount))
    this.writeMeta('stats_voice_message_count', String(Number(voice.total || 0)))
    this.writeMeta('stats_transcribed_voice_count', String(Number(voice.transcribed || 0)))
    this.writeMeta('stats_failed_voice_count', String(Number(voice.failed || 0)))
    this.writeMeta('stats_updated_at', String(Date.now()))
    this.writeMeta('stats_state', 'fresh')
    this.pendingStatsRefreshMs += Date.now() - startedAt
  }

  private readStatNumber(key: string): number {
    const raw = this.readMeta(key)
    const value = raw === null ? NaN : Number(raw)
    return Number.isFinite(value) && value >= 0 ? value : 0
  }

  private consumeStatsRefreshMs(): number {
    const value = this.pendingStatsRefreshMs
    this.pendingStatsRefreshMs = 0
    return value
  }

  private databaseBytes(): number {
    return existsSync(this.databasePath) ? statSync(this.databasePath).size : 0
  }

  private walBytes(): number {
    const path = `${this.databasePath}-wal`
    return existsSync(path) ? statSync(path).size : 0
  }

  private assertNotAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw new DOMException('Knowledge indexing cancelled', 'AbortError')
  }
}

/**
 * Pure, read-only capacity estimate. It intentionally does not construct a
 * SQLite database or open the source archive, so callers can show a preflight
 * before enabling a knowledge base.
 */
export async function estimateKnowledgeCapacityPreflight(
  request: KnowledgeCapacityPreflightRequest
): Promise<KnowledgeCapacityPreflight> {
  const sources = request.conversations.flatMap((conversation) => conversation.messages)
  if (sources.some((message) => message.accountId !== request.accountId)) {
    throw new Error('Knowledge preflight received messages from another account')
  }
  const normalized = sources.map(normalizeKnowledgeMessage)
  const indexable = normalized.filter((message) => Boolean(message.searchableText))
  const sampleSize = Math.min(indexable.length, 2_000)
  const stride = sampleSize ? Math.max(1, Math.floor(indexable.length / sampleSize)) : 1
  const sampled = indexable.filter((_, index) => index % stride === 0).slice(0, sampleSize)
  const sampledByConversation = new Map<string, KnowledgeNormalizedMessage[]>()
  for (const message of sampled) {
    const existing = sampledByConversation.get(message.conversationId) || []
    existing.push(message)
    sampledByConversation.set(message.conversationId, existing)
  }
  const sampledChunks = Array.from(sampledByConversation.values()).flatMap((messages) =>
    chunkConversation(messages, request.chunker)
  )
  const averageMessagesPerChunk = sampledChunks.length
    ? sampled.length / sampledChunks.length
    : Math.max(1, request.chunker.maxMessages)
  const estimatedChunkCount = Math.ceil(indexable.length / averageMessagesPerChunk)
  const textBytes = indexable.reduce(
    (total, message) => total + byteLength(message.searchableText),
    0
  )
  const estimatedDatabaseBytesLow = Math.max(
    4 * 1024 * 1024,
    Math.ceil(textBytes * 1.2 + estimatedChunkCount * 360)
  )
  const estimatedDatabaseBytesHigh = Math.max(
    estimatedDatabaseBytesLow,
    Math.ceil(textBytes * 3.2 + estimatedChunkCount * 980)
  )
  const estimatedBuildPeakBytesLow = Math.ceil(estimatedDatabaseBytesLow * 1.5 + 1024 * 1024 * 1024)
  const estimatedBuildPeakBytesHigh = Math.ceil(estimatedDatabaseBytesHigh * 2 + 1024 * 1024 * 1024)
  const warnings: string[] = []
  if (!indexable.length) warnings.push('当前样本没有可索引的文本、附件元数据或语音转写')
  let hasSufficientDiskSpace: boolean | undefined
  if (request.availableDiskBytes !== undefined) {
    hasSufficientDiskSpace = request.availableDiskBytes >= estimatedBuildPeakBytesHigh
    if (!hasSufficientDiskSpace) warnings.push('可用磁盘空间低于保守建库峰值预估，建议暂缓建立索引')
  }
  return {
    accountId: request.accountId,
    sourceMessageCount: sources.length,
    indexableMessageCount: indexable.length,
    indexableTextBytes: textBytes,
    voiceTranscriptCount: normalized.filter((message) => Boolean(message.voiceTranscript)).length,
    attachmentMetadataCount: normalized.filter((message) => Boolean(message.attachment?.name))
      .length,
    sampledChunkCount: sampledChunks.length,
    estimatedChunkCount,
    estimatedDatabaseBytesLow,
    estimatedDatabaseBytesHigh,
    estimatedBuildPeakBytesLow,
    estimatedBuildPeakBytesHigh,
    availableDiskBytes: request.availableDiskBytes,
    hasSufficientDiskSpace,
    warnings
  }
}
