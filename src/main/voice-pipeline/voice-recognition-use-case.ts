import type {
  VoiceMessageReference,
  VoiceModelDownloadResult,
  VoiceModelStatus,
  VoiceRecognitionPriority,
  VoiceRecognitionResult,
  VoiceTranscriptSnapshot,
  VoiceTranscriptUpdate
} from '../../shared/voice-recognition'
import type { VoiceService } from '../voice-service'
import { PcmAudioProcessor } from './audio-processor'
import { createDefaultAudioDecoderRegistry } from './audio-decoder'
import { VoiceModelManager } from './model-manager'
import { RecognitionHost, WorkerSpeechRecognizer } from './recognition-host'
import { VoiceTaskScheduler } from './task-scheduler'
import { SqliteTranscriptRepository } from './transcript-repository'
import { VoicePipeline, VoiceSourceResolver } from './voice-pipeline'
import { SpeechRecognizerRegistry } from './types'
import { voiceAccountIdentity, voiceMessageIdentity } from './voice-message-identity'

type TranscriptUpdateListener = (update: VoiceTranscriptUpdate) => Promise<void> | void

type RecognitionOptions = {
  priority?: VoiceRecognitionPriority
  publishTranscriptUpdate?: boolean
}

export class VoiceRecognitionUseCase {
  readonly modelManager: VoiceModelManager
  private readonly scheduler = new VoiceTaskScheduler()
  private readonly transcripts: SqliteTranscriptRepository
  private readonly recognizer: WorkerSpeechRecognizer
  private readonly recognizers = new SpeechRecognizerRegistry()
  private pipeline: VoicePipeline | null = null
  private accountId = ''
  private accountGeneration = 0
  private readonly transcriptUpdateListeners = new Set<TranscriptUpdateListener>()

  constructor(options: { modelRoot: string; databasePath: string; workerPath: string }) {
    this.modelManager = new VoiceModelManager(options.modelRoot)
    this.transcripts = new SqliteTranscriptRepository(options.databasePath)
    this.recognizer = new WorkerSpeechRecognizer(
      new RecognitionHost(options.workerPath),
      this.modelManager
    )
    this.recognizers.register(this.recognizer)
  }

  connect(voiceService: VoiceService, accountRoot: string): void {
    this.scheduler.cancelAll()
    this.accountGeneration += 1
    this.accountId = voiceAccountIdentity(accountRoot)
    this.pipeline = new VoicePipeline(
      new VoiceSourceResolver(voiceService),
      createDefaultAudioDecoderRegistry(),
      new PcmAudioProcessor(),
      this.recognizers.get('sensevoice'),
      this.transcripts
    )
  }

  disconnect(): void {
    this.scheduler.cancelAll()
    this.accountGeneration += 1
    this.pipeline = null
    this.accountId = ''
  }

  getModelStatus(): Promise<VoiceModelStatus> {
    return this.modelManager.getStatus()
  }

  downloadModel(): Promise<VoiceModelDownloadResult> {
    return this.modelManager.download()
  }

  cancelModelDownload(): { success: boolean } {
    return { success: this.modelManager.cancelDownload() }
  }

  async removeModel(): Promise<VoiceModelStatus> {
    this.scheduler.cancelAll()
    await this.recognizer.dispose()
    return this.modelManager.remove()
  }

  recognize(
    reference: VoiceMessageReference,
    options?: RecognitionOptions
  ): Promise<VoiceRecognitionResult> {
    const pipeline = this.pipeline
    const accountId = this.accountId
    if (!pipeline || !accountId) {
      return Promise.resolve({ success: false, code: 'NOT_CONNECTED', error: '请先连接微信数据库' })
    }
    const key = this.taskKey(reference)
    const generation = this.accountGeneration
    const accountIdentity = this.accountId
    return this.scheduler
      .schedule(
        key,
        async (signal) => {
          const status = await this.modelManager.getStatus()
          if (status.state !== 'ready') {
            return {
              success: false,
              code: 'MODEL_NOT_READY',
              error: '请先下载语音识别模型'
            } as const
          }
          const result = await pipeline.run(accountId, reference, signal)
          if (signal.aborted || !this.isCurrentAccount(accountId, generation)) {
            throw new DOMException('Recognition cancelled', 'AbortError')
          }
          const transcript = result.transcript.trim()
          if (
            transcript &&
            options?.publishTranscriptUpdate !== false &&
            this.isCurrentAccount(accountId, generation)
          ) {
            try {
              await this.publishTranscriptUpdate({
                accountIdentity,
                reference,
                messageIdentity: voiceMessageIdentity(reference),
                state: 'transcribed',
                transcript,
                cached: result.cached
              })
            } catch (error) {
              console.warn('[Voice] transcript indexed asynchronously failed:', error)
            }
          }
          return { success: true, ...result, transcript } as const
        },
        { priority: options?.priority }
      )
      .catch((error): VoiceRecognitionResult => {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return { success: false, code: 'CANCELLED', error: '语音识别已取消' }
        }
        const message = error instanceof Error ? error.message : String(error)
        const code = message.toLowerCase().includes('timed out') ? 'TIMEOUT' : 'RECOGNITION_FAILED'
        if (this.isCurrentAccount(accountId, generation)) {
          this.transcripts.markFailure(accountId, voiceMessageIdentity(reference), message)
          if (options?.publishTranscriptUpdate !== false) {
            void this.publishTranscriptUpdate({
              accountIdentity,
              reference,
              messageIdentity: voiceMessageIdentity(reference),
              state: 'failed',
              error: message,
              cached: false
            }).catch((publishError) => {
              console.warn('[Voice] failed transcript state update failed:', publishError)
            })
          }
        }
        return { success: false, code, error: message }
      })
  }

  onTranscriptUpdate(listener: TranscriptUpdateListener): () => void {
    this.transcriptUpdateListeners.add(listener)
    return () => this.transcriptUpdateListeners.delete(listener)
  }

  getTranscriptSnapshot(reference: VoiceMessageReference): VoiceTranscriptSnapshot {
    if (!this.accountId) return { state: 'pending' }
    const messageIdentity = voiceMessageIdentity(reference)
    const record = this.transcripts.findLatest(this.accountId, messageIdentity)
    if (record?.transcript.trim()) {
      return { state: 'transcribed', transcript: record.transcript, updatedAt: record.updatedAt }
    }
    const status = this.transcripts.getMessageStatus(this.accountId, messageIdentity)
    return {
      state: status.state === 'transcribed' ? 'pending' : status.state,
      error: status.error,
      updatedAt: status.updatedAt || undefined
    }
  }

  async publishTranscriptSnapshot(reference: VoiceMessageReference): Promise<void> {
    const snapshot = this.getTranscriptSnapshot(reference)
    if (snapshot.state === 'pending') return
    await this.publishTranscript(reference, snapshot.transcript, snapshot.state === 'transcribed')
  }

  async publishTranscript(
    reference: VoiceMessageReference,
    transcript?: string,
    cached = true
  ): Promise<void> {
    const accountIdentity = this.accountId
    if (!accountIdentity || !transcript?.trim()) return
    await this.publishTranscriptUpdate({
      accountIdentity,
      reference,
      messageIdentity: voiceMessageIdentity(reference),
      state: 'transcribed',
      transcript: transcript.trim(),
      cached
    })
  }

  get accountIdentity(): string {
    return this.accountId
  }

  cancelRecognition(reference: VoiceMessageReference): { success: boolean } {
    return { success: this.scheduler.cancel(this.taskKey(reference)) }
  }

  async dispose(): Promise<void> {
    this.scheduler.cancelAll()
    await this.recognizer.dispose()
    this.transcripts.close()
  }

  private taskKey(reference: VoiceMessageReference): string {
    return `${this.accountId}:${voiceMessageIdentity(reference)}`
  }

  private isCurrentAccount(accountId: string, generation: number): boolean {
    return this.accountId === accountId && this.accountGeneration === generation
  }

  private async publishTranscriptUpdate(update: VoiceTranscriptUpdate): Promise<void> {
    for (const listener of this.transcriptUpdateListeners) await listener(update)
  }
}
