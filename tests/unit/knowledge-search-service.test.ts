import { beforeEach, describe, expect, it, vi } from 'vitest'

const { chatState, getGroupSnapshotAsync, listContactsAsync, listMessagesAsync, knowledgeService } =
  vi.hoisted(() => ({
    chatState: {
      ready: false,
      accountId: ''
    },
    getGroupSnapshotAsync: vi.fn(),
    listContactsAsync: vi.fn(),
    listMessagesAsync: vi.fn(),
    knowledgeService: {
      dispose: vi.fn().mockResolvedValue(undefined),
      index: vi.fn().mockResolvedValue(undefined),
      search: vi.fn()
    }
  }))

vi.mock('../../src/main/services/chat-service', () => ({
  isReady: () => chatState.ready,
  getSelfAccountInfo: () => (chatState.accountId ? { wxid: chatState.accountId } : null),
  getCurrentAccountRoot: () => chatState.accountId,
  getGroupSnapshotAsync,
  listContactsAsync,
  listMessagesAsync
}))

vi.mock('../../src/main/knowledge/knowledge-service', () => ({
  KnowledgeService: class {
    dispose = knowledgeService.dispose
    index = knowledgeService.index
    search = knowledgeService.search
  }
}))

import { KnowledgeSearchService } from '../../src/main/knowledge/knowledge-search-service'

describe('KnowledgeSearchService legacy fallback', () => {
  beforeEach(() => {
    chatState.ready = false
    chatState.accountId = ''
    getGroupSnapshotAsync.mockReset()
    listContactsAsync.mockReset()
    listMessagesAsync.mockReset()
    knowledgeService.dispose.mockClear()
    knowledgeService.index.mockClear()
    knowledgeService.search.mockReset()
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
    expect(listMessagesAsync).toHaveBeenCalledWith('fixture-conversation', 1785800000, undefined)
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
    getGroupSnapshotAsync.mockResolvedValue({
      roomId: 'fixture-group@chatroom',
      memberCount: 1,
      members: [
        {
          wxid: 'wxid_member',
          nickname: '微信昵称',
          groupNickname: '健身同学',
          wechatNickname: '微信昵称',
          remark: '',
          avatar: ''
        }
      ]
    })

    const service = new KnowledgeSearchService('/tmp/wxe-knowledge-fallback', '/missing-worker.js')
    const result = await service.search({ text: '健身', terms: ['健身'], limit: 10 })

    expect(result.evidence).toEqual([
      expect.objectContaining({ senderId: 'wxid_member', sender: '健身同学' })
    ])
    expect(getGroupSnapshotAsync).toHaveBeenCalledWith('fixture-group')
    await service.dispose()
  })
})
