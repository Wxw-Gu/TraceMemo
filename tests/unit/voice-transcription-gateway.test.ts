import { describe, expect, it, vi, type Mock } from 'vitest'
import type {
  VoiceMessageReference,
  VoiceModelStatus,
  VoiceRecognitionResult,
  VoiceTranscriptSnapshot
} from '../../src/shared/voice-recognition'
import { VoiceTranscriptionGateway } from '../../src/main/voice-pipeline/voice-transcription-gateway'

const reference = (localId: number): VoiceMessageReference => ({
  sessionId: 'wxid_fixture_member',
  localId,
  createTime: 1_785_895_200 + localId
})

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

type RecognitionStub = {
  accountIdentity: string
  getModelStatus: Mock<() => Promise<Pick<VoiceModelStatus, 'state'>>>
  getTranscriptSnapshot: Mock<(reference: VoiceMessageReference) => VoiceTranscriptSnapshot>
  recognize: Mock<(...args: unknown[]) => Promise<VoiceRecognitionResult>>
}

function makeRecognition(): RecognitionStub {
  return {
    accountIdentity: 'account-a',
    getModelStatus: vi.fn(async () => ({ state: 'ready' as const })),
    getTranscriptSnapshot: vi.fn(() => ({ state: 'pending' as const })),
    recognize: vi.fn(async () => ({
      success: true,
      transcript: ' 转写结果 ',
      cached: false,
      durationMs: 1200
    }))
  }
}

describe('VoiceTranscriptionGateway', () => {
  it('returns cached transcripts without scheduling recognition', async () => {
    const recognition = makeRecognition()
    recognition.getTranscriptSnapshot.mockReturnValue({
      state: 'transcribed',
      transcript: '已转写'
    })
    const gateway = new VoiceTranscriptionGateway(recognition as never)

    const result = await gateway.transcribe([reference(1)], { waitMs: 1000 })

    expect(result).toEqual([{ state: 'transcribed', transcript: '已转写', cached: true }])
    expect(recognition.recognize).not.toHaveBeenCalled()
  })

  it('does not rerun previously failed voice unless force is set', async () => {
    const recognition = makeRecognition()
    recognition.getTranscriptSnapshot.mockReturnValue({ state: 'failed', error: 'decode failed' })
    const gateway = new VoiceTranscriptionGateway(recognition as never)

    await expect(gateway.transcribe([reference(1)], { waitMs: 1000 })).resolves.toEqual([
      { state: 'failed', code: 'PREVIOUSLY_FAILED', error: 'decode failed' }
    ])
    expect(recognition.recognize).not.toHaveBeenCalled()

    await expect(
      gateway.transcribe([reference(1)], { force: true, waitMs: 1000 })
    ).resolves.toEqual([
      { state: 'transcribed', transcript: '转写结果', cached: false, durationMs: 1200 }
    ])
    expect(recognition.recognize).toHaveBeenCalledWith(reference(1), {
      priority: 'background',
      force: true
    })
  })

  it('returns pending at the deadline and lets the next call join the same task', async () => {
    const recognition = makeRecognition()
    const running = deferred<VoiceRecognitionResult>()
    recognition.recognize.mockReturnValue(running.promise)
    const gateway = new VoiceTranscriptionGateway(recognition as never)

    await expect(gateway.transcribe([reference(1)], { waitMs: 0 })).resolves.toEqual([
      { state: 'pending' }
    ])
    expect(gateway.inFlightCount).toBe(1)

    const second = gateway.transcribe([reference(1)], { waitMs: 1000 })
    running.resolve({ success: true, transcript: '晚到的结果', cached: false })

    await expect(second).resolves.toEqual([
      { state: 'transcribed', transcript: '晚到的结果', cached: false }
    ])
    expect(recognition.recognize).toHaveBeenCalledTimes(1)
    expect(gateway.inFlightCount).toBe(0)
  })

  it('rejects the whole request when the queue cannot take the new work', async () => {
    const recognition = makeRecognition()
    recognition.recognize.mockReturnValue(new Promise(() => undefined))
    const gateway = new VoiceTranscriptionGateway(recognition as never, 2)

    await gateway.transcribe([reference(1)], { waitMs: 0 })
    await expect(
      gateway.transcribe([reference(2), reference(3)], { waitMs: 0 })
    ).resolves.toBeNull()

    expect(recognition.recognize).toHaveBeenCalledTimes(1)
    expect(gateway.inFlightCount).toBe(1)
  })

  it('requeues an item preempted by an interactive request', async () => {
    const recognition = makeRecognition()
    recognition.recognize
      .mockResolvedValueOnce({ success: false, code: 'CANCELLED', error: '语音识别已取消' })
      .mockResolvedValueOnce({ success: true, transcript: '重排后完成', cached: false })
    const gateway = new VoiceTranscriptionGateway(recognition as never)

    await expect(gateway.transcribe([reference(1)], { waitMs: 1000 })).resolves.toEqual([
      { state: 'transcribed', transcript: '重排后完成', cached: false }
    ])
    expect(recognition.recognize).toHaveBeenCalledTimes(2)
  })

  it('stops requeueing after the account changes', async () => {
    const recognition = makeRecognition()
    recognition.recognize.mockImplementation(async () => {
      recognition.accountIdentity = 'account-b'
      return { success: false, code: 'CANCELLED', error: '语音识别已取消' }
    })
    const gateway = new VoiceTranscriptionGateway(recognition as never)

    await expect(gateway.transcribe([reference(1)], { waitMs: 1000 })).resolves.toEqual([
      { state: 'failed', code: 'CANCELLED', error: '语音识别已取消' }
    ])
    expect(recognition.recognize).toHaveBeenCalledTimes(1)
  })
})
