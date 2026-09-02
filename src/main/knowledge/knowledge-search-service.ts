import * as chat from '../services/chat-service'
import type {
  KnowledgeAttachmentMetadata,
  KnowledgeEvidence,
  KnowledgeMessageKind,
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
import {
  voiceAccountIdentity,
  voiceMessageIdentity
} from '../voice-pipeline/voice-message-identity'

const FALLBACK_LIMIT = 240
const MAX_SENDER_NAME_CONVERSATIONS = 8
const MAX_CONVERSATION_FILTERS_PER_WORKER_SEARCH = 700
const MAX_SENDER_ENRICHMENT_SESSIONS = 32
const SENDER_ENRICHMENT_SESSION_TTL_MS = 5 * 60 * 1000

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
  groupSnapshots: Map<string, Awaited<ReturnType<typeof chat.getGroupSnapshotAsync>> | undefined>
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

function sourceMessageId(message: chat.FormattedMessage): string {
  if (message.localId) return `local:${message.localId}`
  if (message.id) return String(message.id)
  return `${message.createTime || 0}:${message.serverId || message.content}`
}

function sourceKind(message: chat.FormattedMessage): KnowledgeMessageKind {
  if (message.voiceTranscript || message.type === '语音') return 'voice'
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
  transcriptOverride?: string
): KnowledgeSourceMessage | null {
  if (!message.createTime) return null
  const extracted = sourceTextAndAttachment(message)
  const voiceTranscript = transcriptOverride?.trim() || message.voiceTranscript?.trim() || undefined
  if (!extracted.text && !extracted.attachment && !voiceTranscript) return null
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
    voiceTranscript
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
  private wcdbReadTail: Promise<void> = Promise.resolve()
  private wcdbQueueMsTotal = 0
  private wcdbExecutionMsTotal = 0
  private voiceTranscriptResolver:
    | ((reference: VoiceMessageReference) => VoiceTranscriptSnapshot)
    | undefined
  private voiceIndexTail: Promise<void> = Promise.resolve()
  private voiceIndexFlushScheduled = false
  private readonly pendingVoiceIndexes = new Map<string, PendingVoiceTranscriptIndex>()

  constructor(userDataPath: string, workerPath: string) {
    this.service = new KnowledgeService(userDataPath, workerPath)
  }

  startCurrentAccountIndex(): KnowledgeRuntimeStatus {
    const accountId = this.currentAccountId()
    if (!accountId) return this.emptyStatus('')
    const current = this.statusByAccount.get(accountId) || this.emptyStatus(accountId)
    if (this.indexing.has(accountId)) return current
    const started: KnowledgeRuntimeStatus = {
      ...current,
      state: current.indexedMessageCount ? 'syncing' : 'building',
      processedMessages: 0,
      totalMessages: current.sourceMessageCount,
      estimatedRemainingMs: null,
      lastError: undefined
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
        void this.refreshStatus(accountId).catch(() => undefined)
      })
    this.indexing.set(accountId, task)
    void task.catch((error) => {
      console.warn('[Knowledge] background index failed:', error)
    })
    return started
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
    const accountId = this.currentAccountId()
    if (!accountId) return this.searchFallback(request, 'unavailable')
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
      }
      const result = await this.searchKnowledge(searchRequest)
      // An existing derived database can answer while its next incremental pass is running.
      // Never turn an interactive global search into another full WCDB scan during that pass.
      if (result.state === 'ready' || result.evidence.length) {
        return this.toKnowledgeResult(result, request.retrievalSessionId)
      }
      if (this.indexing.has(accountId)) {
        return {
          ...result,
          source: 'knowledge',
          totalMessages: result.indexedMessageCount
        }
      }
      return this.searchFallback(request, 'unavailable')
    } catch (error) {
      console.warn('[Knowledge] search failed, using legacy fallback:', error)
      return this.searchFallback(request, 'error')
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
    const contacts = await this.listContacts()
    let processedMessages = 0
    const startedAt = Date.now()
    this.publishStatus({
      ...(this.statusByAccount.get(accountId) || this.emptyStatus(accountId)),
      state: this.statusByAccount.get(accountId)?.indexedMessageCount ? 'syncing' : 'building',
      processedMessages: 0,
      totalMessages: null,
      estimatedRemainingMs: null
    })
    for (const [index, contact] of contacts.entries()) {
      // WCDB rejects overlapping async pagination. Queue every archive read so
      // background indexing and an interactive fallback search can interleave safely.
      const messages = await this.listMessages(contact.md5)
      const sourceMessages = messages
        .map((message) => this.toSourceMessage(accountId, contact.md5, message))
        .filter((message): message is KnowledgeSourceMessage => Boolean(message))
      await this.service.index(
        {
          accountId,
          conversations: [
            {
              conversationId: contact.md5,
              completeSnapshot: true,
              messages: sourceMessages
            }
          ],
          chunker: DEFAULT_KNOWLEDGE_CHUNKER,
          fts: DEFAULT_KNOWLEDGE_FTS_CONFIG,
          sourceMessageCount:
            index === contacts.length - 1 ? processedMessages + sourceMessages.length : undefined
        },
        (progress) => {
          const current = this.statusByAccount.get(accountId) || this.emptyStatus(accountId)
          this.publishStatus({
            ...current,
            state: current.indexedMessageCount ? 'syncing' : 'building',
            processedMessages: processedMessages + progress.processedMessages,
            totalMessages: null,
            currentConversationId: progress.conversationId,
            estimatedRemainingMs: null
          })
        }
      )
      processedMessages += sourceMessages.length
      const current = this.statusByAccount.get(accountId) || this.emptyStatus(accountId)
      this.publishStatus({
        ...current,
        state: current.indexedMessageCount ? 'syncing' : 'building',
        processedMessages,
        totalMessages: null,
        currentConversationId: contact.md5,
        estimatedRemainingMs: null
      })
    }
    await this.refreshStatus(accountId, {
      processedMessages,
      totalMessages: processedMessages,
      startedAt
    })
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
        return senderMatches && termMatches
      })
      .sort(
        (left, right) =>
          right.score - left.score ||
          (right.message.createTime || 0) - (left.message.createTime || 0)
      )
      .slice(0, Math.max(1, Math.min(request.limit || FALLBACK_LIMIT, FALLBACK_LIMIT)))
    const result: KnowledgeSearchIpcResult = {
      source: 'fallback',
      fallbackReason,
      state: fallbackReason === 'indexing' ? 'indexing' : 'unavailable',
      indexedMessageCount: 0,
      indexedChunkCount: 0,
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
    return {
      state: partialResults.some((result) => result.state === 'ready')
        ? 'ready'
        : partialResults.some((result) => result.state === 'indexing')
          ? 'indexing'
          : 'unavailable',
      indexedMessageCount: Math.max(...partialResults.map((result) => result.indexedMessageCount)),
      indexedChunkCount: Math.max(...partialResults.map((result) => result.indexedChunkCount)),
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

  private listContacts(): ReturnType<typeof chat.listContactsAsync> {
    return this.enqueueWcdbRead(() => chat.listContactsAsync())
  }

  private listMessages(
    conversationId: string,
    startTime?: number,
    endTime?: number
  ): ReturnType<typeof chat.listMessagesAsync> {
    return this.enqueueWcdbRead(() => chat.listMessagesAsync(conversationId, startTime, endTime))
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
    const source = toSourceMessage(accountId, conversationId, hydrated, transcriptOverride)
    if (!source || source.kind !== 'voice') return source
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
      totalMessages: result.indexedMessageCount
    }
  }

  private async enrichEvidenceSenders(
    evidence: KnowledgeEvidence[],
    retrievalSessionId?: string
  ): Promise<KnowledgeEvidence[]> {
    const candidateConversationIds = Array.from(
      new Set(
        evidence
          .filter((item) => item.senderId && looksLikeOpaqueSenderId(item.sender))
          .map((item) => item.conversationId)
      )
    ).slice(0, MAX_SENDER_NAME_CONVERSATIONS)
    if (!candidateConversationIds.length) return evidence

    const session = retrievalSessionId
      ? this.senderEnrichmentSession(retrievalSessionId)
      : undefined
    const contacts = session?.contacts || (await this.listContacts())
    if (session && !session.contacts) session.contacts = contacts
    const groupConversationIds = new Set(
      contacts.filter((contact) => contact.type === 'group').map((contact) => contact.md5)
    )
    const memberNamesByConversation = new Map<string, Map<string, string>>()
    for (const conversationId of candidateConversationIds) {
      if (!groupConversationIds.has(conversationId)) continue
      let snapshot = session?.groupSnapshots.get(conversationId)
      if (!snapshot) {
        snapshot = await this.enqueueWcdbRead(() => chat.getGroupSnapshotAsync(conversationId))
        session?.groupSnapshots.set(conversationId, snapshot)
      }
      const memberNames = new Map(
        (snapshot?.members || [])
          .map((member) => [member.wxid, groupMemberDisplayName(member)] as const)
          .filter(([, name]) => Boolean(name))
      )
      if (memberNames.size) memberNamesByConversation.set(conversationId, memberNames)
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
      session = { lastUsedAt: now, groupSnapshots: new Map() }
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

  private enqueueWcdbRead<T>(operation: () => Promise<T>): Promise<T> {
    const enqueuedAt = Date.now()
    const run = async (): Promise<T> => {
      const startedAt = Date.now()
      this.wcdbQueueMsTotal += Math.max(0, startedAt - enqueuedAt)
      try {
        return await operation()
      } finally {
        this.wcdbExecutionMsTotal += Date.now() - startedAt
      }
    }
    const result = this.wcdbReadTail.then(run, run)
    // Keep the queue usable after a read failure while returning that failure to its caller.
    this.wcdbReadTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
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
      shmBytes: 0
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
    const processedMessages =
      progress?.processedMessages ?? current?.processedMessages ?? remote.processedMessages
    const totalMessages = progress?.totalMessages ?? remote.sourceMessageCount
    const state = indexing
      ? remote.indexedMessageCount > 0
        ? 'syncing'
        : 'building'
      : remote.state
    const status: KnowledgeRuntimeStatus = {
      ...remote,
      state,
      processedMessages,
      totalMessages,
      estimatedRemainingMs: null
    }
    this.publishStatus(status)
    return status
  }

  private publishStatus(status: KnowledgeRuntimeStatus): void {
    this.statusByAccount.set(status.accountId, status)
    for (const listener of this.statusListeners) listener(status)
  }
}
