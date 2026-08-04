import { createHash } from 'crypto'
import type {
  VoiceMessageReference,
  VoiceModelDownloadResult,
  VoiceModelStatus,
  VoiceRecognitionResult
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

export class VoiceRecognitionUseCase {
  readonly modelManager: VoiceModelManager
  private readonly scheduler = new VoiceTaskScheduler()
  private readonly transcripts: SqliteTranscriptRepository
  private readonly recognizer: WorkerSpeechRecognizer
  private readonly recognizers = new SpeechRecognizerRegistry()
  private pipeline: VoicePipeline | null = null
  private accountId = ''

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
    this.accountId = createHash('sha256')
      .update(
        accountRoot
          .trim()
          .replace(/[\\/]+$/, '')
          .toLowerCase()
      )
      .digest('hex')
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

  recognize(reference: VoiceMessageReference): Promise<VoiceRecognitionResult> {
    const pipeline = this.pipeline
    const accountId = this.accountId
    if (!pipeline || !accountId) {
      return Promise.resolve({ success: false, code: 'NOT_CONNECTED', error: '请先连接微信数据库' })
    }
    const key = this.taskKey(reference)
    return this.scheduler
      .schedule(key, async (signal) => {
        const status = await this.modelManager.getStatus()
        if (status.state !== 'ready') {
          return { success: false, code: 'MODEL_NOT_READY', error: '请先下载语音识别模型' } as const
        }
        const result = await pipeline.run(accountId, reference, signal)
        return { success: true, ...result } as const
      })
      .catch((error): VoiceRecognitionResult => {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return { success: false, code: 'CANCELLED', error: '语音识别已取消' }
        }
        const message = error instanceof Error ? error.message : String(error)
        const code = message.toLowerCase().includes('timed out') ? 'TIMEOUT' : 'RECOGNITION_FAILED'
        return { success: false, code, error: message }
      })
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
    return `${this.accountId}:${reference.sessionId}:${reference.localId}:${reference.createTime}`
  }
}
