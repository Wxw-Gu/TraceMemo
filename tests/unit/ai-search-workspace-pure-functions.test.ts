import { describe, expect, it } from 'vitest'
import type { AiSearchFinalEvidence, AiSearchPipelineResult } from '../../src/shared/ai-search'
import type { KnowledgeRuntimeStatus } from '../../src/shared/knowledge'
import type { Contact } from '../../src/shared/types'
import {
  contactLabel,
  formatBytes,
  formatDuration,
  formatEvidenceTimestamp,
  formatMeasuredDuration,
  formatSearchTraceOverview,
  knowledgeStateLabel
} from '../../src/renderer/src/components/search/searchFormatters'
import {
  createSearchCacheRecord,
  mapCacheRecordToResult,
  mapEvidenceSenderNames,
  mapPipelineEvidence,
  mapPipelineEvidenceItem,
  mapSearchResultToTrace
} from '../../src/renderer/src/components/search/searchMappers'
import { createSearchResultResetState } from '../../src/renderer/src/components/search/searchState'
import type {
  AISearchCacheRecord,
  EvidenceItem,
  SearchTrace
} from '../../src/renderer/src/components/search/searchTypes'
import {
  aiSearchContact,
  aiSearchGroup,
  makeSearchResult
} from '../component/support/ai-search-fixtures'

const makeFinalEvidence = (
  index: number,
  overrides: Partial<AiSearchFinalEvidence> = {}
): AiSearchFinalEvidence => ({
  id: `E${index}`,
  chunkId: `chunk-${index}`,
  conversationId: aiSearchContact.md5,
  conversationName: aiSearchContact.m_nsNickName,
  conversationType: aiSearchContact.type,
  startTime: 1_700_000_000_000 + index * 1_000,
  endTime: 1_700_000_000_000 + index * 1_000,
  messageId: `message-${index}`,
  senderId: `sender-${index}`,
  sender: `发送者 ${index}`,
  timestamp: 1_700_000_000_000 + index * 1_000,
  messageIds: [`message-${index}`],
  sourceKind: 'text',
  text: `证据 ${index}`,
  ...overrides
})

const makeKnowledgeStatus = (state: KnowledgeRuntimeStatus['state']): KnowledgeRuntimeStatus => ({
  accountId: 'account-1',
  state,
  indexedMessageCount: 0,
  indexedChunkCount: 0,
  sourceMessageCount: null,
  processedMessages: 0,
  totalMessages: null,
  estimatedRemainingMs: null,
  databaseBytes: 0,
  walBytes: 0,
  shmBytes: 0
})

const makeTrace = (overrides: Partial<SearchTrace> = {}): SearchTrace => ({
  knowledgeMessages: 20,
  retrievedEvidence: 10,
  finalEvidence: 8,
  timings: {
    totalMs: 1_250,
    knowledgeSearchMs: 250,
    aiGenerationMs: 1_000
  } as SearchTrace['timings'],
  contextEvidence: 6,
  inputTokensEstimated: false,
  aggregation: {
    messageCount: 8,
    peopleCount: 1,
    conversationCount: 1,
    people: [],
    conversations: []
  },
  invalidCitationIds: [],
  agent: { mode: 'agent', toolCalls: 0, trace: [] },
  ...overrides
})

describe('AI Search workspace pure formatters', () => {
  it('formats byte counts exactly as the workspace did', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1_536)).toBe('1.5 KB')
    expect(formatBytes(2 * 1024 ** 3)).toBe('2.0 GB')
  })

  it('formats measured and unmeasured durations exactly as the workspace did', () => {
    expect(formatDuration(999)).toBe('999ms')
    expect(formatDuration(1_250)).toBe('1.3s')
    expect(formatMeasuredDuration(undefined)).toBe('未测量')
    expect(formatMeasuredDuration(1_000)).toBe('1.0s')
  })

  it('formats evidence timestamps with the existing zh-CN locale options', () => {
    const timestamp = 1_700_000_001_000
    expect(formatEvidenceTimestamp(timestamp)).toBe(
      new Date(timestamp).toLocaleString('zh-CN', { hour12: false })
    )
  })

  it('keeps every knowledge runtime state label unchanged', () => {
    expect(knowledgeStateLabel(null)).toBe('读取中')
    expect(knowledgeStateLabel(makeKnowledgeStatus('unavailable'))).toBe('未建立')
    expect(knowledgeStateLabel(makeKnowledgeStatus('building'))).toBe('建立中')
    expect(knowledgeStateLabel(makeKnowledgeStatus('syncing'))).toBe('增量同步')
    expect(knowledgeStateLabel(makeKnowledgeStatus('ready'))).toBe('已同步')
    expect(knowledgeStateLabel(makeKnowledgeStatus('error'))).toBe('异常')
  })

  it('keeps the existing contact label fallback order', () => {
    expect(contactLabel(aiSearchContact)).toBe('测试会话')
    expect(contactLabel({ ...aiSearchContact, m_nsNickName: '' })).toBe('测试联系人')
    expect(
      contactLabel({ ...aiSearchContact, m_nsNickName: '', remark: '', wechatNickname: '' })
    ).toBe('wxid_fixture')
    expect(contactLabel(null)).toBe('未选择会话')
  })

  it('formats the compact search trace overview without changing labels or units', () => {
    expect(formatSearchTraceOverview(makeTrace())).toEqual({
      totalDuration: '1.3s',
      knowledgeDuration: '250ms',
      aiDuration: '1.0s',
      contextEvidence: '6 条'
    })
  })
})

describe('AI Search pipeline evidence mapping', () => {
  it('reuses the existing renderer contact object when the conversation is loaded', () => {
    const item = makeFinalEvidence(1)
    const mapped = mapPipelineEvidenceItem(item, new Map([[aiSearchContact.md5, aiSearchContact]]))

    expect(mapped.contact).toBe(aiSearchContact)
    expect(mapped).toEqual({
      evidenceId: 'E1',
      sourceKind: 'text',
      contact: aiSearchContact,
      message: {
        id: 'message-1',
        from: 'sender-1',
        type: '检索消息',
        datetime: formatEvidenceTimestamp(item.timestamp),
        content: '证据 1',
        isSender: false,
        name: '发送者 1',
        senderId: 'sender-1',
        createTime: Math.floor(item.timestamp / 1_000)
      }
    })
  })

  it('creates the existing group fallback and voice presentation for an unloaded conversation', () => {
    const item = makeFinalEvidence(2, {
      conversationId: 'missing@chatroom',
      conversationName: '未加载群',
      conversationType: 'group',
      sourceKind: 'voice',
      sender: '我'
    })
    const mapped = mapPipelineEvidenceItem(item, new Map())

    expect(mapped.contact).toEqual({
      md5: 'missing@chatroom',
      m_nsUsrName: 'missing@chatroom',
      m_nsNickName: '未加载群',
      type: 'group'
    })
    expect(mapped.message.type).toBe('语音转写')
    expect(mapped.message.isSender).toBe(true)
  })

  it('creates the existing user fallback and sender default when senderId is absent', () => {
    const item = makeFinalEvidence(3, {
      conversationId: 'missing-user',
      conversationName: '未加载联系人',
      conversationType: 'user',
      senderId: undefined
    })
    const mapped = mapPipelineEvidenceItem(item, new Map())

    expect(mapped.contact.type).toBe('user')
    expect(mapped.message.from).toBe('user')
    expect(mapped.message.senderId).toBeUndefined()
  })

  it('maps a collection in order and builds sender names with the existing overwrite behavior', () => {
    const items = [
      makeFinalEvidence(1, { senderId: 'same-sender', sender: '旧名称' }),
      makeFinalEvidence(2, { senderId: 'same-sender', sender: '新名称' }),
      makeFinalEvidence(3, { senderId: undefined, sender: '无 ID' })
    ]
    const mapped = mapPipelineEvidence(items, [aiSearchContact])

    expect(mapped.map((item) => item.evidenceId)).toEqual(['E1', 'E2', 'E3'])
    expect(mapEvidenceSenderNames(mapped)).toEqual({ 'same-sender': '新名称' })
  })
})

describe('AI Search trace and cache mapping', () => {
  it('maps pipeline trace fields and preserves the original default values', () => {
    const result: AiSearchPipelineResult = makeSearchResult()

    expect(mapSearchResultToTrace(result, 4)).toEqual({
      knowledgeMessages: 20,
      retrievedEvidence: 0,
      finalEvidence: 4,
      timings: result.timings,
      contextEvidence: 0,
      inputTokens: undefined,
      inputTokensEstimated: false,
      aggregation: result.aggregation,
      invalidCitationIds: [],
      agent: result.agent,
      voiceCoverage: undefined
    })
  })

  it('maps AI token, citation, and voice coverage details without transforming them', () => {
    const result: AiSearchPipelineResult = makeSearchResult()
    result.ai = {
      providerName: 'provider',
      modelName: 'model',
      inputTokens: 321,
      inputTokensEstimated: true
    }
    result.citationValidation = { status: 'sanitized', invalidCitationIds: ['E9'] }
    result.knowledge.voiceCoverage = {
      voiceMessageCount: 3,
      transcribedVoiceCount: 2,
      failedVoiceCount: 1,
      voiceCoverageComplete: true
    }

    const trace = mapSearchResultToTrace(result, 2)
    expect(trace.inputTokens).toBe(321)
    expect(trace.inputTokensEstimated).toBe(true)
    expect(trace.invalidCitationIds).toEqual(['E9'])
    expect(trace.voiceCoverage).toBe(result.knowledge.voiceCoverage)
  })

  it('maps a current cache record and limits only the visible collection to one page', () => {
    const evidence = mapPipelineEvidence([makeFinalEvidence(1)], [aiSearchContact])
    const evidenceCollection = mapPipelineEvidence(
      Array.from({ length: 10 }, (_, index) => makeFinalEvidence(index + 1)),
      [aiSearchContact]
    )
    const cached: AISearchCacheRecord = {
      version: 3,
      key: 'cache-key',
      createdAt: 123,
      answer: '缓存答案',
      evidence,
      evidenceCollection,
      senderNames: { 'sender-1': '发送者 1' },
      messageCount: 99
    }

    const mapped = mapCacheRecordToResult(cached, '恢复问题', 8)
    expect(mapped).toEqual({
      resultQuery: '恢复问题',
      answer: '缓存答案',
      evidence,
      evidenceCollection,
      visibleEvidenceCount: 8,
      senderNames: { 'sender-1': '发送者 1' },
      messageCount: 99,
      cachedAt: 123
    })
  })

  it('falls back to legacy cache evidence when evidenceCollection is absent', () => {
    const evidence = mapPipelineEvidence([makeFinalEvidence(1)], [aiSearchContact])
    const cached: AISearchCacheRecord = {
      version: 3,
      key: 'legacy-cache-key',
      createdAt: 456,
      answer: '旧缓存',
      evidence,
      senderNames: {},
      messageCount: 1
    }

    const mapped = mapCacheRecordToResult(cached, '旧问题', 8)
    expect(mapped.evidenceCollection).toBe(evidence)
    expect(mapped.visibleEvidenceCount).toBe(1)
  })

  it('creates the same compact version 3 cache record as the workspace did', () => {
    const fullContact: Contact = { ...aiSearchGroup, avatar: 'avatar', remark: '不应写入缓存' }
    const evidence: EvidenceItem[] = [
      {
        evidenceId: 'E1',
        sourceKind: 'voice',
        contact: fullContact,
        message: {
          id: 'message-1',
          from: 'sender-1',
          type: '语音转写',
          datetime: '2023/11/14 22:13:21',
          content: '证据 1',
          isSender: false,
          name: '发送者 1',
          senderId: 'sender-1',
          createTime: 1_700_000_001,
          sessionId: '不应写入缓存'
        }
      }
    ]

    expect(
      createSearchCacheRecord({
        key: 'cache-key',
        createdAt: 789,
        answer: '答案',
        evidence,
        evidenceCollection: evidence,
        senderNames: { 'sender-1': '发送者 1' },
        messageCount: 20
      })
    ).toEqual({
      version: 3,
      key: 'cache-key',
      createdAt: 789,
      answer: '答案',
      evidence: [
        {
          evidenceId: 'E1',
          contact: {
            md5: fullContact.md5,
            m_nsUsrName: fullContact.m_nsUsrName,
            m_nsNickName: fullContact.m_nsNickName,
            type: 'group',
            avatar: 'avatar'
          },
          message: {
            id: 'message-1',
            from: 'sender-1',
            type: '语音转写',
            datetime: '2023/11/14 22:13:21',
            content: '证据 1',
            isSender: false,
            name: '发送者 1',
            senderId: 'sender-1',
            localId: undefined,
            serverId: undefined,
            createTime: 1_700_000_001
          }
        }
      ],
      evidenceCollection: [
        {
          evidenceId: 'E1',
          contact: {
            md5: fullContact.md5,
            m_nsUsrName: fullContact.m_nsUsrName,
            m_nsNickName: fullContact.m_nsNickName,
            type: 'group',
            avatar: 'avatar'
          },
          message: {
            id: 'message-1',
            from: 'sender-1',
            type: '语音转写',
            datetime: '2023/11/14 22:13:21',
            content: '证据 1',
            isSender: false,
            name: '发送者 1',
            senderId: 'sender-1',
            localId: undefined,
            serverId: undefined,
            createTime: 1_700_000_001
          }
        }
      ],
      senderNames: { 'sender-1': '发送者 1' },
      messageCount: 20
    })
  })
})

describe('AI Search result reset state', () => {
  it('returns every existing search result reset value', () => {
    expect(createSearchResultResetState()).toEqual({
      analysisError: '',
      answer: '',
      evidence: [],
      evidenceCollection: [],
      visibleEvidenceCount: 0,
      selectedEvidence: 0,
      cachedAt: 0,
      searchTrace: null,
      searchProgress: {},
      agentTrace: [],
      searchDetailsOpen: false
    })
  })

  it('returns independent arrays and progress objects for consecutive resets', () => {
    const first = createSearchResultResetState()
    const second = createSearchResultResetState()

    expect(first.evidence).not.toBe(second.evidence)
    expect(first.evidenceCollection).not.toBe(second.evidenceCollection)
    expect(first.searchProgress).not.toBe(second.searchProgress)
    expect(first.agentTrace).not.toBe(second.agentTrace)
  })
})
