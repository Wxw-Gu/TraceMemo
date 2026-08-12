import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VoiceRecognitionUseCase } from '../../src/main/voice-pipeline/voice-recognition-use-case'

const roots: string[] = []

function createUseCase(): VoiceRecognitionUseCase {
  const root = mkdtempSync(join(tmpdir(), 'wxe-voice-use-case-'))
  roots.push(root)
  const useCase = new VoiceRecognitionUseCase({
    modelRoot: join(root, 'model'),
    databasePath: join(root, 'transcripts.sqlite'),
    workerPath: join(root, 'unused-worker.js')
  })
  const state = useCase as unknown as {
    accountId: string
    accountGeneration: number
    pipeline: { run: ReturnType<typeof vi.fn> }
  }
  state.accountId = 'account-a'
  state.accountGeneration = 1
  state.pipeline = { run: vi.fn() }
  vi.spyOn(useCase.modelManager, 'getStatus').mockResolvedValue({
    modelId: 'sensevoice-small-int8',
    version: 'fixture',
    state: 'ready',
    downloadedBytes: 1,
    totalBytes: 1,
    progress: 1,
    platform: 'win32',
    architecture: 'x64',
    supported: true
  })
  return useCase
}

afterEach(async () => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('VoiceRecognitionUseCase transcript updates', () => {
  it('publishes a successful cache hit through the same update path as fresh recognition', async () => {
    const useCase = createUseCase()
    const state = useCase as unknown as {
      pipeline: { run: ReturnType<typeof vi.fn> }
    }
    state.pipeline.run.mockResolvedValue({
      transcript: '缓存命中的语音文字',
      durationMs: 1_200,
      cached: true
    })
    const listener = vi.fn().mockResolvedValue(undefined)
    useCase.onTranscriptUpdate(listener)
    const reference = { sessionId: 'fixture-contact', localId: 9, createTime: 1_785_895_200 }

    const result = await useCase.recognize(reference)

    expect(result).toMatchObject({ success: true, cached: true, transcript: '缓存命中的语音文字' })
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        accountIdentity: 'account-a',
        reference,
        state: 'transcribed',
        transcript: '缓存命中的语音文字',
        cached: true
      })
    )
    await useCase.dispose()
  })

  it('does not publish a transcript after the account generation changes mid-recognition', async () => {
    const useCase = createUseCase()
    let finish:
      | ((value: { transcript: string; durationMs: number; cached: boolean }) => void)
      | undefined
    const state = useCase as unknown as {
      accountGeneration: number
      pipeline: { run: ReturnType<typeof vi.fn> }
    }
    state.pipeline.run.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const listener = vi.fn()
    useCase.onTranscriptUpdate(listener)
    const pending = useCase.recognize({
      sessionId: 'fixture-contact',
      localId: 10,
      createTime: 1_785_895_201
    })
    await vi.waitFor(() => expect(state.pipeline.run).toHaveBeenCalledOnce())
    state.accountGeneration += 1
    finish?.({ transcript: '不应写入新账号', durationMs: 600, cached: false })

    await expect(pending).resolves.toMatchObject({ success: false, code: 'CANCELLED' })
    expect(listener).not.toHaveBeenCalled()
    await useCase.dispose()
  })

  it('publishes an explicit cached transcript for a coalesced export index refresh', async () => {
    const useCase = createUseCase()
    const listener = vi.fn().mockResolvedValue(undefined)
    useCase.onTranscriptUpdate(listener)
    const reference = { sessionId: 'fixture-contact', localId: 11, createTime: 1_785_895_202 }

    await useCase.publishTranscript(reference, '缓存导出文字', true)

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        accountIdentity: 'account-a',
        reference,
        state: 'transcribed',
        transcript: '缓存导出文字',
        cached: true
      })
    )
    await useCase.dispose()
  })
})
