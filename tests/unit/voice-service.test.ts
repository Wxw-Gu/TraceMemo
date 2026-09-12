import { describe, expect, it, vi } from 'vitest'
import { VoiceService } from '../../src/main/voice-service'

describe('VoiceService batch lookup', () => {
  it('writes the decoded sample rate and duration into batch WAV output', async () => {
    const getVoiceDataBatch = vi.fn().mockResolvedValue([{ success: true, hex: '0102' }])
    const service = new VoiceService({ getVoiceDataBatch } as never)
    const decoder = (service as unknown as {
      decoderRegistry: { decode: ReturnType<typeof vi.fn> }
    }).decoderRegistry
    vi.spyOn(decoder, 'decode').mockResolvedValue({
      pcm: Buffer.alloc(16_000 * 2),
      sampleRate: 16_000,
      channels: 1
    })

    const [result] = await service.resolveVoices([
      { sessionId: 'session', localId: 10, createTime: 100, svrId: '1000' }
    ])

    expect(result.success).toBe(true)
    const wav = Buffer.from(result.data!, 'base64')
    expect(wav.readUInt32LE(24)).toBe(16_000)
    expect(wav.readUInt16LE(22)).toBe(1)
    expect((wav.length - 44) / (wav.readUInt32LE(24) * wav.readUInt16LE(22) * 2)).toBe(1)
  })

  it('retries failed batch entries with the compatible single-item lookup', async () => {
    const getVoiceDataBatch = vi.fn().mockResolvedValue([
      { success: false, error: '获取语音数据失败' },
      { success: false, error: '获取语音数据失败' }
    ])
    const service = new VoiceService({ getVoiceDataBatch } as never)
    const resolveVoice = vi
      .spyOn(service, 'resolveVoice')
      .mockImplementation(async (_sessionId, localId) => ({
        success: true,
        data: `voice-${localId}`
      }))

    const result = await service.resolveVoices([
      { sessionId: 'session', localId: 10, createTime: 100, svrId: '1000' },
      { sessionId: 'session', localId: 11, createTime: 101, svrId: '1001' }
    ])

    expect(result).toEqual([
      { success: true, data: 'voice-10' },
      { success: true, data: 'voice-11' }
    ])
    expect(resolveVoice).toHaveBeenCalledTimes(2)
    expect(resolveVoice).toHaveBeenNthCalledWith(1, 'session', 10, 100, '1000')
    expect(resolveVoice).toHaveBeenNthCalledWith(2, 'session', 11, 101, '1001')
  })

  it('keeps same local ids isolated by session and server identity, then reuses the exact cache entries', async () => {
    const getVoiceDataBatch = vi
      .fn()
      .mockResolvedValue([
        { success: true, hex: '0102' },
        { success: true, hex: '0304' },
        { success: true, hex: '0506' }
      ])
    const service = new VoiceService({ getVoiceDataBatch } as never, '/accounts/fixture-a')
    const decoder = (service as unknown as {
      decoderRegistry: { decode: ReturnType<typeof vi.fn> }
    }).decoderRegistry
    vi.spyOn(decoder, 'decode').mockImplementation(async (source: { data: Buffer }) => ({
      pcm: Buffer.from([source.data[0]]),
      sampleRate: 16_000,
      channels: 1
    }))

    const references = [
      { sessionId: 'session-a', localId: 7, createTime: 100, svrId: 'same-second-a' },
      { sessionId: 'session-b', localId: 7, createTime: 100, svrId: 'same-second-a' },
      { sessionId: 'session-a', localId: 7, createTime: 100, svrId: 'same-second-b' }
    ]
    const first = await service.resolveVoices(references)
    expect(first.every((item) => item.success)).toBe(true)
    expect(new Set(first.map((item) => item.data)).size).toBe(3)
    expect(getVoiceDataBatch).toHaveBeenCalledOnce()

    const second = await service.resolveVoices(references)
    expect(second).toEqual(first)
    expect(getVoiceDataBatch).toHaveBeenCalledOnce()
  })

  it('versions the in-memory namespace per account so a restarted or switched account cannot reuse old audio', async () => {
    const client = {
      getVoiceDataBatch: vi.fn().mockResolvedValue([{ success: true, hex: '0102' }]),
      getAccountRoot: () => '/accounts/fixture-a'
    }
    const first = new VoiceService(client as never)
    const second = new VoiceService(
      { ...client, getAccountRoot: () => '/accounts/fixture-b' } as never
    )
    const decode = (service: VoiceService, value: number): void => {
      const decoder = (service as unknown as {
        decoderRegistry: { decode: ReturnType<typeof vi.fn> }
      }).decoderRegistry
      vi.spyOn(decoder, 'decode').mockResolvedValue({
        pcm: Buffer.from([value]),
        sampleRate: 16_000,
        channels: 1
      })
    }
    decode(first, 1)
    decode(second, 2)
    const firstCache = (first as unknown as { voiceCache: Map<string, string> }).voiceCache
    const secondCache = (second as unknown as { voiceCache: Map<string, string> }).voiceCache
    await expect(first.resolveVoices([{ sessionId: 'session', localId: 1, createTime: 2 }])).resolves.toHaveLength(1)
    await expect(second.resolveVoices([{ sessionId: 'session', localId: 1, createTime: 2 }])).resolves.toHaveLength(1)
    expect([...firstCache.keys()][0]).not.toBe([...secondCache.keys()][0])
    expect(client.getVoiceDataBatch).toHaveBeenCalledTimes(2)
  })
})
