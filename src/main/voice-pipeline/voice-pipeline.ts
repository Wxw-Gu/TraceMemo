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
import { voiceMessageIdentity } from './voice-message-identity'

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
    signal?: AbortSignal,
    options?: { force?: boolean }
  ): Promise<{ transcript: string; language?: string; durationMs: number; cached: boolean }> {
    const messageIdentity = voiceMessageIdentity(reference)
    /*
     * findCompatible 只按消息身份匹配，不含 audio_hash：音频被换掉（例如取音频的
     * 逻辑修好后）时它仍会命中旧记录。用户主动触发的识别必须跳过它，重新取一次
     * 音频 —— 音频级缓存 find(key) 带 audio_hash，才是正确的失效机制。
     */
    if (!options?.force) {
      const compatible = this.transcripts.findCompatible({
        accountId,
        messageIdentity,
        processorVersion: this.audioProcessor.version,
        ...this.recognizer.metadata
      })
      if (compatible?.transcript.trim()) {
        return {
          transcript: compatible.transcript.trim(),
          language: compatible.language,
          durationMs: compatible.durationMs,
          cached: true
        }
      }
    }

    const source = await this.sourceResolver.resolve(reference)
    if (signal?.aborted) throw new DOMException('Recognition cancelled', 'AbortError')
    const decoded = await this.decoderRegistry.decode(source)
    if (signal?.aborted) throw new DOMException('Recognition cancelled', 'AbortError')
    const audio = this.audioProcessor.process(decoded)
    if (audio.samples.length === 0) throw new Error('Voice audio is empty after processing')
    const key = {
      accountId,
      messageIdentity,
      audioHash: audio.sourceHash,
      processorVersion: audio.processorVersion,
      ...this.recognizer.metadata
    }
    const cached = this.transcripts.find(key)
    if (cached?.transcript.trim()) {
      return {
        transcript: cached.transcript.trim(),
        language: cached.language,
        durationMs: cached.durationMs,
        cached: true
      }
    }

    const output = await this.recognizer.recognize(audio, signal)
    const transcript = output.text.trim()
    if (!transcript) throw new Error('Voice recognition produced an empty transcript')
    const now = Date.now()
    const record: TranscriptRecord = {
      ...key,
      transcript,
      language: output.language,
      durationMs: audio.durationMs,
      createdAt: now,
      updatedAt: now
    }
    this.transcripts.save(record)
    return {
      transcript,
      language: output.language,
      durationMs: audio.durationMs,
      cached: false
    }
  }
}
