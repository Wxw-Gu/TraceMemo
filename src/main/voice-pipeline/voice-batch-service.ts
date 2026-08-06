import type {
  VoiceBatchConversationSummary,
  VoiceBatchPreflight,
  VoiceBatchProgress,
  VoiceBatchRequest,
  VoiceMessageReference
} from '../../shared/voice-recognition'
import * as chat from '../services/chat-service'
import { voiceMessageIdentity } from './voice-message-identity'
import { VoiceRecognitionUseCase } from './voice-recognition-use-case'

type VoiceBatchItem = {
  conversationId: string
  reference: VoiceMessageReference
}

type ActiveTask = {
  accountIdentity: string
  controller: AbortController
  startedAt: number
  items: VoiceBatchItem[]
  failures: VoiceBatchItem[]
  progress: VoiceBatchProgress
}

type VoiceBatchListener = (progress: VoiceBatchProgress) => void

type PreparedBatch = {
  accountIdentity: string
  requestKey: string
  items: VoiceBatchItem[]
  preflight: VoiceBatchPreflight
}

function rangeStart(range: VoiceBatchRequest['range']): number | undefined {
  if (range === 'selected_history') return undefined
  const now = new Date()
  if (range === 'current_year')
    return Math.floor(new Date(now.getFullYear(), 0, 1).getTime() / 1000)
  return Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60
}

function voiceReference(message: chat.FormattedMessage): VoiceMessageReference | undefined {
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
 * Main-process coordinator for one account-local batch. It only chooses work
 * items; recognition, cache de-duplication and knowledge updates remain in
 * VoiceRecognitionUseCase.
 */
export class VoiceBatchService {
  private active: ActiveTask | null = null
  private lastProgress: VoiceBatchProgress | null = null
  private lastFailures: { accountIdentity: string; items: VoiceBatchItem[] } | null = null
  private prepared: PreparedBatch | null = null
  private readonly listeners = new Set<VoiceBatchListener>()

  constructor(private readonly recognition: VoiceRecognitionUseCase) {}

  onProgress(listener: VoiceBatchListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async preflight(request: VoiceBatchRequest): Promise<VoiceBatchPreflight> {
    const accountIdentity = this.recognition.accountIdentity
    const contacts = await chat.listContactsAsync()
    const items = await this.collect(request, contacts)
    const preflight = await this.summarize(accountIdentity, items)
    this.prepared = {
      accountIdentity,
      requestKey: this.requestKey(request),
      items,
      preflight
    }
    return preflight
  }

  async conversationSummaries(
    request: VoiceBatchRequest
  ): Promise<VoiceBatchConversationSummary[]> {
    const requested = Array.from(new Set(request.conversationIds.filter(Boolean)))
    if (!requested.length) return []
    const contacts = await chat.listContactsAsync()
    const selected = contacts.filter((contact) => requested.includes(contact.md5))
    if (selected.length !== requested.length) throw new Error('选择的会话已不可用，请重新选择')

    const startTime = rangeStart(request.range)
    const summaries: VoiceBatchConversationSummary[] = []
    for (let index = 0; index < selected.length; index += 1) {
      const contact = selected[index]
      summaries.push({
        conversationId: contact.md5,
        voiceMessageCount: await chat.countVoiceMessagesAsync(contact.md5, startTime)
      })
      // Keep a long contact list responsive while each count runs on WCDB's
      // asynchronous SQL channel.
      if (index > 0 && index % 4 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
    }
    return summaries
  }

  private async summarize(
    accountIdentity: string,
    items: VoiceBatchItem[]
  ): Promise<VoiceBatchPreflight> {
    const status = await this.recognition.getModelStatus()
    let cachedCount = 0
    let failedCount = 0
    for (const [index, item] of items.entries()) {
      const snapshot = this.recognition.getTranscriptSnapshot(item.reference)
      if (snapshot.state === 'transcribed') cachedCount += 1
      if (snapshot.state === 'failed') failedCount += 1
      if (index > 0 && index % 100 === 0)
        await new Promise<void>((resolve) => setImmediate(resolve))
    }
    return {
      accountIdentity,
      conversationCount: new Set(items.map((item) => item.conversationId)).size,
      voiceMessageCount: items.length,
      cachedCount,
      pendingCount: Math.max(0, items.length - cachedCount - failedCount),
      failedCount,
      estimatedDurationMs: null,
      modelReady: status.state === 'ready'
    }
  }

  getProgress(): VoiceBatchProgress {
    if (this.active) return { ...this.active.progress }
    if (this.lastProgress?.accountIdentity === this.recognition.accountIdentity) {
      return { ...this.lastProgress }
    }
    return {
      accountIdentity: this.recognition.accountIdentity,
      state: 'idle',
      total: 0,
      processed: 0,
      cached: 0,
      succeeded: 0,
      failed: 0,
      elapsedMs: 0,
      estimatedRemainingMs: null
    }
  }

  async start(request: VoiceBatchRequest): Promise<VoiceBatchProgress> {
    if (this.active) throw new Error('当前账号已有语音转写任务正在执行')
    const preflight = await this.preflight(request)
    if (!preflight.accountIdentity) throw new Error('请先连接微信数据')
    if (preflight.accountIdentity !== this.recognition.accountIdentity) {
      throw new Error('当前账号已切换，请重新选择会话')
    }
    if (!preflight.modelReady) throw new Error('请先在设置中准备离线语音模型')
    const prepared = this.prepared
    const items =
      prepared?.accountIdentity === preflight.accountIdentity &&
      prepared.requestKey === this.requestKey(request)
        ? prepared.items
        : await this.collect(request)
    const task: ActiveTask = {
      accountIdentity: preflight.accountIdentity,
      controller: new AbortController(),
      startedAt: Date.now(),
      items,
      failures: [],
      progress: {
        accountIdentity: preflight.accountIdentity,
        state: items.length ? 'pending' : 'completed',
        total: items.length,
        processed: 0,
        cached: 0,
        succeeded: 0,
        failed: 0,
        elapsedMs: 0,
        estimatedRemainingMs: null
      }
    }
    this.active = task
    this.publish(task)
    if (!items.length) {
      this.active = null
      return task.progress
    }
    void this.run(task)
    return { ...task.progress }
  }

  cancel(): boolean {
    if (!this.active) return false
    this.active.controller.abort()
    return true
  }

  async retryFailed(): Promise<VoiceBatchProgress> {
    if (this.active) throw new Error('当前账号已有语音转写任务正在执行')
    const lastFailures = this.lastFailures
    if (
      !lastFailures?.items.length ||
      lastFailures.accountIdentity !== this.recognition.accountIdentity
    ) {
      throw new Error('当前账号没有可重试的失败语音')
    }
    const status = await this.recognition.getModelStatus()
    if (status.state !== 'ready') throw new Error('请先在设置中准备离线语音模型')
    const task: ActiveTask = {
      accountIdentity: lastFailures.accountIdentity,
      controller: new AbortController(),
      startedAt: Date.now(),
      items: lastFailures.items,
      failures: [],
      progress: {
        accountIdentity: lastFailures.accountIdentity,
        state: 'pending',
        total: lastFailures.items.length,
        processed: 0,
        cached: 0,
        succeeded: 0,
        failed: 0,
        elapsedMs: 0,
        estimatedRemainingMs: null
      }
    }
    this.active = task
    this.publish(task)
    void this.run(task)
    return { ...task.progress }
  }

  private async run(task: ActiveTask): Promise<void> {
    const conversationsNeedingIndex = new Map<string, VoiceMessageReference>()
    task.progress.state = 'processing'
    this.publish(task)
    for (const item of task.items) {
      if (
        task.controller.signal.aborted ||
        task.accountIdentity !== this.recognition.accountIdentity
      )
        break
      task.progress.currentConversationId = item.conversationId
      task.progress.currentMessageIdentity = voiceMessageIdentity(item.reference)
      task.progress.elapsedMs = Date.now() - task.startedAt
      this.publish(task)
      const result = await this.recognition.recognize(item.reference, {
        priority: 'background',
        publishTranscriptUpdate: false
      })
      if (
        task.controller.signal.aborted ||
        task.accountIdentity !== this.recognition.accountIdentity
      )
        break
      if (!result.success && result.code === 'CANCELLED') {
        // An interactive chat-bubble request preempted this background item.
        // Put it at the tail instead of treating it as a completed or failed
        // transcription, then continue after the foreground request.
        task.items.push(item)
        continue
      }
      task.progress.processed += 1
      if (result.success) {
        if (result.cached) task.progress.cached += 1
        else task.progress.succeeded += 1
        conversationsNeedingIndex.set(item.conversationId, item.reference)
      } else {
        task.progress.failed += 1
        task.failures.push(item)
      }
      task.progress.elapsedMs = Date.now() - task.startedAt
      this.publish(task)
    }
    task.progress.elapsedMs = Date.now() - task.startedAt
    task.progress.currentConversationId = undefined
    task.progress.currentMessageIdentity = undefined
    // A complete conversation snapshot sees every transcript written by this
    // batch, so refresh Knowledge once per affected conversation after the
    // recognition loop rather than rebuilding after every voice message.
    if (
      !task.controller.signal.aborted &&
      task.accountIdentity === this.recognition.accountIdentity
    ) {
      for (const reference of conversationsNeedingIndex.values()) {
        try {
          await this.recognition.publishTranscriptSnapshot(reference)
        } catch (error) {
          console.warn('[Voice] batch transcript index update failed:', error)
        }
      }
    }
    task.progress.elapsedMs = Date.now() - task.startedAt
    if (
      task.controller.signal.aborted ||
      task.accountIdentity !== this.recognition.accountIdentity
    ) {
      task.progress.state = 'cancelled'
    } else if (task.progress.failed) {
      task.progress.state = 'partially_failed'
    } else {
      task.progress.state = 'completed'
    }
    this.lastFailures = task.failures.length
      ? { accountIdentity: task.accountIdentity, items: task.failures }
      : null
    this.publish(task)
    if (this.active === task) this.active = null
  }

  private async collect(
    request: VoiceBatchRequest,
    contactsOverride?: chat.FormattedContact[]
  ): Promise<VoiceBatchItem[]> {
    const requested = Array.from(new Set(request.conversationIds.filter(Boolean)))
    if (!requested.length) return []
    const contacts = contactsOverride || (await chat.listContactsAsync())
    const selected = contacts.filter((contact) => requested.includes(contact.md5))
    if (selected.length !== requested.length) throw new Error('选择的会话已不可用，请重新选择')
    const startTime = rangeStart(request.range)
    const items: VoiceBatchItem[] = []
    const seen = new Set<string>()
    for (const contact of selected) {
      const messages = await chat.listMessagesAsync(contact.md5, startTime)
      for (const message of messages) {
        const reference = voiceReference(message)
        if (!reference) continue
        const identity = voiceMessageIdentity(reference)
        if (seen.has(identity)) continue
        seen.add(identity)
        items.push({ conversationId: contact.md5, reference })
      }
    }
    return items
  }

  private requestKey(request: VoiceBatchRequest): string {
    return `${request.range}:${Array.from(new Set(request.conversationIds.filter(Boolean)))
      .sort()
      .join('|')}`
  }

  private publish(task: ActiveTask): void {
    const elapsedMs = Date.now() - task.startedAt
    const estimatedRemainingMs =
      task.progress.processed > 0 && task.progress.processed < task.progress.total
        ? Math.round(
            (elapsedMs / task.progress.processed) * (task.progress.total - task.progress.processed)
          )
        : task.progress.processed >= task.progress.total
          ? 0
          : null
    const progress = { ...task.progress, elapsedMs, estimatedRemainingMs }
    task.progress = progress
    this.lastProgress = progress
    for (const listener of this.listeners) listener(progress)
  }
}
