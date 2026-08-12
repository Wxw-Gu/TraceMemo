import type { VoiceMessageReference } from '../../shared/voice-recognition'
import type { EncodedVoiceSource } from './audio-decoder'

export interface PipelineAudio {
  samples: Float32Array
  sampleRate: number
  channels: 1
  sourceHash: string
  processorVersion: string
  durationMs: number
}

export interface RecognitionMetadata {
  recognizerId: string
  modelVersion: string
  modelFingerprint: string
}

export interface RecognitionOutput {
  text: string
  language?: string
}

export interface SourceResolver {
  resolve(reference: VoiceMessageReference): Promise<EncodedVoiceSource>
}

export class SpeechRecognizerRegistry {
  private readonly recognizers = new Map<string, SpeechRecognizer>()

  register(recognizer: SpeechRecognizer): this {
    const id = recognizer.metadata.recognizerId
    if (this.recognizers.has(id)) throw new Error(`Recognizer already registered: ${id}`)
    this.recognizers.set(id, recognizer)
    return this
  }

  get(recognizerId: string): SpeechRecognizer {
    const recognizer = this.recognizers.get(recognizerId)
    if (!recognizer) throw new Error(`Recognizer is not registered: ${recognizerId}`)
    return recognizer
  }
}

export interface AudioProcessor {
  readonly version: string
  process(input: {
    pcm: Buffer
    sampleRate: number
    channels: number
    sourceHash: string
  }): PipelineAudio
}

export interface SpeechRecognizer {
  readonly metadata: RecognitionMetadata
  recognize(audio: PipelineAudio, signal?: AbortSignal): Promise<RecognitionOutput>
  dispose(): Promise<void>
}

export interface TranscriptRecord extends RecognitionMetadata {
  accountId: string
  messageIdentity: string
  audioHash: string
  processorVersion: string
  transcript: string
  language?: string
  durationMs: number
  createdAt: number
  updatedAt: number
}

export type TranscriptMessageState = 'pending' | 'transcribed' | 'failed'

export interface TranscriptMessageStatus {
  accountId: string
  messageIdentity: string
  state: TranscriptMessageState
  updatedAt: number
  error?: string
}

export interface TranscriptRepository {
  find(
    key: Omit<
      TranscriptRecord,
      'transcript' | 'language' | 'durationMs' | 'createdAt' | 'updatedAt'
    >
  ): TranscriptRecord | null
  findLatest(accountId: string, messageIdentity: string): TranscriptRecord | null
  findCompatible(
    key: Pick<
      TranscriptRecord,
      | 'accountId'
      | 'messageIdentity'
      | 'processorVersion'
      | 'recognizerId'
      | 'modelVersion'
      | 'modelFingerprint'
    >
  ): TranscriptRecord | null
  getMessageStatus(accountId: string, messageIdentity: string): TranscriptMessageStatus
  save(record: TranscriptRecord): void
  markFailure(accountId: string, messageIdentity: string, error: string): void
  close(): void
}
