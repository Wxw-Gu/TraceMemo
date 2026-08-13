import { createHash } from 'crypto'
import { Wcdb4Client } from './wcdb4-client'
import {
  createDefaultAudioDecoderRegistry,
  type EncodedVoiceSource
} from './voice-pipeline/audio-decoder'

export {
  findSilkWasmRuntimeLocation,
  getSilkWasmRuntimeLocations,
  type SilkWasmRuntimeLocation
} from './voice-pipeline/audio-decoder'

export interface ResolvedPcmAudio {
  pcm: Buffer
  sampleRate: number
  channels: number
  codec: 'silk'
  sourceHash: string
}

export type ResolvePcmResult =
  | { success: true; audio: ResolvedPcmAudio }
  | { success: false; error: string }

export type ResolveSourceResult =
  | { success: true; source: EncodedVoiceSource }
  | { success: false; error: string }

export interface VoiceReference {
  sessionId: string
  localId: number
  createTime: number
  svrId?: string | number
}

export class VoiceService {
  private wcdb4Client: Wcdb4Client
  private voiceCache = new Map<string, string>()
  private pcmCache = new Map<string, ResolvedPcmAudio>()
  private readonly decoderRegistry = createDefaultAudioDecoderRegistry()

  constructor(wcdb4Client: Wcdb4Client) {
    this.wcdb4Client = wcdb4Client
  }

  async resolveVoice(
    sessionId: string,
    localId: number,
    createTime: number,
    svrId?: string | number
  ): Promise<{ success: boolean; data?: string; error?: string }> {
    const cacheKey = this.buildCacheKey(sessionId, localId, createTime)

    const cached = this.voiceCache.get(cacheKey)
    if (cached) {
      console.log('[VoiceService] cache hit for', cacheKey)
      return { success: true, data: cached }
    }

    const pcmResult = await this.resolvePcm(sessionId, localId, createTime, svrId)
    if (!pcmResult.success) return pcmResult
    const pcmData = pcmResult.audio.pcm

    const wavData = this.createWavBuffer(pcmData, 24000)
    console.log(
      '[VoiceService] wavData length:',
      wavData.length,
      'base64 length:',
      wavData.toString('base64').length
    )

    const base64Data = wavData.toString('base64')

    this.voiceCache.set(cacheKey, base64Data)

    return { success: true, data: base64Data }
  }

  async resolveVoices(
    references: VoiceReference[]
  ): Promise<Array<{ success: boolean; data?: string; error?: string }>> {
    const results: Array<{ success: boolean; data?: string; error?: string } | undefined> =
      new Array(references.length)
    const missing: Array<{ index: number; reference: VoiceReference }> = []
    references.forEach((reference, index) => {
      const cached = this.voiceCache.get(
        this.buildCacheKey(reference.sessionId, reference.localId, reference.createTime)
      )
      if (cached) results[index] = { success: true, data: cached }
      else missing.push({ index, reference })
    })
    if (!missing.length)
      return results as Array<{ success: boolean; data?: string; error?: string }>

    const sources = await this.wcdb4Client.getVoiceDataBatch(
      missing.map(({ reference }) => ({
        sessionId: reference.sessionId,
        createTime: reference.createTime,
        localId: reference.localId,
        svrId: reference.svrId,
        candidates: this.buildCandidates(reference.sessionId)
      }))
    )
    const failed: Array<{ index: number; reference: VoiceReference }> = []
    for (const [{ index, reference }, source] of missing.map(
      (item, sourceIndex) => [item, sources[sourceIndex]] as const
    )) {
      if (!source?.success || !source.hex) {
        failed.push({ index, reference })
        continue
      }
      const silkData = this.decodeVoiceBlob(source.hex)
      if (!silkData?.length) {
        results[index] = { success: false, error: '语音数据为空' }
        continue
      }
      try {
        const decoded = await this.decoderRegistry.decode({
          data: silkData,
          codec: 'silk',
          sourceHash: createHash('sha256').update(silkData).digest('hex')
        })
        const wavData = this.createWavBuffer(decoded.pcm, 24000)
        const data = wavData.toString('base64')
        const cacheKey = this.buildCacheKey(
          reference.sessionId,
          reference.localId,
          reference.createTime
        )
        this.voiceCache.set(cacheKey, data)
        this.pcmCache.set(cacheKey, { ...decoded, codec: 'silk' })
        results[index] = { success: true, data }
      } catch (error) {
        results[index] = {
          success: false,
          error: error instanceof Error ? error.message : 'Silk 解码失败'
        }
      }
    }
    const retried = await Promise.all(
      failed.map(({ reference }) =>
        this.resolveVoice(
          reference.sessionId,
          reference.localId,
          reference.createTime,
          reference.svrId
        )
      )
    )
    failed.forEach(({ index }, retryIndex) => {
      results[index] = retried[retryIndex]
    })
    return results as Array<{ success: boolean; data?: string; error?: string }>
  }

  async resolvePcm(
    sessionId: string,
    localId: number,
    createTime: number,
    svrId?: string | number
  ): Promise<ResolvePcmResult> {
    const cacheKey = this.buildCacheKey(sessionId, localId, createTime)
    const cached = this.pcmCache.get(cacheKey)
    if (cached) return { success: true, audio: cached }

    const sourceResult = await this.resolveSource(sessionId, localId, createTime, svrId)
    if (!sourceResult.success) return sourceResult

    try {
      const decoded = await this.decoderRegistry.decode(sourceResult.source)
      const audio: ResolvedPcmAudio = { ...decoded, codec: 'silk' }
      this.pcmCache.set(cacheKey, audio)
      return { success: true, audio }
    } catch (error) {
      console.error('[VoiceService] audio decode failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Silk 解码失败' }
    }
  }

  async resolveSource(
    sessionId: string,
    localId: number,
    createTime: number,
    svrId?: string | number
  ): Promise<ResolveSourceResult> {
    const candidates = this.buildCandidates(sessionId)
    const voiceResult = await this.wcdb4Client.getVoiceData(
      sessionId,
      createTime,
      candidates,
      localId,
      svrId || 0
    )
    if (!voiceResult.success || !voiceResult.hex) {
      return { success: false, error: voiceResult.error || '获取语音数据失败' }
    }

    const silkData = this.decodeVoiceBlob(voiceResult.hex)
    if (!silkData?.length) return { success: false, error: '语音数据为空' }

    return {
      success: true,
      source: {
        data: silkData,
        codec: 'silk',
        sourceHash: createHash('sha256').update(silkData).digest('hex')
      }
    }
  }

  private buildCacheKey(sessionId: string, localId: number, createTime: number): string {
    return `${sessionId}-${localId}-${createTime}`
  }

  private buildCandidates(sessionId: string): string[] {
    const candidates: string[] = [sessionId]
    if (sessionId.endsWith('@chatroom')) {
      candidates.push(sessionId.replace('@chatroom', ''))
    }
    return candidates
  }

  private decodeVoiceBlob(hex: string): Buffer | null {
    try {
      const hexClean = hex.replace(/\s+/g, '')
      if (!/^[0-9a-fA-F]+$/.test(hexClean)) {
        return null
      }
      return Buffer.from(hexClean, 'hex')
    } catch {
      return null
    }
  }

  private createWavBuffer(
    pcmData: Buffer,
    sampleRate: number = 24000,
    channels: number = 1
  ): Buffer {
    const pcmLength = pcmData.length
    const header = Buffer.alloc(44)
    header.write('RIFF', 0)
    header.writeUInt32LE(36 + pcmLength, 4)
    header.write('WAVE', 8)
    header.write('fmt ', 12)
    header.writeUInt32LE(16, 16)
    header.writeUInt16LE(1, 20)
    header.writeUInt16LE(channels, 22)
    header.writeUInt32LE(sampleRate, 24)
    header.writeUInt32LE(sampleRate * channels * 2, 28)
    header.writeUInt16LE(channels * 2, 32)
    header.writeUInt16LE(16, 34)
    header.write('data', 36)
    header.writeUInt32LE(pcmLength, 40)
    return Buffer.concat([header, pcmData])
  }
}
