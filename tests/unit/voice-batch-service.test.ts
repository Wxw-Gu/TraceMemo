import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { VoiceRecognitionUseCase } from '../../src/main/voice-pipeline/voice-recognition-use-case'

const { countVoiceMessagesAsync, listContactsAsync, listMessagesAsync } = vi.hoisted(() => ({
  countVoiceMessagesAsync: vi.fn(),
  listContactsAsync: vi.fn(),
  listMessagesAsync: vi.fn()
}))

vi.mock('../../src/main/services/chat-service', () => ({
  countVoiceMessagesAsync,
  listContactsAsync,
  listMessagesAsync
}))

import { VoiceBatchService } from '../../src/main/voice-pipeline/voice-batch-service'

const readyStatus = {
  modelId: 'sensevoice-small-int8',
  version: 'fixture',
  state: 'ready' as const,
  downloadedBytes: 1,
  totalBytes: 1,
  progress: 1,
  platform: 'win32' as const,
  architecture: 'x64',
  supported: true
}

function makeRecognition(): VoiceRecognitionUseCase {
  return {
    accountIdentity: 'account-a',
    getModelStatus: vi.fn().mockResolvedValue(readyStatus),
    getTranscriptSnapshot: vi.fn().mockReturnValue({ state: 'pending' }),
    recognize: vi.fn().mockResolvedValue({ success: true, transcript: '转写结果', cached: false }),
    publishTranscriptSnapshot: vi.fn().mockResolvedValue(undefined)
  } as unknown as VoiceRecognitionUseCase
}

describe('VoiceBatchService', () => {
  beforeEach(() => {
    listContactsAsync.mockReset()
    listMessagesAsync.mockReset()
    countVoiceMessagesAsync.mockReset()
    listContactsAsync.mockResolvedValue([
      { md5: 'contact-a', m_nsUsrName: 'contact-a-id', m_nsNickName: '联系人 A', type: 'user' },
      { md5: 'group-b', m_nsUsrName: 'group-b@chatroom', m_nsNickName: '群聊 B', type: 'group' }
    ])
    listMessagesAsync.mockImplementation(async (conversationId: string) => [
      {
        id: `${conversationId}-voice`,
        type: '语音',
        content: '[语音消息]',
        isSender: false,
        sessionId: conversationId === 'contact-a' ? 'contact-a-id' : 'group-b@chatroom',
        localId: conversationId === 'contact-a' ? 11 : 22,
        createTime: 1_785_895_200
      },
      {
        id: `${conversationId}-text`,
        type: '普通文本',
        content: '不会进入语音任务',
        isSender: false,
        createTime: 1_785_895_201
      }
    ])
    countVoiceMessagesAsync.mockImplementation(async (conversationId: string) =>
      conversationId === 'contact-a' ? 3 : 7
    )
  })

  it('limits a batch to selected contacts and groups, then schedules each item as background work', async () => {
    const recognition = makeRecognition()
    const service = new VoiceBatchService(recognition)
    const preflight = await service.preflight({
      conversationIds: ['contact-a', 'group-b'],
      range: 'recent_30_days'
    })

    expect(preflight).toMatchObject({
      conversationCount: 2,
      voiceMessageCount: 2,
      cachedCount: 0,
      pendingCount: 2,
      modelReady: true
    })
    expect(listMessagesAsync).toHaveBeenCalledTimes(2)
    expect(listMessagesAsync.mock.calls[0][1]).toEqual(expect.any(Number))

    await service.start({ conversationIds: ['contact-a'], range: 'selected_history' })
    await vi.waitFor(() => expect(service.getProgress().state).toBe('completed'))
    expect(recognition.recognize).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'contact-a-id', localId: 11 }),
      { priority: 'background', publishTranscriptUpdate: false }
    )
    expect(recognition.recognize).toHaveBeenCalledTimes(1)
    await vi.waitFor(() =>
      expect(recognition.publishTranscriptSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'contact-a-id', localId: 11 })
      )
    )
  })

  it('defers knowledge notifications until the batch finishes and sends one per conversation', async () => {
    listMessagesAsync.mockResolvedValue([
      {
        id: 'contact-a-voice-1',
        type: '语音',
        content: '[语音消息]',
        isSender: false,
        sessionId: 'contact-a-id',
        localId: 11,
        createTime: 1_785_895_200
      },
      {
        id: 'contact-a-voice-2',
        type: '语音',
        content: '[语音消息]',
        isSender: false,
        sessionId: 'contact-a-id',
        localId: 12,
        createTime: 1_785_895_201
      }
    ])
    const recognition = makeRecognition()
    let releaseKnowledgeRefresh: (() => void) | undefined
    vi.mocked(recognition.publishTranscriptSnapshot).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseKnowledgeRefresh = resolve
        })
    )
    const service = new VoiceBatchService(recognition)

    await service.start({ conversationIds: ['contact-a'], range: 'selected_history' })
    await vi.waitFor(() => expect(recognition.publishTranscriptSnapshot).toHaveBeenCalledTimes(1))
    expect(service.getProgress().state).toBe('processing')
    releaseKnowledgeRefresh?.()
    await vi.waitFor(() => expect(service.getProgress().state).toBe('completed'))

    expect(recognition.recognize).toHaveBeenCalledTimes(2)
    expect(recognition.recognize).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ publishTranscriptUpdate: false })
    )
    expect(recognition.publishTranscriptSnapshot).toHaveBeenCalledTimes(1)
  })

  it('does not start when the selected range contains a stale conversation id', async () => {
    const service = new VoiceBatchService(makeRecognition())

    await expect(
      service.preflight({ conversationIds: ['missing-conversation'], range: 'recent_30_days' })
    ).rejects.toThrow('选择的会话已不可用')
  })

  it('reports cache hits separately from newly recognized items', async () => {
    const recognition = makeRecognition()
    vi.mocked(recognition.getTranscriptSnapshot).mockReturnValue({
      state: 'transcribed',
      transcript: '旧缓存'
    })
    vi.mocked(recognition.recognize).mockResolvedValue({
      success: true,
      transcript: '旧缓存',
      cached: true
    })
    const service = new VoiceBatchService(recognition)

    await service.start({ conversationIds: ['contact-a'], range: 'selected_history' })
    await vi.waitFor(() => expect(service.getProgress().state).toBe('completed'))
    expect(service.getProgress()).toMatchObject({ cached: 1, succeeded: 0, failed: 0 })
  })

  it('counts visible conversations through the lightweight voice-count path without loading messages', async () => {
    const service = new VoiceBatchService(makeRecognition())

    await expect(
      service.conversationSummaries({
        conversationIds: ['contact-a', 'group-b'],
        range: 'recent_30_days'
      })
    ).resolves.toEqual([
      { conversationId: 'contact-a', voiceMessageCount: 3 },
      { conversationId: 'group-b', voiceMessageCount: 7 }
    ])

    expect(countVoiceMessagesAsync).toHaveBeenCalledTimes(2)
    expect(listMessagesAsync).not.toHaveBeenCalled()
  })
})
