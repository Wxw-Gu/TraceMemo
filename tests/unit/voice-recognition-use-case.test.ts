import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { VoiceRecognitionUseCase } from '../../src/main/voice-pipeline/voice-recognition-use-case'

/**
 * 这组用例验证的是**转写更新的编排**：命中缓存/新识别是否走同一条 update path、
 * 账号代号中途变化时是否取消发布、force 是否透传给 pipeline。真正的
 * `pipeline.run` 与 `modelManager.getStatus` 都被 mock，所以**不需要真实的
 * 文件系统或 SQLite**。
 *
 * 用内存库 + 纯字符串路径（不建目录、不落盘、不删除）：
 * `SqliteTranscriptRepository` 一旦落盘就会连带生成 `-wal` / `-shm`，
 * 每个用例还要 `rmSync` 整棵临时树 —— 这些在 Windows runner 上（Defender 实时扫描
 * 每次文件创建/删除）会放大到秒级，而对被测行为零贡献。
 */
function createUseCase(): VoiceRecognitionUseCase {
  const root = join('wxe-voice-use-case-fixture', 'account-a')
  const useCase = new VoiceRecognitionUseCase({
    modelRoot: join(root, 'model'),
    databasePath: ':memory:',
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

  it('forwards force to the pipeline so manual re-recognition can bypass the identity cache', async () => {
    const useCase = createUseCase()
    const state = useCase as unknown as {
      pipeline: { run: ReturnType<typeof vi.fn> }
    }
    state.pipeline.run.mockResolvedValue({
      transcript: '重新识别的文字',
      durationMs: 900,
      cached: false
    })
    const reference = { sessionId: 'fixture-contact', localId: 12, createTime: 1_785_895_203 }

    const result = await useCase.recognize(reference, { force: true })

    expect(result).toMatchObject({ success: true, transcript: '重新识别的文字' })
    expect(state.pipeline.run).toHaveBeenCalledWith(
      'account-a',
      reference,
      expect.anything(),
      { force: true }
    )
    await useCase.dispose()
  })

  it('leaves force undefined when the caller does not ask for a recompute', async () => {
    const useCase = createUseCase()
    const state = useCase as unknown as {
      pipeline: { run: ReturnType<typeof vi.fn> }
    }
    state.pipeline.run.mockResolvedValue({ transcript: '缓存文字', durationMs: 900, cached: true })
    const reference = { sessionId: 'fixture-contact', localId: 13, createTime: 1_785_895_204 }

    await useCase.recognize(reference)

    expect(state.pipeline.run).toHaveBeenCalledWith(
      'account-a',
      reference,
      expect.anything(),
      { force: undefined }
    )
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
