import { beforeEach, describe, expect, it, vi } from 'vitest'

const { chatState, listContactsAsync } = vi.hoisted(() => ({
  chatState: { ready: true },
  listContactsAsync: vi.fn()
}))

vi.mock('../../src/main/services/chat-service', () => ({
  isReady: () => chatState.ready,
  listContactsAsync
}))

import { AiSearchPipelineService } from '../../src/main/services/ai-search-pipeline-service'
import type { KnowledgeEvidence } from '../../src/shared/knowledge'

const makeCandidate = (index: number): KnowledgeEvidence => ({
  chunkId: `chunk-${index}`,
  conversationId: index % 2 ? 'fitness-group-a' : 'fitness-group-b',
  startTime: 1785900000000 + index,
  endTime: 1785900000000 + index,
  messageId: `message-${index}`,
  sender: index % 2 ? '杨伟' : '东方小唠',
  senderId: index % 2 ? 'member-yang' : 'member-dongfang',
  timestamp: 1785900000000 + index,
  messageIds: [`message-${index}`],
  text: `candidate-${index} 去健身`,
  score: -index
})

describe('AiSearchPipelineService', () => {
  const knowledge = { search: vi.fn() }
  const aiProvider = { getRuntimeConfig: vi.fn(), chat: vi.fn() }

  beforeEach(() => {
    chatState.ready = true
    listContactsAsync.mockReset()
    knowledge.search.mockReset()
    aiProvider.getRuntimeConfig.mockReset()
    aiProvider.chat.mockReset()
    listContactsAsync.mockResolvedValue([
      {
        md5: 'fitness-group',
        m_nsUsrName: 'fitness-group@chatroom',
        m_nsNickName: '健身交流组',
        type: 'group'
      }
    ])
    knowledge.search.mockResolvedValue({
      source: 'knowledge',
      state: 'ready',
      indexedMessageCount: 2_000,
      indexedChunkCount: 300,
      totalMessages: 2_000,
      evidence: [
        {
          chunkId: 'chunk-1',
          conversationId: 'fitness-group',
          startTime: 1785900000000,
          endTime: 1785900000000,
          messageId: 'message-1',
          sender: '小明',
          senderId: 'wxid_fixture',
          timestamp: 1785900000000,
          messageIds: ['message-1'],
          text: '今天下班去健身。'
        }
      ]
    })
    aiProvider.getRuntimeConfig.mockReturnValue({
      configured: true,
      providerName: 'DeepSeek',
      modelName: 'DeepSeek Chat'
    })
    aiProvider.chat
      .mockResolvedValueOnce({
        success: true,
        data: '{"action":"tool","tool":"search_messages","arguments":{"query":"健身"}}'
      })
      .mockResolvedValueOnce({
        success: true,
        data: '{"action":"finalize","reason":"已找到足够的相关消息"}'
      })
      .mockResolvedValueOnce({
        success: true,
        data: '小明提到今天下班去健身。[E1]',
        usage: { input: 120 }
      })
  })

  it('emits actual planning, knowledge, evidence and AI completion states', async () => {
    const service = new AiSearchPipelineService(knowledge as never, aiProvider as never)
    const events: Array<{ stage: string; status: string; message: string }> = []
    const result = await service.run(
      {
        requestId: 'fixture-request',
        text: '最近谁聊过健身',
        scope: 'global',
        range: '7d'
      },
      (event) => events.push(event)
    )

    expect(knowledge.search).toHaveBeenCalledWith(
      expect.objectContaining({ text: '最近谁聊过健身', terms: ['健身'] })
    )
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: 'query_understanding', status: 'running' }),
        expect.objectContaining({ stage: 'agent_start', status: 'completed' }),
        expect.objectContaining({ stage: 'agent_tool', status: 'completed' }),
        expect.objectContaining({ stage: 'search_plan_ready', status: 'completed' }),
        expect.objectContaining({ stage: 'knowledge_searching', status: 'completed' }),
        expect.objectContaining({ stage: 'evidence_ready', status: 'completed' }),
        expect.objectContaining({ stage: 'aggregation', status: 'completed' }),
        expect.objectContaining({
          stage: 'ai_generating',
          status: 'running',
          modelName: 'DeepSeek Chat'
        }),
        expect.objectContaining({ stage: 'completed', status: 'completed' })
      ])
    )
    expect(result).toMatchObject({
      status: 'completed',
      candidateEvidenceCount: 1,
      contextEvidenceCount: 1,
      answer: '小明提到今天下班去健身。[E1]',
      ai: { inputTokens: 120, inputTokensEstimated: false }
    })
    expect(result.agent).toMatchObject({ mode: 'agent', toolCalls: 1 })
  })

  it('keeps real evidence when the answer model fails', async () => {
    aiProvider.chat.mockReset()
    aiProvider.chat
      .mockResolvedValueOnce({
        success: true,
        data: '{"action":"tool","tool":"search_messages","arguments":{"query":"健身"}}'
      })
      .mockResolvedValueOnce({ success: true, data: '{"action":"finalize","reason":"证据足够"}' })
      .mockResolvedValueOnce({ success: false, error: '模型超时' })
    const service = new AiSearchPipelineService(knowledge as never, aiProvider as never)
    const events: Array<{ stage: string; status: string; message: string }> = []
    const result = await service.run(
      {
        requestId: 'fixture-ai-error',
        text: '最近聊过健身吗',
        scope: 'global',
        range: '7d'
      },
      (event) => events.push(event)
    )

    expect(result).toMatchObject({ status: 'ai_failed', evidence: [expect.any(Object)] })
    expect(events).toContainEqual(
      expect.objectContaining({ stage: 'ai_generating', status: 'error', error: '模型超时' })
    )
  })

  it('uses Final Evidence only for AI context and strips invalid citations', async () => {
    knowledge.search.mockResolvedValue({
      source: 'knowledge',
      state: 'ready',
      indexedMessageCount: 2_000,
      indexedChunkCount: 300,
      totalMessages: 2_000,
      evidence: Array.from({ length: 16 }, (_, index) => makeCandidate(index + 1)),
      timings: {
        workerIpcMs: 4,
        ftsMs: 8,
        messageLoadMs: 5,
        chunkExpandMs: 6,
        rankingMs: 2,
        totalMs: 25
      }
    })
    aiProvider.chat.mockReset()
    aiProvider.chat
      .mockResolvedValueOnce({
        success: true,
        data: '{"action":"tool","tool":"search_messages","arguments":{"query":"健身"}}'
      })
      .mockResolvedValueOnce({ success: true, data: '{"action":"finalize","reason":"证据足够"}' })
      .mockResolvedValueOnce({
        success: true,
        data: '杨伟聊过去健身。[E1] 错误引用。[E10][E23]',
        usage: { input: 160 }
      })
    const service = new AiSearchPipelineService(knowledge as never, aiProvider as never)

    const result = await service.run(
      {
        requestId: 'final-evidence-only',
        text: '全局搜一下 谁聊过 去健身',
        scope: 'global',
        range: '30d'
      },
      () => undefined
    )

    const answerPrompt = aiProvider.chat.mock.calls[2][0][1].content as string
    const contextIds = Array.from(answerPrompt.matchAll(/\[E(\d+)\]\nconversationId:/g)).map(
      (match) => Number(match[1])
    )
    expect(contextIds).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(answerPrompt).not.toContain('candidate-1 去健身')
    expect(result).toMatchObject({
      status: 'completed',
      candidateEvidenceCount: 16,
      contextEvidenceCount: 8,
      citationValidation: { status: 'sanitized', invalidCitationIds: ['E10', 'E23'] }
    })
    expect(result.evidence.map((item) => item.id)).toEqual([
      'E1',
      'E2',
      'E3',
      'E4',
      'E5',
      'E6',
      'E7',
      'E8'
    ])
    expect(result.answer).toContain('[E1]')
    expect(result.answer).not.toMatch(/\[E(?:10|23)\]/)
    expect(result.aggregation).toMatchObject({
      messageCount: 8,
      peopleCount: 2,
      conversationCount: 2
    })
    expect(result.timings).toMatchObject({
      queryUnderstandingMs: expect.any(Number),
      contactResolutionMs: expect.any(Number),
      knowledgeSearchMs: expect.any(Number),
      ftsMs: 8,
      totalMs: expect.any(Number)
    })
  })

  it('retries a different conversation query after the first search returns zero results', async () => {
    listContactsAsync.mockResolvedValue([
      {
        md5: 'technology-group',
        m_nsUsrName: 'technology-group@chatroom',
        m_nsNickName: '技术交流',
        type: 'group'
      }
    ])
    knowledge.search.mockResolvedValue({
      source: 'knowledge',
      state: 'ready',
      indexedMessageCount: 2_000,
      indexedChunkCount: 300,
      totalMessages: 2_000,
      evidence: [
        {
          chunkId: 'technology-chunk',
          conversationId: 'technology-group',
          startTime: 1785900000000,
          endTime: 1785900000000,
          messageId: 'technology-message',
          sender: '小周',
          timestamp: 1785900000000,
          messageIds: ['technology-message'],
          text: '今天讨论了 Electron 的打包问题。'
        }
      ],
      timings: {
        workerIpcMs: 1,
        ftsMs: 2,
        messageLoadMs: 1,
        chunkExpandMs: 1,
        rankingMs: 1,
        totalMs: 6
      }
    })
    aiProvider.chat.mockReset()
    aiProvider.chat
      .mockResolvedValueOnce({
        success: true,
        data: '{"action":"tool","tool":"search_conversations","arguments":{"query":"技术交流群"}}'
      })
      .mockResolvedValueOnce({
        success: true,
        data: '{"action":"tool","tool":"search_conversations","arguments":{"query":"技术交流"}}'
      })
      .mockResolvedValueOnce({
        success: true,
        data: '{"action":"tool","tool":"get_conversation_messages","arguments":{"conversationRef":"conversation-1","limit":50}}'
      })
      .mockResolvedValueOnce({
        success: true,
        data: '{"action":"finalize","reason":"已获得会话近期消息"}'
      })
      .mockResolvedValueOnce({ success: true, data: '技术交流讨论了 Electron 打包问题。[E1]' })
    const events: Array<Record<string, unknown>> = []
    const service = new AiSearchPipelineService(knowledge as never, aiProvider as never)

    const result = await service.run(
      { requestId: 'retry-query', text: '我在技术交流群聊了什么？', scope: 'global', range: '30d' },
      (event) => events.push(event as unknown as Record<string, unknown>)
    )

    expect(result).toMatchObject({ status: 'completed', agent: { mode: 'agent', toolCalls: 3 } })
    expect(result.agent.trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toolName: 'search_conversations', resultCount: 0 }),
        expect.objectContaining({ toolName: 'search_conversations', resultCount: 1 }),
        expect.objectContaining({ toolName: 'get_conversation_messages', resultCount: 1 })
      ])
    )
    expect(knowledge.search).toHaveBeenCalledWith(
      expect.objectContaining({ terms: [], conversationIds: ['technology-group'], limit: 50 })
    )
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: 'agent_tool',
          agentTrace: expect.objectContaining({ resultCount: 0 })
        })
      ])
    )
  })

  it('uses person lookup then metadata conversation retrieval for a contact summary', async () => {
    listContactsAsync.mockResolvedValue([
      {
        md5: 'zhongtian-contact',
        m_nsUsrName: 'wxid_zhongtian',
        m_nsNickName: '中田健身-弘毅',
        type: 'user'
      }
    ])
    knowledge.search.mockResolvedValue({
      source: 'knowledge',
      state: 'ready',
      indexedMessageCount: 2_000,
      indexedChunkCount: 300,
      totalMessages: 2_000,
      evidence: Array.from({ length: 8 }, (_, index) => ({
        ...makeCandidate(index + 1),
        conversationId: 'zhongtian-contact'
      })),
      timings: {
        workerIpcMs: 1,
        ftsMs: 0,
        messageLoadMs: 2,
        chunkExpandMs: 0,
        rankingMs: 1,
        totalMs: 4
      },
      conversationRetrieval: {
        conversationId: 'zhongtian-contact',
        totalMessages: 327,
        chunkCount: 10,
        candidateMessages: 30,
        systemMessagesDeprioritized: 2,
        complete: true
      }
    })
    aiProvider.chat.mockReset()
    aiProvider.chat
      .mockResolvedValueOnce({
        success: true,
        data: '{"action":"tool","tool":"search_people","arguments":{"query":"中田健身-弘毅"}}'
      })
      .mockResolvedValueOnce({
        success: true,
        data: '{"action":"tool","tool":"get_conversation_messages","arguments":{"conversationRef":"conversation-1"}}'
      })
      .mockResolvedValueOnce({ success: true, data: '你们最近聊过健身安排。[E1]' })
    const service = new AiSearchPipelineService(knowledge as never, aiProvider as never)

    const result = await service.run(
      {
        requestId: 'contact-summary',
        text: '我和中田健身-弘毅最近聊了什么？',
        scope: 'global',
        range: '30d'
      },
      () => undefined
    )

    expect(result).toMatchObject({ status: 'completed', agent: { mode: 'agent', toolCalls: 2 } })
    expect(knowledge.search).toHaveBeenCalledWith(
      expect.objectContaining({
        terms: [],
        conversationIds: ['zhongtian-contact'],
        startTime: expect.any(Number)
      })
    )
    expect(knowledge.search).not.toHaveBeenCalledWith(
      expect.objectContaining({ terms: expect.arrayContaining(['中田健身-弘毅']) })
    )
    expect(aiProvider.chat).toHaveBeenCalledTimes(3)
    expect(result.agent.trace).toContainEqual(
      expect.objectContaining({ label: '本地资料已覆盖所选时间范围，可直接整理回答' })
    )
    const decisions = result.agent.trace.filter((item) => item.event === 'agentDecision')
    expect(decisions[0]?.decisionInput).toContain('上一次 Tool 结果：尚未执行 Tool。')
    expect(decisions[1]?.decisionInput).toContain('中田健身-弘毅')
  })

  it('keeps a direct contact recap on metadata retrieval when the Agent JSON response is invalid', async () => {
    listContactsAsync.mockResolvedValue([
      {
        md5: 'zhongtian-contact',
        m_nsUsrName: 'wxid_zhongtian',
        m_nsNickName: '中田健身-弘毅',
        type: 'user'
      }
    ])
    knowledge.search.mockResolvedValue({
      source: 'knowledge',
      state: 'ready',
      indexedMessageCount: 2_000,
      indexedChunkCount: 300,
      totalMessages: 2_000,
      evidence: Array.from({ length: 8 }, (_, index) => ({
        ...makeCandidate(index + 1),
        conversationId: 'zhongtian-contact',
        text: `我肚子前面放盒肌酸，才是 ${118 + index}。`
      }))
    })
    aiProvider.chat.mockReset()
    aiProvider.chat
      .mockResolvedValueOnce({ success: true, data: '我建议先找到这位联系人。' })
      .mockResolvedValueOnce({ success: true, data: '你们最近聊到了腰围和肌酸。[E1]' })
    const service = new AiSearchPipelineService(knowledge as never, aiProvider as never)

    const result = await service.run(
      {
        requestId: 'contact-summary-agent-recovery',
        text: '我和中田健身弘毅最近聊了什么？',
        scope: 'global',
        range: 'all'
      },
      () => undefined
    )

    expect(result).toMatchObject({
      status: 'completed',
      agent: {
        mode: 'fallback',
        fallbackReason: expect.stringContaining('相同检索意图的本地确定性策略')
      }
    })
    expect(knowledge.search).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationIds: ['zhongtian-contact'],
        terms: [],
        startTime: expect.any(Number)
      })
    )
    expect(knowledge.search).not.toHaveBeenCalledWith(
      expect.objectContaining({ terms: expect.arrayContaining(['中田健身弘毅']) })
    )
  })

  it('uses person lookup plus conversation-scoped topic search for a contact question', async () => {
    listContactsAsync.mockResolvedValue([
      {
        md5: 'zhongtian-contact',
        m_nsUsrName: 'wxid_zhongtian',
        m_nsNickName: '中田健身-弘毅',
        type: 'user'
      }
    ])
    aiProvider.chat.mockReset()
    aiProvider.chat
      .mockResolvedValueOnce({
        success: true,
        data: '{"action":"tool","tool":"search_people","arguments":{"query":"中田健身-弘毅"}}'
      })
      .mockResolvedValueOnce({
        success: true,
        data: '{"action":"tool","tool":"search_messages","arguments":{"conversationRef":"conversation-1","query":"健身"}}'
      })
      .mockResolvedValueOnce({
        success: true,
        data: '{"action":"finalize","reason":"已找到话题证据"}'
      })
      .mockResolvedValueOnce({ success: true, data: '你们最近聊过健身。[E1]' })
    const service = new AiSearchPipelineService(knowledge as never, aiProvider as never)

    const result = await service.run(
      {
        requestId: 'contact-topic',
        text: '我和中田健身-弘毅最近聊过健身吗？',
        scope: 'global',
        range: 'all'
      },
      () => undefined
    )

    expect(result).toMatchObject({ status: 'completed', agent: { mode: 'agent', toolCalls: 2 } })
    expect(knowledge.search).toHaveBeenCalledWith(
      expect.objectContaining({
        terms: ['健身'],
        conversationIds: ['zhongtian-contact'],
        startTime: expect.any(Number)
      })
    )
    expect(knowledge.search).not.toHaveBeenCalledWith(
      expect.objectContaining({ terms: expect.arrayContaining(['中田健身-弘毅']) })
    )
  })

  it('rejects a forbidden contact-recall FTS action and keeps the deterministic fallback semantic', async () => {
    listContactsAsync.mockResolvedValue([
      {
        md5: 'zhongtian-contact',
        m_nsUsrName: 'wxid_zhongtian',
        m_nsNickName: '中田健身-弘毅',
        type: 'user'
      }
    ])
    aiProvider.chat.mockReset()
    aiProvider.chat
      .mockResolvedValueOnce({
        success: true,
        data: '{"action":"tool","tool":"search_messages","arguments":{"query":"中田健身弘毅"}}'
      })
      .mockResolvedValueOnce({ success: true, data: '这不是有效 Agent JSON' })
      .mockResolvedValueOnce({ success: true, data: '已从会话中整理出最近内容。[E1]' })
    const service = new AiSearchPipelineService(knowledge as never, aiProvider as never)

    const result = await service.run(
      {
        requestId: 'forbidden-contact-recall-fts',
        text: '我和中田健身弘毅最近聊了什么？',
        scope: 'global',
        range: '30d'
      },
      () => undefined
    )

    expect(result.agent).toMatchObject({ mode: 'fallback' })
    expect(result.agent.trace).toContainEqual(
      expect.objectContaining({
        toolName: 'search_messages',
        decision: expect.stringContaining('联系人回顾只允许')
      })
    )
    expect(knowledge.search).toHaveBeenCalledWith(
      expect.objectContaining({ conversationIds: ['zhongtian-contact'], terms: [] })
    )
    expect(knowledge.search).not.toHaveBeenCalledWith(
      expect.objectContaining({ terms: expect.arrayContaining(['中田健身弘毅']) })
    )
  })

  it('rejects an unscoped FTS action for a contact topic question', async () => {
    listContactsAsync.mockResolvedValue([
      {
        md5: 'zhongtian-contact',
        m_nsUsrName: 'wxid_zhongtian',
        m_nsNickName: '中田健身-弘毅',
        type: 'user'
      }
    ])
    aiProvider.chat.mockReset()
    aiProvider.chat
      .mockResolvedValueOnce({
        success: true,
        data: '{"action":"tool","tool":"search_messages","arguments":{"query":"健身"}}'
      })
      .mockResolvedValueOnce({ success: true, data: '无效控制输出' })
      .mockResolvedValueOnce({ success: true, data: '你们聊过健身。[E1]' })
    const service = new AiSearchPipelineService(knowledge as never, aiProvider as never)

    await service.run(
      {
        requestId: 'forbidden-unscoped-contact-topic',
        text: '我和中田健身弘毅最近聊过健身吗？',
        scope: 'global',
        range: '30d'
      },
      () => undefined
    )

    expect(knowledge.search).toHaveBeenCalledWith(
      expect.objectContaining({
        terms: ['健身'],
        conversationIds: ['zhongtian-contact']
      })
    )
    expect(knowledge.search).not.toHaveBeenCalledWith(
      expect.objectContaining({ terms: ['健身'], conversationIds: undefined })
    )
  })

  it('flags suspicious contact retrieval and refuses to summarize one message as a full conversation', async () => {
    listContactsAsync.mockResolvedValue([
      {
        md5: 'zhongtian-contact',
        m_nsUsrName: 'wxid_zhongtian',
        m_nsNickName: '中田健身-弘毅',
        type: 'user'
      }
    ])
    knowledge.search.mockResolvedValue({
      source: 'knowledge',
      state: 'ready',
      indexedMessageCount: 2_000,
      indexedChunkCount: 300,
      totalMessages: 2_000,
      evidence: [{ ...makeCandidate(1), conversationId: 'zhongtian-contact' }],
      conversationRetrieval: {
        conversationId: 'zhongtian-contact',
        totalMessages: 134,
        chunkCount: 8,
        candidateMessages: 1,
        systemMessagesDeprioritized: 1,
        complete: true
      }
    })
    aiProvider.chat.mockReset()
    aiProvider.chat
      .mockResolvedValueOnce({
        success: true,
        data: '{"action":"tool","tool":"search_people","arguments":{"query":"中田健身弘毅"}}'
      })
      .mockResolvedValueOnce({
        success: true,
        data: '{"action":"tool","tool":"get_conversation_messages","arguments":{"conversationRef":"conversation-1"}}'
      })
    const service = new AiSearchPipelineService(knowledge as never, aiProvider as never)

    const result = await service.run(
      {
        requestId: 'suspicious-contact-retrieval',
        text: '我和中田健身弘毅最近聊了什么？',
        scope: 'global',
        range: '30d'
      },
      () => undefined
    )

    expect(result).toMatchObject({
      status: 'retrieval_incomplete',
      retrieval: {
        conversationId: 'zhongtian-contact',
        sourceMessageCount: 134,
        candidateCount: 1,
        suspicious: true
      }
    })
    expect(knowledge.search).toHaveBeenCalledTimes(2)
    expect(aiProvider.chat).toHaveBeenCalledTimes(2)
  })

  it('does not turn a zero-result person lookup or early Agent finalize into contact-name FTS', async () => {
    listContactsAsync.mockResolvedValue([
      {
        md5: 'zhongtian-contact',
        m_nsUsrName: 'wxid_zhongtian',
        m_nsNickName: '中田健身-弘毅',
        type: 'user'
      }
    ])
    aiProvider.chat.mockReset()
    aiProvider.chat
      .mockResolvedValueOnce({
        success: true,
        data: '{"action":"tool","tool":"search_people","arguments":{"query":"不存在的人"}}'
      })
      .mockResolvedValueOnce({
        success: true,
        data: '{"action":"finalize","reason":"没有足够证据"}'
      })
    const service = new AiSearchPipelineService(knowledge as never, aiProvider as never)

    const result = await service.run(
      {
        requestId: 'zero-person-lookup-safe',
        text: '我和中田健身弘毅最近聊了什么？',
        scope: 'global',
        range: '30d'
      },
      () => undefined
    )

    expect(result).toMatchObject({ status: 'no_evidence', agent: { mode: 'agent', toolCalls: 1 } })
    expect(knowledge.search).not.toHaveBeenCalled()
    expect(aiProvider.chat).toHaveBeenCalledTimes(2)
  })

  it('stops after five Tool calls instead of searching indefinitely', async () => {
    aiProvider.chat.mockReset()
    for (let index = 0; index < 5; index += 1) {
      aiProvider.chat.mockResolvedValueOnce({
        success: true,
        data: `{"action":"tool","tool":"search_conversations","arguments":{"query":"不存在的群${index}"}}`
      })
    }
    const service = new AiSearchPipelineService(knowledge as never, aiProvider as never)

    const result = await service.run(
      {
        requestId: 'max-tool-calls',
        text: '我在一个不存在的群聊了什么？',
        scope: 'global',
        range: '30d'
      },
      () => undefined
    )

    expect(result).toMatchObject({ status: 'no_evidence', agent: { mode: 'agent', toolCalls: 5 } })
    expect(result.agent.trace).toContainEqual(
      expect.objectContaining({ label: '已达到本次检索上限' })
    )
    expect(aiProvider.chat).toHaveBeenCalledTimes(5)
    expect(knowledge.search).not.toHaveBeenCalled()
  })

  it('falls back to the existing one-shot search when Agent output violates the control protocol', async () => {
    aiProvider.chat.mockReset()
    aiProvider.chat
      .mockResolvedValueOnce({ success: true, data: '我来执行任意代码' })
      .mockResolvedValueOnce({ success: true, data: '{"intent":"topic","keywords":["健身"]}' })
      .mockResolvedValueOnce({ success: true, data: '小明聊到健身。[E1]' })
    const service = new AiSearchPipelineService(knowledge as never, aiProvider as never)

    const result = await service.run(
      { requestId: 'agent-fallback', text: '最近聊过健身吗？', scope: 'global', range: '7d' },
      () => undefined
    )

    expect(result).toMatchObject({ status: 'completed', agent: { mode: 'fallback', toolCalls: 0 } })
    expect(result.agent.fallbackReason).toContain('受控搜索 Agent')
  })
})
