import { describe, expect, it, vi } from 'vitest'
import type { Message } from '../../src/shared/types'
import type { VoiceModelStatus } from '../../src/shared/voice-recognition'
import {
  toVoiceMessageReference,
  transcribeVoiceMessages,
  type VoiceTranscriptionProgress
} from '../../src/renderer/src/utils/voice-message-reference'

const status = (state: VoiceModelStatus['state']): VoiceModelStatus =>
  ({
    modelId: 'fixture',
    version: '1',
    state,
    downloadedBytes: 1,
    totalBytes: 1,
    progress: 1,
    platform: 'win32',
    architecture: 'x64',
    supported: true
  }) as VoiceModelStatus

const voice = (id: string, localId: number, transcript?: string): Message => ({
  id,
  from: 'member',
  type: '语音',
  datetime: '2026-08-10 10:00:00',
  content: '[语音]',
  isSender: false,
  sessionId: 'session',
  localId,
  createTime: 1_786_320_000,
  contentData: { type: 'voice', duration: 2 },
  voiceTranscript: transcript
})

describe('daily report voice transcription', () => {
  it('creates a local voice reference from a parsed message', () => {
    expect(toVoiceMessageReference(voice('voice-1', 7))).toEqual({
      sessionId: 'session',
      localId: 7,
      createTime: 1_786_320_000,
      svrId: undefined
    })
  })

  it('reuses cached text and reports success/failure progress', async () => {
    const recognize = vi
      .fn()
      .mockResolvedValueOnce({ success: true, transcript: '新转写内容' })
      .mockResolvedValueOnce({ success: false, error: '音频缺失' })
    const onProgress = vi.fn<(progress: VoiceTranscriptionProgress) => void>()
    const result = await transcribeVoiceMessages(
      [voice('cached', 1, '缓存内容'), voice('fresh', 2), voice('failed', 3)],
      {
        getModelStatus: vi.fn(async () => status('ready')),
        recognize,
        onProgress
      }
    )

    expect(result.map((message) => message.voiceTranscript)).toEqual([
      '缓存内容',
      '新转写内容',
      undefined
    ])
    expect(result[2].voiceTranscriptError).toBe('音频缺失')
    expect(recognize).toHaveBeenCalledTimes(2)
    expect(onProgress).toHaveBeenLastCalledWith({
      processed: 3,
      total: 3,
      succeeded: 2,
      failed: 1
    })
  })

  it('normalizes legacy voice messages without contentData for report facts', async () => {
    const legacy = { ...voice('legacy', 4), contentData: undefined }
    const result = await transcribeVoiceMessages([legacy], {
      getModelStatus: vi.fn(async () => status('ready')),
      recognize: vi.fn(async () => ({ success: true, transcript: '日报语音内容' })),
      onProgress: vi.fn()
    })

    expect(result[0]).toMatchObject({
      voiceTranscript: '日报语音内容',
      contentData: { type: 'voice' }
    })
  })

  it('does not require the model when every transcript is cached', async () => {
    const getModelStatus = vi.fn(async () => status('missing'))
    const recognize = vi.fn()
    const result = await transcribeVoiceMessages([voice('cached', 1, '已有文本')], {
      getModelStatus,
      recognize,
      onProgress: vi.fn()
    })

    expect(result[0].voiceTranscript).toBe('已有文本')
    expect(getModelStatus).not.toHaveBeenCalled()
    expect(recognize).not.toHaveBeenCalled()
  })

  it('hydrates persisted transcript cache before invoking recognition', async () => {
    const getModelStatus = vi.fn(async () => status('missing'))
    const getCachedTranscript = vi.fn(async () => ({
      state: 'transcribed' as const,
      transcript: '持久化缓存内容'
    }))
    const recognize = vi.fn()
    const result = await transcribeVoiceMessages([voice('persisted', 8)], {
      getModelStatus,
      getCachedTranscript,
      recognize,
      onProgress: vi.fn()
    })

    expect(result[0].voiceTranscript).toBe('持久化缓存内容')
    expect(getCachedTranscript).toHaveBeenCalledOnce()
    expect(getModelStatus).not.toHaveBeenCalled()
    expect(recognize).not.toHaveBeenCalled()
  })

  it('stops before recognition when the local model is not ready', async () => {
    const recognize = vi.fn()
    await expect(
      transcribeVoiceMessages([voice('pending', 1)], {
        getModelStatus: vi.fn(async () => status('missing')),
        recognize,
        onProgress: vi.fn()
      })
    ).rejects.toThrow('准备离线语音识别模型')
    expect(recognize).not.toHaveBeenCalled()
  })

  it('counts a voice message with incomplete local identifiers as failed', async () => {
    const incomplete = { ...voice('incomplete', 1), sessionId: undefined }
    const onProgress = vi.fn<(progress: VoiceTranscriptionProgress) => void>()
    const result = await transcribeVoiceMessages([incomplete], {
      getModelStatus: vi.fn(async () => status('ready')),
      recognize: vi.fn(),
      onProgress
    })

    expect(result[0].voiceTranscriptError).toContain('标识不完整')
    expect(onProgress).toHaveBeenLastCalledWith({
      processed: 1,
      total: 1,
      succeeded: 0,
      failed: 1
    })
  })
})
