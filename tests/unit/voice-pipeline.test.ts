import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { PcmAudioProcessor } from '../../src/main/voice-pipeline/audio-processor'
import { VoiceTaskScheduler } from '../../src/main/voice-pipeline/task-scheduler'
import { SqliteTranscriptRepository } from '../../src/main/voice-pipeline/transcript-repository'
import type { TranscriptRecord } from '../../src/main/voice-pipeline/types'
import { SENSEVOICE_MODEL_FILES } from '../../src/main/voice-pipeline/model-manager'

const root = mkdtempSync(join(tmpdir(), 'wxe-voice-pipeline-'))

describe('SenseVoice model manifest', () => {
  it('uses the Git LFS content digest rather than the Hugging Face xet hash', () => {
    expect(SENSEVOICE_MODEL_FILES[0]).toMatchObject({
      name: 'model.int8.onnx',
      size: 239_233_841,
      sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51'
    })
    expect(SENSEVOICE_MODEL_FILES[0].sha256).not.toBe(
      'c45ba1d6a13329c4aca1dc118cabdc643ca09cb8192abb979648dd68f9917323'
    )
  })
})

function pcm16(samples: number[]): Buffer {
  const buffer = Buffer.alloc(samples.length * 2)
  samples.forEach((sample, index) => buffer.writeInt16LE(sample, index * 2))
  return buffer
}

describe('PCM audio processing', () => {
  it('really resamples 24 kHz PCM to 16 kHz and trims outer silence', () => {
    const silence = Array.from({ length: 2400 }, () => 0)
    const tone = Array.from({ length: 24000 }, (_, index) =>
      Math.round(Math.sin((index / 24000) * Math.PI * 440 * 2) * 20000)
    )
    const processor = new PcmAudioProcessor({ silencePaddingMs: 0 })
    const output = processor.process({
      pcm: pcm16([...silence, ...tone, ...silence]),
      sampleRate: 24000,
      channels: 1,
      sourceHash: 'fixture-audio'
    })

    expect(output.sampleRate).toBe(16000)
    expect(output.samples.length).toBeGreaterThan(15900)
    expect(output.samples.length).toBeLessThanOrEqual(16000)
    expect(output.durationMs).toBeGreaterThanOrEqual(990)
    expect(Math.max(...output.samples)).toBeLessThanOrEqual(0.92)
  })

  it('returns an empty signal when the source only contains silence', () => {
    const output = new PcmAudioProcessor().process({
      pcm: pcm16(Array.from({ length: 2400 }, () => 0)),
      sampleRate: 24000,
      channels: 1,
      sourceHash: 'silence'
    })
    expect(output.samples).toHaveLength(0)
  })
})

describe('voice task scheduling', () => {
  it('runs recognition tasks serially', async () => {
    const scheduler = new VoiceTaskScheduler()
    const order: string[] = []
    let releaseFirst: (() => void) | undefined
    const first = scheduler.schedule('first', async () => {
      order.push('first:start')
      await new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
      order.push('first:end')
      return 1
    })
    const second = scheduler.schedule('second', async () => {
      order.push('second')
      return 2
    })

    await vi.waitFor(() => expect(order).toEqual(['first:start']))
    releaseFirst?.()
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2])
    expect(order).toEqual(['first:start', 'first:end', 'second'])
  })

  it('cancels a queued task without running it', async () => {
    const scheduler = new VoiceTaskScheduler()
    let releaseFirst: (() => void) | undefined
    const first = scheduler.schedule(
      'first',
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve
        })
    )
    const queued = scheduler.schedule('queued', async () => 'should-not-run')
    expect(scheduler.cancel('queued')).toBe(true)
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    releaseFirst?.()
    await first
  })

  it('runs an interactive request before queued background work', async () => {
    const scheduler = new VoiceTaskScheduler()
    const order: string[] = []
    let releaseFirst: (() => void) | undefined
    const first = scheduler.schedule(
      'first',
      () =>
        new Promise<void>((resolve) => {
          order.push('first')
          releaseFirst = resolve
        })
    )
    const background = scheduler.schedule('background', async () => {
      order.push('background')
    }, { priority: 'background' })
    const interactive = scheduler.schedule('interactive', async () => {
      order.push('interactive')
    })

    await vi.waitFor(() => expect(order).toEqual(['first']))
    releaseFirst?.()
    await Promise.all([first, background, interactive])
    expect(order).toEqual(['first', 'interactive', 'background'])
  })

  it('interrupts an active background task for an interactive request', async () => {
    const scheduler = new VoiceTaskScheduler()
    const order: string[] = []
    const background = scheduler.schedule(
      'background',
      async (signal) => {
        order.push('background:start')
        await new Promise<void>((resolve) => signal.addEventListener('abort', resolve, { once: true }))
        order.push('background:aborted')
        throw new DOMException('Recognition cancelled', 'AbortError')
      },
      { priority: 'background' }
    )
    await vi.waitFor(() => expect(order).toEqual(['background:start']))
    const interactive = scheduler.schedule('interactive', async () => {
      order.push('interactive')
      return 'done'
    })

    await expect(background).rejects.toMatchObject({ name: 'AbortError' })
    await expect(interactive).resolves.toBe('done')
    expect(order).toEqual(['background:start', 'background:aborted', 'interactive'])
  })
})

describe('transcript repository', () => {
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('keeps records isolated by account and model fingerprint', () => {
    const repository = new SqliteTranscriptRepository(join(root, 'transcripts.sqlite'))
    const record: TranscriptRecord = {
      accountId: 'account-a',
      messageIdentity: 'message-1',
      audioHash: 'audio-1',
      processorVersion: 'processor-v1',
      recognizerId: 'sensevoice',
      modelVersion: 'model-v1',
      modelFingerprint: 'fingerprint-a',
      transcript: '固定测试文本',
      language: 'zh',
      durationMs: 1200,
      createdAt: 1,
      updatedAt: 1
    }
    repository.save(record)

    const key = {
      accountId: record.accountId,
      messageIdentity: record.messageIdentity,
      audioHash: record.audioHash,
      processorVersion: record.processorVersion,
      recognizerId: record.recognizerId,
      modelVersion: record.modelVersion,
      modelFingerprint: record.modelFingerprint
    }
    expect(repository.find(key)).toMatchObject({ transcript: '固定测试文本' })
    expect(repository.find({ ...key, accountId: 'account-b' })).toBeNull()
    expect(repository.find({ ...key, modelFingerprint: 'fingerprint-b' })).toBeNull()
    expect(repository.findLatest(record.accountId, record.messageIdentity)).toMatchObject({
      transcript: '固定测试文本'
    })
    expect(repository.getMessageStatus(record.accountId, record.messageIdentity)).toMatchObject({
      state: 'transcribed'
    })
    repository.markFailure('account-b', record.messageIdentity, '脱敏失败原因')
    expect(repository.getMessageStatus('account-b', record.messageIdentity)).toMatchObject({
      state: 'failed',
      error: '脱敏失败原因'
    })
    expect(repository.getMessageStatus(record.accountId, record.messageIdentity)).toMatchObject({
      state: 'transcribed'
    })
    repository.close()
  })
})
