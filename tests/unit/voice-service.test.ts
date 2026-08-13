import { describe, expect, it, vi } from 'vitest'
import { VoiceService } from '../../src/main/voice-service'

describe('VoiceService batch lookup', () => {
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
