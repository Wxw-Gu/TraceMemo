import { beforeEach, describe, expect, it, vi } from 'vitest'

const { chatState, getGroupSnapshotAsync, getGroupMemberNamesAsync, listContactsAsync, listMessagesAsync, getSourceLatestActivityMs, getConversationActivityMs, knowledgeService } =
  vi.hoisted(() => ({
    chatState: {
      ready: false,
      accountId: ''
    },
    getGroupSnapshotAsync: vi.fn(),
    getGroupMemberNamesAsync: vi.fn(),
    listContactsAsync: vi.fn(),
    listMessagesAsync: vi.fn(),
    getSourceLatestActivityMs: vi.fn(() => null as number | null),
    // 源侧每会话最后活跃时间（epoch ms）。默认空表 = 没有任何会话可被增量跳过，
    // 于是每个会话都会被真实处理 —— 这正是大部分用例想要的"全量"前提。
    getConversationActivityMs: vi.fn(() => new Map<string, number>()),
    knowledgeService: {
      dispose: vi.fn().mockResolvedValue(undefined),
      // 与生产契约一致：index() 必须返回 KnowledgeIndexResult（调用方要读 cancelled）。
      index: vi.fn().mockResolvedValue({
        accountId: 'fixture-account',
        processedMessages: 0,
        indexedChunks: 0,
        updatedChunks: 0,
        unchangedConversations: 0,
        databaseBytes: 0,
        walBytes: 0,
        elapsedMs: 0,
        cancelled: false
      }),
      search: vi.fn(),
      // per-conversation checkpoint 读取：默认空表（没有会话已覆盖到任何时间点）。
      highWaterMarks: vi.fn().mockResolvedValue({}),
      cancelIndex: vi.fn().mockResolvedValue(false),
      status: vi.fn().mockResolvedValue({
        accountId: 'fixture-account',
        state: 'ready',
        indexedMessageCount: 1,
        indexedChunkCount: 1,
        sourceMessageCount: 1,
        processedMessages: 1,
        totalMessages: 1,
        estimatedRemainingMs: null,
        databaseBytes: 0,
        walBytes: 0,
        shmBytes: 0,
        indexLatestAt: null,
        sourceLatestAt: null
      })
    }
  }))

vi.mock('../../src/main/services/chat-service', () => ({
  isReady: () => chatState.ready,
  getSelfAccountInfo: () => (chatState.accountId ? { wxid: chatState.accountId } : null),
  getCurrentAccountRoot: () => chatState.accountId,
  getGroupSnapshotAsync,
  getGroupMemberNamesAsync,
  listContactsAsync,
  listMessagesAsync,
  getSourceLatestActivityMs,
  getConversationActivityMs
}))

vi.mock('../../src/main/knowledge/knowledge-service', () => ({
  KnowledgeService: class {
    dispose = knowledgeService.dispose
    index = knowledgeService.index
    search = knowledgeService.search
    highWaterMarks = knowledgeService.highWaterMarks
    cancelIndex = knowledgeService.cancelIndex
    status = knowledgeService.status
  }
}))

import { KnowledgeSearchService } from '../../src/main/knowledge/knowledge-search-service'
import type { VoiceTranscriptUpdate } from '../../src/shared/voice-recognition'

describe('KnowledgeSearchService legacy fallback', () => {
  beforeEach(() => {
    chatState.ready = false
    chatState.accountId = ''
    getGroupSnapshotAsync.mockReset()
    getGroupMemberNamesAsync.mockReset()
    getGroupMemberNamesAsync.mockResolvedValue([])
    listContactsAsync.mockReset()
    listMessagesAsync.mockReset()
    knowledgeService.dispose.mockClear()
    knowledgeService.index.mockClear()
    knowledgeService.search.mockReset()
    knowledgeService.status.mockClear()
    listContactsAsync.mockResolvedValue([
      {
        m_nsUsrName: 'fixture-contact',
        m_nsNickName: '脱敏会话',
        md5: 'fixture-conversation',
        type: 'user'
      }
    ])
    listMessagesAsync.mockResolvedValue([
      {
        id: 'fixture-message',
        localId: 42,
        from: 'user',
        type: '普通文本',
        datetime: '2026/8/5 10:00:00',
        content: '请把 Knowledge Worker 的 fallback 保留下来。',
        isSender: false,
        senderId: 'fixture-sender',
        name: '脱敏成员',
        createTime: 1785895200
      }
    ])
    getGroupSnapshotAsync.mockResolvedValue(null)
  })

  it('keeps the old main-process search path when Knowledge is unavailable', async () => {
    const service = new KnowledgeSearchService('/tmp/wxe-knowledge-fallback', '/missing-worker.js')
    const result = await service.search({
      text: 'Knowledge Worker fallback',
      terms: ['Knowledge Worker', 'fallback'],
      conversationIds: ['fixture-conversation'],
      startTime: 1785800000,
      limit: 10
    })
    expect(listMessagesAsync).toHaveBeenCalledWith(
      'fixture-conversation',
      1785800000,
      undefined,
      undefined,
      undefined,
      'knowledge'
    )
    expect(result).toMatchObject({
      source: 'fallback',
      fallbackReason: 'unavailable',
      state: 'unavailable',
      totalMessages: 1
    })
    expect(result.evidence).toEqual([
      expect.objectContaining({
        messageId: 'local:42',
        conversationId: 'fixture-conversation',
        sender: '脱敏成员',
        senderId: 'fixture-sender',
        timestamp: 1785895200000
      })
    ])
    await service.dispose()
  })

  it('accepts username and Chat_<md5> aliases in the legacy fallback scope', async () => {
    const service = new KnowledgeSearchService('/tmp/wxe-knowledge-fallback', '/missing-worker.js')
    const result = await service.search({
      text: 'Knowledge Worker fallback',
      terms: ['Knowledge Worker', 'fallback'],
      conversationIds: ['fixture-contact', 'Chat_fixture-conversation'],
      limit: 10
    })

    expect(listMessagesAsync).toHaveBeenCalledWith(
      'fixture-conversation',
      undefined,
      undefined,
      undefined,
      undefined,
      'knowledge'
    )
    expect(result.evidence).toHaveLength(1)
    await service.dispose()
  })

  it('hydrates a cached voice transcript and incrementally indexes only its conversation', async () => {
    chatState.ready = true
    chatState.accountId = 'C:/fixtures/account-a'
    listContactsAsync.mockResolvedValue([
      {
        m_nsUsrName: 'voice-contact',
        m_nsNickName: '语音测试会话',
        md5: 'voice-conversation',
        type: 'user'
      }
    ])
    listMessagesAsync.mockResolvedValue([
      {
        id: 'voice-message',
        localId: 18,
        from: 'user',
        type: '语音',
        content: '[语音消息]',
        isSender: false,
        senderId: 'fixture-sender',
        name: '脱敏成员',
        sessionId: 'voice-contact',
        createTime: 1_785_895_200
      }
    ])
    const { voiceAccountIdentity, voiceMessageIdentity } =
      await import('../../src/main/voice-pipeline/voice-message-identity')
    const reference = {
      sessionId: 'voice-contact',
      localId: 18,
      createTime: 1_785_895_200
    }
    const service = new KnowledgeSearchService('/tmp/wxe-knowledge-fallback', '/missing-worker.js')
    service.setVoiceTranscriptResolver(() => ({
      state: 'transcribed',
      transcript: '缓存中的语音文字'
    }))

    await service.indexVoiceTranscript({
      accountIdentity: voiceAccountIdentity(chatState.accountId),
      reference,
      messageIdentity: voiceMessageIdentity(reference),
      state: 'transcribed',
      transcript: '缓存中的语音文字',
      cached: true
    })

    expect(knowledgeService.index).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: chatState.accountId,
        conversations: [
          expect.objectContaining({
            conversationId: 'voice-conversation',
            completeSnapshot: true,
            messages: [
              expect.objectContaining({
                kind: 'voice',
                voiceTranscript: '缓存中的语音文字',
                voiceTranscriptState: 'transcribed'
              })
            ]
          })
        ]
      })
    )
    await service.dispose()
  })

  it('coalesces consecutive voice updates for the same conversation', async () => {
    chatState.ready = true
    chatState.accountId = 'C:/fixtures/account-a'
    listContactsAsync.mockResolvedValue([
      {
        m_nsUsrName: 'voice-contact',
        m_nsNickName: '语音测试会话',
        md5: 'voice-conversation',
        type: 'user'
      }
    ])
    listMessagesAsync.mockResolvedValue([
      {
        id: 'voice-message-1',
        localId: 18,
        from: 'user',
        type: '语音',
        content: '[语音消息]',
        isSender: false,
        sessionId: 'voice-contact',
        createTime: 1_785_895_200
      },
      {
        id: 'voice-message-2',
        localId: 19,
        from: 'user',
        type: '语音',
        content: '[语音消息]',
        isSender: false,
        sessionId: 'voice-contact',
        createTime: 1_785_895_201
      }
    ])
    let releaseFirstIndex: (() => void) | undefined
    knowledgeService.index.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFirstIndex = resolve
        })
    )
    const { voiceAccountIdentity, voiceMessageIdentity } =
      await import('../../src/main/voice-pipeline/voice-message-identity')
    const service = new KnowledgeSearchService('/tmp/wxe-knowledge-fallback', '/missing-worker.js')
    const update = (localId: number, createTime: number): VoiceTranscriptUpdate => {
      const reference = { sessionId: 'voice-contact', localId, createTime }
      return {
        accountIdentity: voiceAccountIdentity(chatState.accountId),
        reference,
        messageIdentity: voiceMessageIdentity(reference),
        state: 'transcribed' as const,
        transcript: `转写 ${localId}`,
        cached: false
      }
    }

    const first = service.indexVoiceTranscript(update(18, 1_785_895_200))
    await vi.waitFor(() => expect(knowledgeService.index).toHaveBeenCalledTimes(1))
    const second = service.indexVoiceTranscript(update(19, 1_785_895_201))
    const third = service.indexVoiceTranscript(update(18, 1_785_895_200))
    releaseFirstIndex?.()

    await Promise.all([first, second, third])
    expect(knowledgeService.index).toHaveBeenCalledTimes(2)
    expect(listMessagesAsync).toHaveBeenCalledTimes(2)
    await service.dispose()
  })

  it('uses existing Knowledge evidence while a new incremental pass is running', async () => {
    chatState.ready = true
    chatState.accountId = 'fixture-account'
    knowledgeService.search.mockResolvedValue({
      state: 'indexing',
      indexedMessageCount: 300,
      indexedChunkCount: 60,
      evidence: [
        {
          chunkId: 'chunk-1',
          conversationId: 'fixture-conversation',
          messageId: 'fixture-message',
          senderId: 'fixture-sender',
          sender: '脱敏成员',
          timestamp: 1785895200000,
          startTime: 1785895200000,
          endTime: 1785895200000,
          messageIds: ['fixture-message'],
          text: 'Knowledge 已完成的部分可以立即检索。'
        }
      ]
    })

    const service = new KnowledgeSearchService('/tmp/wxe-knowledge-fallback', '/missing-worker.js')
    const result = await service.search({
      text: 'fallback',
      terms: ['fallback'],
      limit: 10
    })

    expect(result).toMatchObject({
      source: 'knowledge',
      state: 'indexing',
      totalMessages: 300
    })
    expect(result.evidence).toHaveLength(1)
    expect(listMessagesAsync).not.toHaveBeenCalled()
    await service.dispose()
  })

  it('splits a large scope filter before sending it to the Knowledge Worker', async () => {
    chatState.ready = true
    chatState.accountId = 'fixture-account'
    knowledgeService.search.mockResolvedValue({
      state: 'ready',
      indexedMessageCount: 1_500,
      indexedChunkCount: 300,
      evidence: []
    })
    const conversationIds = Array.from({ length: 1_401 }, (_, index) => `conversation-${index}`)
    const service = new KnowledgeSearchService('/tmp/wxe-knowledge-fallback', '/missing-worker.js')

    const result = await service.search({
      text: '知识库',
      terms: ['知识库'],
      conversationIds,
      limit: 10
    })

    expect(result).toMatchObject({ source: 'knowledge', totalMessages: 1_500 })
    expect(knowledgeService.search).toHaveBeenCalledTimes(3)
    for (const [request] of knowledgeService.search.mock.calls) {
      expect(request.conversationIds.length).toBeLessThanOrEqual(700)
    }
    await service.dispose()
  })

  it('resolves a group member wxid to its group nickname in fallback evidence', async () => {
    listContactsAsync.mockResolvedValue([
      { md5: 'fixture-group', m_nsNickName: '脱敏群聊', type: 'group' }
    ])
    listMessagesAsync.mockResolvedValue([
      {
        id: 'group-message',
        from: 'wxid_member',
        type: '普通文本',
        content: '今天继续健身。',
        isSender: false,
        senderId: 'wxid_member',
        name: 'wxid_member',
        createTime: 1785895200
      }
    ])
    getGroupMemberNamesAsync.mockResolvedValue([
      {
        wxid: 'wxid_member',
        nickname: '微信昵称',
        groupNickname: '健身同学',
        wechatNickname: '微信昵称',
        remark: '',
        avatar: ''
      }
    ])

    const service = new KnowledgeSearchService('/tmp/wxe-knowledge-fallback', '/missing-worker.js')
    const result = await service.search({ text: '健身', terms: ['健身'], limit: 10 })

    expect(result.evidence).toEqual([
      expect.objectContaining({ senderId: 'wxid_member', sender: '健身同学' })
    ])
    expect(getGroupMemberNamesAsync).toHaveBeenCalledWith('fixture-group', ['wxid_member'])
    // sender enrichment 绝不能走完整群快照 —— 后者会 hydrate 整群成员名称与头像。
    expect(getGroupSnapshotAsync).not.toHaveBeenCalled()
    await service.dispose()
  })

  it('reuses contacts and group member names only within the same retrieval session', async () => {
    listContactsAsync.mockResolvedValue([
      { md5: 'fixture-group', m_nsNickName: '脱敏群聊', type: 'group' }
    ])
    listMessagesAsync.mockResolvedValue([
      {
        id: 'group-message',
        from: 'wxid_member',
        type: '普通文本',
        content: '今天继续健身。',
        isSender: false,
        senderId: 'wxid_member',
        name: 'wxid_member',
        createTime: 1785895200
      }
    ])
    getGroupMemberNamesAsync.mockResolvedValue([
      {
        wxid: 'wxid_member',
        nickname: '微信昵称',
        groupNickname: '健身同学',
        wechatNickname: '微信昵称',
        remark: '',
        avatar: ''
      }
    ])

    const service = new KnowledgeSearchService('/tmp/wxe-knowledge-fallback', '/missing-worker.js')
    const request = {
      text: '健身',
      terms: ['健身'],
      retrievalSessionId: 'retrieval-a',
      limit: 10
    }
    const first = await service.search(request)
    const second = await service.search(request)

    expect(first.evidence).toEqual(second.evidence)
    expect(listContactsAsync).toHaveBeenCalledTimes(3)
    // Each fallback search needs contacts for scope selection; enrichment is
    // the only layer cached, so the second search avoids one extra lookup.
    expect(getGroupMemberNamesAsync).toHaveBeenCalledTimes(1)

    await service.search({ ...request, retrievalSessionId: 'retrieval-b' })
    expect(getGroupMemberNamesAsync).toHaveBeenCalledTimes(2)
    await service.dispose()
  })

  it('resolves several senders of one group with a single name lookup (batched, deduped)', async () => {
    listContactsAsync.mockResolvedValue([
      { md5: 'fixture-group', m_nsNickName: '脱敏群聊', type: 'group' }
    ])
    listMessagesAsync.mockResolvedValue([
      {
        id: 'm1',
        from: 'wxid_a',
        type: '普通文本',
        content: '健身打卡 A',
        isSender: false,
        senderId: 'wxid_a',
        name: 'wxid_a',
        createTime: 1785895200
      },
      {
        id: 'm2',
        from: 'wxid_b',
        type: '普通文本',
        content: '健身打卡 B',
        isSender: false,
        senderId: 'wxid_b',
        name: 'wxid_b',
        createTime: 1785895201
      },
      // 同一 sender 重复出现：不能因此多查一次（duplicate sender）。
      {
        id: 'm3',
        from: 'wxid_a',
        type: '普通文本',
        content: '健身打卡 A2',
        isSender: false,
        senderId: 'wxid_a',
        name: 'wxid_a',
        createTime: 1785895202
      }
    ])
    getGroupMemberNamesAsync.mockImplementation(async (_md5: string, wxids: string[]) =>
      wxids.map((wxid) => ({
        wxid,
        nickname: '',
        groupNickname: `群昵称-${wxid}`,
        wechatNickname: '',
        remark: '',
        avatar: ''
      }))
    )

    const service = new KnowledgeSearchService('/tmp/wxe-knowledge-fallback', '/missing-worker.js')
    const result = await service.search({ text: '健身', terms: ['健身'], limit: 10 })

    expect(getGroupMemberNamesAsync).toHaveBeenCalledTimes(1)
    expect(getGroupMemberNamesAsync.mock.calls[0][0]).toBe('fixture-group')
    expect(new Set(getGroupMemberNamesAsync.mock.calls[0][1])).toEqual(new Set(['wxid_a', 'wxid_b']))
    const bySender = new Map(result.evidence.map((item) => [item.senderId, item.sender]))
    expect(bySender.get('wxid_a')).toBe('群昵称-wxid_a')
    expect(bySender.get('wxid_b')).toBe('群昵称-wxid_b')
    await service.dispose()
  })

  it('looks names up once per group when evidence spans several groups', async () => {
    listContactsAsync.mockResolvedValue([
      { md5: 'group-one', m_nsNickName: '群一', type: 'group' },
      { md5: 'group-two', m_nsNickName: '群二', type: 'group' }
    ])
    listMessagesAsync.mockImplementation(async (md5: string) => {
      if (md5 === 'group-one') {
        return [
          {
            id: 'g1-m1',
            from: 'wxid_1',
            type: '普通文本',
            content: '健身 group one',
            isSender: false,
            senderId: 'wxid_1',
            name: 'wxid_1',
            createTime: 1785895200
          }
        ]
      }
      return [
        {
          id: 'g2-m1',
          from: 'wxid_2',
          type: '普通文本',
          content: '健身 group two',
          isSender: false,
          senderId: 'wxid_2',
          name: 'wxid_2',
          createTime: 1785895201
        }
      ]
    })
    getGroupMemberNamesAsync.mockImplementation(async (md5: string, wxids: string[]) =>
      wxids.map((wxid) => ({
        wxid,
        nickname: '',
        groupNickname: `${md5}:${wxid}`,
        wechatNickname: '',
        remark: '',
        avatar: ''
      }))
    )

    const service = new KnowledgeSearchService('/tmp/wxe-knowledge-fallback', '/missing-worker.js')
    const result = await service.search({ text: '健身', terms: ['健身'], limit: 10 })

    expect(getGroupMemberNamesAsync).toHaveBeenCalledTimes(2)
    expect(getGroupMemberNamesAsync.mock.calls.map((call) => call[0]).sort()).toEqual([
      'group-one',
      'group-two'
    ])
    const bySender = new Map(result.evidence.map((item) => [item.senderId, item.sender]))
    expect(bySender.get('wxid_1')).toBe('group-one:wxid_1')
    expect(bySender.get('wxid_2')).toBe('group-two:wxid_2')
    await service.dispose()
  })

  it('keeps the display-name priority and never invents a name for an unknown wxid', async () => {
    listContactsAsync.mockResolvedValue([
      { md5: 'fixture-group', m_nsNickName: '脱敏群聊', type: 'group' }
    ])
    listMessagesAsync.mockResolvedValue([
      {
        id: 'm1',
        from: 'wxid_remark',
        type: '普通文本',
        content: '健身 1',
        isSender: false,
        senderId: 'wxid_remark',
        name: 'wxid_remark',
        createTime: 1785895200
      },
      {
        id: 'm2',
        from: 'wxid_unknown',
        type: '普通文本',
        content: '健身 2',
        isSender: false,
        senderId: 'wxid_unknown',
        name: 'wxid_unknown',
        createTime: 1785895201
      }
    ])
    getGroupMemberNamesAsync.mockResolvedValue([
      // 群昵称缺失 → 必须回退到 contact 微信昵称（不能退化成 wxid）。
      {
        wxid: 'wxid_remark',
        nickname: '微信昵称A',
        groupNickname: '',
        wechatNickname: '微信昵称A',
        remark: '备注A',
        avatar: ''
      },
      // 什么名字都没有 → 保持原样，绝不编造。
      {
        wxid: 'wxid_unknown',
        nickname: '',
        groupNickname: '',
        wechatNickname: '',
        remark: '',
        avatar: ''
      }
    ])

    const service = new KnowledgeSearchService('/tmp/wxe-knowledge-fallback', '/missing-worker.js')
    const result = await service.search({ text: '健身', terms: ['健身'], limit: 10 })

    const bySender = new Map(result.evidence.map((item) => [item.senderId, item.sender]))
    expect(bySender.get('wxid_remark')).toBe('微信昵称A')
    expect(bySender.get('wxid_unknown')).toBe('wxid_unknown')
    await service.dispose()
  })
})

describe('KnowledgeSearchService freshness contract', () => {
  beforeEach(() => {
    chatState.ready = true
    chatState.accountId = 'fixture-account'
    getGroupSnapshotAsync.mockReset()
    getGroupMemberNamesAsync.mockReset()
    getGroupMemberNamesAsync.mockResolvedValue([])
    listContactsAsync.mockReset()
    listMessagesAsync.mockReset()
    getSourceLatestActivityMs.mockReset()
    getSourceLatestActivityMs.mockReturnValue(null)
    knowledgeService.index.mockClear()
    knowledgeService.search.mockReset()
    knowledgeService.status.mockClear()
    listContactsAsync.mockResolvedValue([
      { m_nsUsrName: 'fixture-contact', m_nsNickName: '脱敏会话', md5: 'fixture-conversation', type: 'user' }
    ])
    listMessagesAsync.mockResolvedValue([])
  })

  it('把索引覆盖时间与源数据最新时间一起返回（READY 不等于 FRESH）', async () => {
    const indexLatestAt = 1787715444000
    const sourceLatestAt = 1789099069000
    getSourceLatestActivityMs.mockReturnValue(sourceLatestAt)
    knowledgeService.search.mockResolvedValue({
      state: 'ready',
      evidence: [],
      indexedMessageCount: 1,
      indexedChunkCount: 1,
      indexLatestAt,
      voiceCoverage: undefined
    })

    const service = new KnowledgeSearchService('/tmp/wxe-freshness', '/missing-worker.js')
    const result = await service.search({ text: '健身', terms: ['健身'], limit: 10 })

    expect(result.source).toBe('knowledge')
    expect(result.indexLatestAt).toBe(indexLatestAt)
    expect(result.sourceLatestAt).toBe(sourceLatestAt)
    await service.dispose()
  })

  it('派生索引不可用时也带上源数据最新时间，便于调用方判断落后程度', async () => {
    const sourceLatestAt = 1789099069000
    getSourceLatestActivityMs.mockReturnValue(sourceLatestAt)
    knowledgeService.search.mockResolvedValue({
      state: 'unavailable',
      evidence: [],
      indexedMessageCount: 0,
      indexedChunkCount: 0,
      indexLatestAt: null,
      voiceCoverage: undefined
    })

    const service = new KnowledgeSearchService('/tmp/wxe-freshness-2', '/missing-worker.js')
    const result = await service.search({ text: '健身', terms: ['健身'], limit: 10 })

    expect(result.indexLatestAt).toBeNull()
    expect(result.sourceLatestAt).toBe(sourceLatestAt)
    await service.dispose()
  })

  it('requestCatchUp 复用正在跑的索引任务，不启动第二个', async () => {
    // 让索引 pass 停在读取消息这一步，从而稳定地处于 in-flight 状态。
    listMessagesAsync.mockImplementation(() => new Promise(() => {}))
    const service = new KnowledgeSearchService('/tmp/wxe-freshness-3', '/missing-worker.js')

    await expect(service.waitForIndexingComplete(5)).resolves.toBe(true)

    const first = service.requestCatchUp(0)
    expect(first).toMatchObject({ triggered: true, inProgress: true })
    const second = service.requestCatchUp(0)
    expect(second).toMatchObject({ triggered: false, inProgress: true })

    // 有界等待：追不上就返回 false，绝不无限阻塞交互查询。
    await expect(service.waitForIndexingComplete(20)).resolves.toBe(false)
    await service.dispose()
  })
})

describe('KnowledgeSearchService 完整 pass 记录源数据边界', () => {
  beforeEach(() => {
    chatState.ready = true
    chatState.accountId = 'fixture-account'
    listContactsAsync.mockReset()
    listMessagesAsync.mockReset()
    knowledgeService.index.mockClear()
    knowledgeService.search.mockReset()
    knowledgeService.status.mockClear()
  })

  it('只在最后处理的会话上写入 sourceLatestAt，且取未过滤原始消息的最大 createTime', async () => {
    listContactsAsync.mockResolvedValue([
      { m_nsUsrName: 'fixture-a', m_nsNickName: 'A', md5: 'fixture-a', type: 'user' },
      { m_nsUsrName: 'fixture-b', m_nsNickName: 'B', md5: 'fixture-b', type: 'user' }
    ])
    listMessagesAsync.mockImplementation(async (md5: string) =>
      md5 === 'fixture-a'
        ? [{ id: 'a1', from: 'x', type: 'text', datetime: '', content: '你好', isSender: false, createTime: 1000 }]
        : [
            { id: 'b1', from: 'x', type: 'text', datetime: '', content: 'hi', isSender: false, createTime: 2000 },
            // 无正文/无附件的消息不会被索引建模，但 freshness 口径必须把它算进来。
            { id: 'b2', from: 'x', type: '图片', datetime: '', content: '', isSender: false, createTime: 9000 }
          ]
    )

    const service = new KnowledgeSearchService('/tmp/wxe-pass-coverage', '/missing-worker.js')
    service.startCurrentAccountIndex()
    await expect(service.waitForIndexingComplete(2000)).resolves.toBe(true)

    expect(knowledgeService.index).toHaveBeenCalledTimes(2)
    const calls = knowledgeService.index.mock.calls as Array<[Record<string, unknown>]>
    expect(calls[0][0].sourceLatestAt).toBeUndefined()
    expect(calls[0][0].sourceMessageCount).toBeUndefined()
    expect(calls[1][0].sourceLatestAt).toBe(9000 * 1000)
    expect(calls[1][0].sourceMessageCount).toBe(2)
    await service.dispose()
  })
})

/**
 * 索引同步契约：必须**后台 / 可取消 / 可断点续传 / 不阻塞查询**，
 * 而且取消之后不允许留下一个假的"正在同步"。
 */
describe('KnowledgeSearchService sync contract', () => {
  beforeEach(() => {
    chatState.ready = true
    chatState.accountId = 'fixture-account'
    listContactsAsync.mockReset()
    listMessagesAsync.mockReset()
    getConversationActivityMs.mockReset()
    getConversationActivityMs.mockReturnValue(new Map<string, number>())
    knowledgeService.index.mockReset()
    knowledgeService.index.mockResolvedValue({
      accountId: 'fixture-account',
      processedMessages: 0,
      indexedChunks: 0,
      updatedChunks: 0,
      unchangedConversations: 0,
      databaseBytes: 0,
      walBytes: 0,
      elapsedMs: 0,
      cancelled: false
    })
    knowledgeService.highWaterMarks.mockReset()
    knowledgeService.highWaterMarks.mockResolvedValue({})
    knowledgeService.cancelIndex.mockReset()
    knowledgeService.cancelIndex.mockResolvedValue(false)
    knowledgeService.search.mockReset()
    knowledgeService.status.mockClear()
    listMessagesAsync.mockResolvedValue([])
  })

  const twoContacts = (): void => {
    listContactsAsync.mockResolvedValue([
      { m_nsUsrName: 'fixture-a', m_nsNickName: 'A', md5: 'fixture-a', type: 'user' },
      { m_nsUsrName: 'fixture-b', m_nsNickName: 'B', md5: 'fixture-b', type: 'user' }
    ])
  }

  const captureStatuses = (
    service: KnowledgeSearchService
  ): { all: Array<Record<string, unknown>>; last: () => Record<string, unknown> } => {
    const all: Array<Record<string, unknown>> = []
    service.onStatusChange((status) => all.push(status as unknown as Record<string, unknown>))
    return { all, last: () => all[all.length - 1] }
  }

  it('skips conversations whose source activity is already covered by the checkpoint', async () => {
    twoContacts()
    // a 的源侧最后活跃时间早于它已经索引到的位置 → 没有任何新消息，必须整段跳过。
    getConversationActivityMs.mockReturnValue(
      new Map<string, number>([
        ['fixture-a', 4_000_000],
        ['fixture-b', 8_000_000]
      ])
    )
    knowledgeService.highWaterMarks.mockResolvedValue({ 'fixture-a': 5_000_000 })

    const service = new KnowledgeSearchService('/tmp/wxe-sync-skip', '/missing-worker.js')
    const statuses = captureStatuses(service)
    service.startCurrentAccountIndex()
    await expect(service.waitForIndexingComplete(2000)).resolves.toBe(true)

    // 真正 delta 的核心：被跳过的会话**不读 WCDB**（这是把"每次全量重扫"变成分钟级以内的原因）。
    expect(listMessagesAsync).toHaveBeenCalledTimes(1)
    expect(listMessagesAsync.mock.calls[0][0]).toBe('fixture-b')
    expect(knowledgeService.index).toHaveBeenCalledTimes(1)

    const finished = statuses.all.find(
      (status) => (status.pass as { phase?: string } | undefined)?.phase === 'idle'
    )
    const pass = finished?.pass as {
      skippedConversations: number
      processedConversations: number
      totalConversations: number
      cancellable: boolean
    }
    expect(pass.totalConversations).toBe(2)
    expect(pass.skippedConversations).toBe(1)
    expect(pass.processedConversations).toBe(2)
    // 一遍跑完必须清掉"可取消"，否则 UI 会在结束后继续显示取消按钮。
    expect(pass.cancellable).toBe(false)

    // 有跳过时不能把这一遍的部分计数冒充成"全量总量"。
    const indexArgs = knowledgeService.index.mock.calls[0][0] as Record<string, unknown>
    expect(indexArgs.sourceMessageCount).toBeUndefined()
    expect(indexArgs.sourceLatestAt).toBeUndefined()
    await service.dispose()
  })

  it('never skips a conversation when the checkpoint has no entry for it', async () => {
    twoContacts()
    // 源侧有活跃时间，但派生库没有对应的 checkpoint（例如换库/清库之后）。
    // 这时候必须真读真同步，否则会静默丢消息。
    getConversationActivityMs.mockReturnValue(
      new Map<string, number>([
        ['fixture-a', 4_000_000],
        ['fixture-b', 8_000_000]
      ])
    )
    knowledgeService.highWaterMarks.mockResolvedValue({})

    const service = new KnowledgeSearchService('/tmp/wxe-sync-noskip', '/missing-worker.js')
    service.startCurrentAccountIndex()
    await expect(service.waitForIndexingComplete(2000)).resolves.toBe(true)

    expect(listMessagesAsync).toHaveBeenCalledTimes(2)
    expect(knowledgeService.index).toHaveBeenCalledTimes(2)
    await service.dispose()
  })

  it('reports a cancelled pass as cancelled and never leaves a fake indexing state', async () => {
    twoContacts()
    let releaseSecond: (() => void) | undefined
    knowledgeService.index
      .mockResolvedValueOnce({
        accountId: 'fixture-account',
        processedMessages: 1,
        indexedChunks: 1,
        updatedChunks: 0,
        unchangedConversations: 0,
        databaseBytes: 0,
        walBytes: 0,
        elapsedMs: 0,
        cancelled: false
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseSecond = () =>
              resolve({
                accountId: 'fixture-account',
                processedMessages: 0,
                indexedChunks: 0,
                updatedChunks: 0,
                unchangedConversations: 0,
                databaseBytes: 0,
                walBytes: 0,
                elapsedMs: 0,
                cancelled: true
              })
          })
      )
    knowledgeService.cancelIndex.mockResolvedValue(true)

    const service = new KnowledgeSearchService('/tmp/wxe-sync-cancel', '/missing-worker.js')
    const statuses = captureStatuses(service)
    service.startCurrentAccountIndex()
    await vi.waitFor(() => expect(knowledgeService.index).toHaveBeenCalledTimes(2))

    const ack = await service.cancelCurrentAccountIndex()
    expect(ack).toEqual({ cancellable: true, cancelled: true })
    // 取消请求一发出，UI 立刻就该看到"不可再取消"（按钮变「正在取消…」）。
    const cancelling = statuses.all.find(
      (status) => (status.pass as { cancellable?: boolean } | undefined)?.cancellable === false
    )
    expect(cancelling).toBeDefined()

    releaseSecond?.()
    await expect(service.waitForIndexingComplete(2000)).resolves.toBe(true)

    const finalStatus = await service.getStatus()
    expect(finalStatus.state).toBe('cancelled')
    expect(finalStatus.pass?.phase).toBe('cancelled')
    expect(finalStatus.pass?.cancellable).toBe(false)
    // 全程不允许出现"同步中"残留（run_state 不得留下假的 indexing）。
    expect(statuses.all.some((status) => status.state === 'cancelled')).toBe(true)
    await service.dispose()
  })

  it('keeps committed conversations when a pass is cancelled and resumes from the checkpoint', async () => {
    listContactsAsync.mockResolvedValue([
      { m_nsUsrName: 'fixture-a', m_nsNickName: 'A', md5: 'fixture-a', type: 'user' },
      { m_nsUsrName: 'fixture-b', m_nsNickName: 'B', md5: 'fixture-b', type: 'user' },
      { m_nsUsrName: 'fixture-c', m_nsNickName: 'C', md5: 'fixture-c', type: 'user' }
    ])
    listMessagesAsync.mockResolvedValue([
      {
        id: 'fixture-message',
        localId: 42,
        from: 'user',
        type: '普通文本',
        datetime: '2026/8/5 10:00:00',
        content: '断点续传',
        isSender: false,
        senderId: 'fixture-sender',
        name: '脱敏成员',
        createTime: 1785895200
      }
    ])
    let releaseThird: (() => void) | undefined
    knowledgeService.index
      .mockResolvedValueOnce({
        accountId: 'fixture-account',
        processedMessages: 1,
        indexedChunks: 1,
        updatedChunks: 0,
        unchangedConversations: 0,
        databaseBytes: 0,
        walBytes: 0,
        elapsedMs: 0,
        cancelled: false
      })
      .mockResolvedValueOnce({
        accountId: 'fixture-account',
        processedMessages: 1,
        indexedChunks: 1,
        updatedChunks: 0,
        unchangedConversations: 0,
        databaseBytes: 0,
        walBytes: 0,
        elapsedMs: 0,
        cancelled: false
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseThird = () =>
              resolve({
                accountId: 'fixture-account',
                processedMessages: 0,
                indexedChunks: 0,
                updatedChunks: 0,
                unchangedConversations: 0,
                databaseBytes: 0,
                walBytes: 0,
                elapsedMs: 0,
                cancelled: true
              })
          })
      )

    const service = new KnowledgeSearchService('/tmp/wxe-sync-resume', '/missing-worker.js')
    const statuses = captureStatuses(service)
    service.startCurrentAccountIndex()
    await vi.waitFor(() => expect(knowledgeService.index).toHaveBeenCalledTimes(3))
    await service.cancelCurrentAccountIndex()
    releaseThird?.()
    await expect(service.waitForIndexingComplete(2000)).resolves.toBe(true)

    // 取消 ≠ 回滚：前两个会话已经提交的索引必须留下来。
    const cancelled = statuses.all[statuses.all.length - 1]
    const pass = cancelled.pass as { indexedMessages: number; phase: string }
    expect(pass.phase).toBe('cancelled')
    expect(pass.indexedMessages).toBeGreaterThan(0)

    // 下一遍：两个已覆盖的会话必须被 checkpoint 跳过，只补没跑完的那个。
    knowledgeService.index.mockClear()
    listMessagesAsync.mockClear()
    getConversationActivityMs.mockReturnValue(
      new Map<string, number>([
        ['fixture-a', 1_785_895_200_000],
        ['fixture-b', 1_785_895_200_000]
      ])
    )
    // a 与 b 的 checkpoint 已追平它们的源侧活跃时间；c 仍然没有覆盖。
    knowledgeService.highWaterMarks.mockResolvedValue({
      'fixture-a': 1_785_895_200_000,
      'fixture-b': 1_785_895_200_000
    })
    knowledgeService.index.mockResolvedValue({
      accountId: 'fixture-account',
      processedMessages: 1,
      indexedChunks: 1,
      updatedChunks: 0,
      unchangedConversations: 0,
      databaseBytes: 0,
      walBytes: 0,
      elapsedMs: 0,
      cancelled: false
    })
    service.startCurrentAccountIndex()
    await expect(service.waitForIndexingComplete(2000)).resolves.toBe(true)

    expect(listMessagesAsync).toHaveBeenCalledTimes(1)
    expect(listMessagesAsync.mock.calls[0][0]).toBe('fixture-c')
    await service.dispose()
  })

  it('is honest when there is nothing to cancel', async () => {
    twoContacts()
    const service = new KnowledgeSearchService('/tmp/wxe-sync-nocancel', '/missing-worker.js')
    // 没有在跑的 pass：不能谎报"已取消"。
    await expect(service.cancelCurrentAccountIndex()).resolves.toEqual({
      cancellable: false,
      cancelled: false
    })
    expect(knowledgeService.cancelIndex).not.toHaveBeenCalled()
    await service.dispose()
  })

  it('does not let a cancelled pass shorten the catch-up threshold of the next pass', async () => {
    twoContacts()
    let releaseFirst: (() => void) | undefined
    knowledgeService.index.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirst = () =>
            resolve({
              accountId: 'fixture-account',
              processedMessages: 0,
              indexedChunks: 0,
              updatedChunks: 0,
              unchangedConversations: 0,
              databaseBytes: 0,
              walBytes: 0,
              elapsedMs: 0,
              cancelled: true
            })
        })
    )
    knowledgeService.cancelIndex.mockResolvedValue(true)

    const service = new KnowledgeSearchService('/tmp/wxe-sync-threshold', '/missing-worker.js')
    const statuses = captureStatuses(service)
    service.startCurrentAccountIndex()
    await vi.waitFor(() => expect(knowledgeService.index).toHaveBeenCalledTimes(1))
    await service.cancelCurrentAccountIndex()
    releaseFirst?.()
    await expect(service.waitForIndexingComplete(2000)).resolves.toBe(true)

    // 取消的一遍不计入 lastIndexPassMs；否则"是否值得再追一遍"的门槛会被一次提前结束的 pass 带偏
    // （表现为：明明落后很多却因为"上一遍很快"而拒绝追赶）。
    const last = statuses.all[statuses.all.length - 1]
    expect(last.state).toBe('cancelled')
    expect(await service.getStatus()).toMatchObject({ state: 'cancelled' })
    await service.dispose()
  })

  it('keeps search available while a pass is running (indexing must not block queries)', async () => {
    twoContacts()
    // 搜索走派生库，索引在跑 → 必须复用**已有**证据，而不是把用户挡回去等同步。
    knowledgeService.search.mockResolvedValue({
      state: 'ready',
      evidence: [
        {
          messageId: 'local:42',
          conversationId: 'fixture-a',
          sender: '脱敏成员',
          senderId: 'fixture-sender',
          timestamp: 1785895200000,
          text: '命中',
          kind: 'text',
          score: 1
        }
      ],
      indexedMessageCount: 2,
      indexedChunkCount: 1,
      indexLatestAt: 1785895200000,
      timings: {}
    })
    let releaseIndex: (() => void) | undefined
    knowledgeService.index.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseIndex = () =>
            resolve({
              accountId: 'fixture-account',
              processedMessages: 1,
              indexedChunks: 1,
              updatedChunks: 0,
              unchangedConversations: 0,
              databaseBytes: 0,
              walBytes: 0,
              elapsedMs: 0,
              cancelled: false
            })
        })
    )

    const service = new KnowledgeSearchService('/tmp/wxe-sync-query', '/missing-worker.js')
    service.startCurrentAccountIndex()
    await vi.waitFor(() => expect(knowledgeService.index).toHaveBeenCalledTimes(1))

    const result = await service.search({
      text: '命中',
      terms: ['命中'],
      limit: 5
    })
    // 索引在跑也必须能查到（走派生库的既有数据），且不降级成一次 WCDB 全扫。
    expect(result.source).toBe('knowledge')
    expect(result.evidence.length).toBeGreaterThan(0)

    releaseIndex?.()
    await expect(service.waitForIndexingComplete(2000)).resolves.toBe(true)
    await service.dispose()
  })

  it('reads nothing at all when every checkpoint already covers the source (empty incremental pass)', async () => {
    twoContacts()
    getConversationActivityMs.mockReturnValue(
      new Map<string, number>([
        ['fixture-a', 4_000_000],
        ['fixture-b', 5_000_000]
      ])
    )
    knowledgeService.highWaterMarks.mockResolvedValue({
      'fixture-a': 4_000_000,
      'fixture-b': 5_000_000
    })

    const service = new KnowledgeSearchService('/tmp/wxe-sync-empty', '/missing-worker.js')
    const statuses = captureStatuses(service)
    service.startCurrentAccountIndex()
    await expect(service.waitForIndexingComplete(2000)).resolves.toBe(true)

    // 空增量 pass 的核心断言：一条源消息都不读、一个会话都不写。
    // 这必须接近 O(会话数)，而不是 O(全部历史消息)。
    expect(listMessagesAsync).not.toHaveBeenCalled()
    expect(knowledgeService.index).not.toHaveBeenCalled()

    const finished = statuses.all.find(
      (status) => (status.pass as { phase?: string } | undefined)?.phase === 'idle'
    )
    const pass = finished?.pass as {
      skippedConversations: number
      scannedMessages: number
      indexedMessages: number
      catchupConversations: number
      backfillConversations: number
    }
    expect(pass.skippedConversations).toBe(2)
    expect(pass.scannedMessages).toBe(0)
    expect(pass.indexedMessages).toBe(0)
    expect(pass.catchupConversations).toBe(0)
    expect(pass.backfillConversations).toBe(0)
    await service.dispose()
  })

  it('reads only the bounded delta window and never claims a complete snapshot', async () => {
    twoContacts()
    const mark = 1_700_000_000_000
    getConversationActivityMs.mockReturnValue(
      new Map<string, number>([['fixture-a', mark + 60_000]])
    )
    knowledgeService.highWaterMarks.mockResolvedValue({
      'fixture-a': mark,
      'fixture-b': 1_000
    })
    // b 的 checkpoint 已经覆盖它的源侧活动 → 整段跳过，让断言只看到 a 的一次 delta 读。
    getConversationActivityMs.mockReturnValue(
      new Map<string, number>([
        ['fixture-a', mark + 60_000],
        ['fixture-b', 1_000]
      ])
    )
    listMessagesAsync.mockResolvedValue([
      {
        id: 'delta-message',
        localId: 7,
        from: 'fixture-sender',
        type: '普通文本',
        content: '今天继续健身。',
        isSender: false,
        senderId: 'fixture-sender',
        name: '脱敏成员',
        createTime: 1_700_000_030
      }
    ])

    const service = new KnowledgeSearchService('/tmp/wxe-sync-delta', '/missing-worker.js')
    service.startCurrentAccountIndex()
    await expect(service.waitForIndexingComplete(2000)).resolves.toBe(true)

    // 1) 只读 delta 窗口：下界 = checkpoint - 24h overlap，而不是历史开头。
    //    ⚠️ 单位契约：checkpoint 是 epoch ms，但传给 WCDB 读取层的 startTime 必须是
    //    epoch **秒** —— `finalizeMessages` 拿它和秒级 `create_time` 直接比较。
    //    传 ms 会让下界恒大于任何真实消息时间戳，delta 读被静默过滤成空。
    expect(listMessagesAsync).toHaveBeenCalledTimes(1)
    expect(listMessagesAsync.mock.calls[0][0]).toBe('fixture-a')
    const deltaLowerBound = listMessagesAsync.mock.calls[0][1] as number
    expect(deltaLowerBound).toBe(Math.floor((mark - 24 * 60 * 60 * 1000) / 1000))
    // 秒级下界（< 1e11），且真的落在真实消息时间戳之前；否则整段 delta 会被过滤为空。
    expect(deltaLowerBound).toBeLessThan(1e11)
    expect(deltaLowerBound).toBeLessThan(1_700_000_030)
    // 2) 增量绝不能声明"完整快照"，否则 store 会把没在 delta 里的历史消息
    //    误判成已删除，从而整段重建这个会话，增量就白做了。
    const conversation = (
      knowledgeService.index.mock.calls[0][0] as {
        conversations: Array<Record<string, unknown>>
      }
    ).conversations[0]
    expect(conversation.completeSnapshot).toBe(false)
    expect(conversation.sourceHighWaterTime).toBe(mark + 60_000)
    await service.dispose()
  })

  it('processes catch-up conversations before historical backfill', async () => {
    twoContacts()
    const mark = 1_700_000_000_000
    // a 从来没有 checkpoint（历史缺口，2020 年的时间戳）；b 已有 checkpoint 且出现新消息。
    getConversationActivityMs.mockReturnValue(
      new Map<string, number>([
        ['fixture-a', 1_600_000_000_000],
        ['fixture-b', mark + 60_000]
      ])
    )
    knowledgeService.highWaterMarks.mockResolvedValue({ 'fixture-b': mark })

    const service = new KnowledgeSearchService('/tmp/wxe-sync-order', '/missing-worker.js')
    service.startCurrentAccountIndex()
    await expect(service.waitForIndexingComplete(2000)).resolves.toBe(true)

    // 「今天的新消息」必须排在 2020 年的历史缺口前面，否则用户永远等不到新数据。
    expect(listMessagesAsync.mock.calls.map((call) => call[0])).toEqual(['fixture-b', 'fixture-a'])
    await service.dispose()
  })

  it('does not advance a checkpoint on a suspicious empty delta read', async () => {
    twoContacts()
    const mark = 1_700_000_000_000
    getConversationActivityMs.mockReturnValue(
      new Map<string, number>([['fixture-a', mark + 60_000]])
    )
    knowledgeService.highWaterMarks.mockResolvedValue({ 'fixture-a': mark })
    // 可疑：源侧明确说有新消息，但 delta 范围读返回了空。
    listMessagesAsync.mockResolvedValue([])

    const service = new KnowledgeSearchService('/tmp/wxe-sync-suspicious', '/missing-worker.js')
    service.startCurrentAccountIndex()
    await expect(service.waitForIndexingComplete(2000)).resolves.toBe(true)

    const conversation = (
      knowledgeService.index.mock.calls[0][0] as {
        conversations: Array<Record<string, unknown>>
      }
    ).conversations[0]
    // 宁可下一遍重试，也绝不能把"一次可疑的空读"升级成"谎报已覆盖"（那会静默丢消息）。
    expect(conversation.sourceHighWaterTime).toBeUndefined()
    await service.dispose()
  })

  it('still reads every conversation when the source activity map is empty', async () => {
    twoContacts()
    // 锁死一条安全性质：**「源侧活动里没有它」不是「它没有消息」的证据**。
    // 用 activity 缺失来跳过没有 Session 行的联系人看起来很有吸引力，
    // 但只要 Session 表读取不完整，那个优化就会把真有消息的会话变成永久静默不索引。
    // 因此：没有 checkpoint 就必须老实读一遍。谁加了 activity-based 跳过，这里必须红。
    getConversationActivityMs.mockReturnValue(new Map<string, number>())
    knowledgeService.highWaterMarks.mockResolvedValue({})

    const service = new KnowledgeSearchService('/tmp/wxe-sync-empty-activity', '/missing-worker.js')
    service.startCurrentAccountIndex()
    await expect(service.waitForIndexingComplete(2000)).resolves.toBe(true)

    expect(listMessagesAsync).toHaveBeenCalledTimes(2)
    await service.dispose()
  })
})
