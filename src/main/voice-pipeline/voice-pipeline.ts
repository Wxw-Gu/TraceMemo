import { createHash } from 'crypto'
import type { VoiceMessageReference } from '../../shared/voice-recognition'
import type { VoiceService } from '../voice-service'
import type { AudioDecoderRegistry, EncodedVoiceSource } from './audio-decoder'
import type {
  AudioProcessor,
  SourceResolver,
  SpeechRecognizer,
  TranscriptRecord,
  TranscriptRepository
} from './types'

export class VoiceSourceResolver implements SourceResolver {
  constructor(private readonly voiceService: VoiceService) {}

  async resolve(reference: VoiceMessageReference): Promise<EncodedVoiceSource> {
    const result = await this.voiceService.resolveSource(
      reference.sessionId,
      reference.localId,
      reference.createTime,
      reference.svrId
    )
    if (!result.success) throw new Error(result.error)
    return result.source
  }
}

export class VoicePipeline {
  constructor(
    private readonly sourceResolver: SourceResolver,
    private readonly decoderRegistry: AudioDecoderRegistry,
    private readonly audioProcessor: AudioProcessor,
    private readonly recognizer: SpeechRecognizer,
    private readonly transcripts: TranscriptRepository
  ) {}

  async run(
    accountId: string,
    reference: VoiceMessageReference,
    signal?: AbortSignal
  ): Promise<{ transcript: string; language?: string; durationMs: number; cached: boolean }> {
    const source = await this.sourceResolver.resolve(reference)
    if (signal?.aborted) throw new DOMException('Recognition cancelled', 'AbortError')
    const decoded = await this.decoderRegistry.decode(source)
    if (signal?.aborted) throw new DOMException('Recognition cancelled', 'AbortError')
    const audio = this.audioProcessor.process(decoded)
    if (audio.samples.length === 0) throw new Error('Voice audio is empty after processing')
    const messageIdentity = createHash('sha256')
      .update(
        `${reference.sessionId}|${reference.localId}|${reference.createTime}|${reference.svrId ?? ''}`
      )
      .digest('hex')
    const key = {
      accountId,
      messageIdentity,
      audioHash: audio.sourceHash,
      processorVersion: audio.processorVersion,
      ...this.recognizer.metadata
    }
    const cached = this.transcripts.find(key)
    if (cached) {
      return {
        transcript: cached.transcript,
        language: cached.language,
        durationMs: cached.durationMs,
        cached: true
      }
    }

    const output = await this.recognizer.recognize(audio, signal)
    const now = Date.now()
    const record: TranscriptRecord = {
      ...key,
      transcript: output.text,
      language: output.language,
      durationMs: audio.durationMs,
      createdAt: now,
      updatedAt: now
    }
    this.transcripts.save(record)
    return {
      transcript: output.text,
      language: output.language,
      durationMs: audio.durationMs,
      cached: false
    }
  }
}
