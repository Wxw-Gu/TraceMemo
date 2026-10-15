import type {
  VoiceMessageReference,
  VoiceRecognitionErrorCode,
  VoiceRecognitionResult,
  VoiceTranscriptSnapshot
} from '../../shared/voice-recognition'
import { voiceMessageIdentity } from './voice-message-identity'
import type { VoiceRecognitionUseCase } from './voice-recognition-use-case'

/** API 发起、尚未完成的转写任务上限（跨请求共享）。 */
export const VOICE_TRANSCRIBE_MAX_IN_FLIGHT = 100
/** 被界面上的交互请求抢占后，最多重新排队几次。 */
const MAX_PREEMPTION_RETRIES = 5

type Recognition = Pick<
  VoiceRecognitionUseCase,
  'recognize' | 'getTranscriptSnapshot' | 'getModelStatus' | 'accountIdentity'
>

export type VoiceTranscriptionOutcome =
  | { state: 'transcribed'; transcript: string; cached: boolean; durationMs?: number }
  | { state: 'pending' }
  | { state: 'failed'; code: VoiceRecognitionErrorCode | 'PREVIOUSLY_FAILED'; error: string }

/**
 * 本地 API 触发语音转写的入口。
 *
 * 识别本身（缓存、单 worker 串行调度、失败记录、Knowledge 增量）仍完全由
 * VoiceRecognitionUseCase 负责；这里只补 API 调用方需要的三件事：
 * - 同一条语音被反复轮询时复用同一个进行中的任务，不重复排队；
 * - 限制 API 积压的任务总量，避免一次塞入上千条把界面上的识别饿死；
 * - 调用方只等待有限时间，没做完的继续在后台跑，结果进缓存供下次读取。
 */
export class VoiceTranscriptionGateway {
  private readonly inFlight = new Map<string, Promise<VoiceRecognitionResult>>()

  constructor(
    private readonly recognition: Recognition,
    private readonly maxInFlight = VOICE_TRANSCRIBE_MAX_IN_FLIGHT
  ) {}

  /** 只读缓存，不触发识别。 */
  snapshot(reference: VoiceMessageReference): VoiceTranscriptSnapshot {
    return this.recognition.getTranscriptSnapshot(reference)
  }

  async modelReady(): Promise<boolean> {
    return (await this.recognition.getModelStatus()).state === 'ready'
  }

  get inFlightCount(): number {
    return this.inFlight.size
  }

  /**
   * 返回与 references 一一对应的结果；剩余容量装不下本次新增任务时返回 null，
   * 且不排入任何任务（整批拒绝，调用方稍后原样重试即可）。
   */
  async transcribe(
    references: VoiceMessageReference[],
    options: { force?: boolean; waitMs: number }
  ): Promise<VoiceTranscriptionOutcome[] | null> {
    const accountIdentity = this.recognition.accountIdentity
    const keyOf = (reference: VoiceMessageReference): string =>
      `${accountIdentity}:${voiceMessageIdentity(reference)}`

    const immediate = references.map((reference): VoiceTranscriptionOutcome | undefined => {
      if (options.force || this.inFlight.has(keyOf(reference))) return undefined
      const snapshot = this.recognition.getTranscriptSnapshot(reference)
      if (snapshot.state === 'transcribed' && snapshot.transcript?.trim()) {
        return { state: 'transcribed', transcript: snapshot.transcript.trim(), cached: true }
      }
      // 失败过的语音不自动重跑：调用方轮询时会反复命中同一条坏音频。
      if (snapshot.state === 'failed') {
        return {
          state: 'failed',
          code: 'PREVIOUSLY_FAILED',
          error: snapshot.error || '语音识别失败'
        }
      }
      return undefined
    })

    const newKeys = new Set<string>()
    references.forEach((reference, index) => {
      const key = keyOf(reference)
      if (!immediate[index] && !this.inFlight.has(key)) newKeys.add(key)
    })
    if (this.inFlight.size + newKeys.size > this.maxInFlight) return null

    const tasks = references.map((reference, index) => {
      if (immediate[index]) return undefined
      const key = keyOf(reference)
      let task = this.inFlight.get(key)
      if (!task) {
        task = this.run(reference, options.force, accountIdentity).finally(() => {
          this.inFlight.delete(key)
        })
        this.inFlight.set(key, task)
      }
      return task
    })

    let timer: NodeJS.Timeout | undefined
    const deadline = new Promise<'pending'>((resolve) => {
      timer = setTimeout(() => resolve('pending'), Math.max(0, options.waitMs))
    })
    try {
      return await Promise.all(
        references.map(async (_reference, index): Promise<VoiceTranscriptionOutcome> => {
          const done = immediate[index]
          if (done) return done
          const result = await Promise.race([tasks[index]!, deadline])
          if (result === 'pending') return { state: 'pending' }
          if (result.success) {
            return {
              state: 'transcribed',
              transcript: result.transcript?.trim() || '',
              cached: Boolean(result.cached),
              ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {})
            }
          }
          return {
            state: 'failed',
            code: result.code || 'RECOGNITION_FAILED',
            error: result.error || '语音识别失败'
          }
        })
      )
    } finally {
      clearTimeout(timer)
    }
  }

  private async run(
    reference: VoiceMessageReference,
    force: boolean | undefined,
    accountIdentity: string
  ): Promise<VoiceRecognitionResult> {
    for (let attempt = 0; ; attempt += 1) {
      // 用后台优先级：用户在界面上点开语音时可以立即抢占，不必排在 API 积压之后。
      const result = await this.recognition.recognize(reference, { priority: 'background', force })
      if (
        result.success ||
        result.code !== 'CANCELLED' ||
        attempt >= MAX_PREEMPTION_RETRIES ||
        this.recognition.accountIdentity !== accountIdentity
      ) {
        return result
      }
      // 被交互请求抢占：账号没变就重新排队，与批量转写的处理一致。
    }
  }
}
