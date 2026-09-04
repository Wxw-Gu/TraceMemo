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
})
