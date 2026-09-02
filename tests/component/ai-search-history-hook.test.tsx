import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { useSearchHistory } from '../../src/renderer/src/components/search/hooks/useSearchHistory'
import type { AiSearchTimeRange } from '../../src/shared/ai-search'
import type {
  AISearchCacheRecord,
  EvidenceItem,
  SearchRange,
  SearchScope,
  SearchStage
} from '../../src/renderer/src/components/search/searchTypes'
import {
  SEARCH_ACTIVE_RESULT_KEY,
  SEARCH_CACHE_KEY,
  SEARCH_HISTORY_KEY,
  buildSearchCacheKey
} from '../../src/renderer/src/components/search/searchUtils'
import {
  aiSearchContact,
  aiSearchGroup,
  makeCacheRecord,
  makePipelineEvidence
} from './support/ai-search-fixtures'

const onNotice = vi.fn()

const useHistoryHarness = () => {
  const [query, setQuery] = useState('当前问题')
  const [scope, setScope] = useState<SearchScope>('global')
  const [scopeContactMd5, setScopeContactMd5] = useState('')
  const [range, setRange] = useState<SearchRange>('30d')
  const [timeRangeOverride, setTimeRangeOverride] = useState<AiSearchTimeRange | undefined>()
  const [resultQuery, setResultQuery] = useState('')
  const [answer, setAnswer] = useState('')
  const [evidence, setEvidence] = useState<EvidenceItem[]>([])
  const [evidenceCollection, setEvidenceCollection] = useState<EvidenceItem[]>([])
  const [visibleEvidenceCount, setVisibleEvidenceCount] = useState(0)
  const [senderNames, setSenderNames] = useState<Record<string, string>>({})
  const [messageCount, setMessageCount] = useState(0)
  const [cachedAt, setCachedAt] = useState(0)
  const [analysisError, setAnalysisError] = useState('')
  const [stage, setStage] = useState<SearchStage>('idle')
  const [selectedEvidence, setSelectedEvidence] = useState(0)
  const [historyOpen, setHistoryOpen] = useState(true)
  const history = useSearchHistory({
    query,
    scope,
    range,
    conversationContactMd5: scopeContactMd5 || aiSearchContact.md5,
    setQuery,
    setScope,
    setScopeContactMd5,
    setRange,
    setTimeRangeOverride,
    setResultQuery,
    setAnswer,
    setEvidence,
    setEvidenceCollection,
    setVisibleEvidenceCount,
    setSenderNames,
    setMessageCount,
    setCachedAt,
    setAnalysisError,
    setStage,
    setSelectedEvidence,
    setHistoryOpen,
    onNotice
  })

  return {
    ...history,
    state: {
      query,
      scope,
      scopeContactMd5,
      range,
      timeRangeOverride,
      resultQuery,
      answer,
      evidence,
      evidenceCollection,
      visibleEvidenceCount,
      senderNames,
      messageCount,
      cachedAt,
      analysisError,
      stage,
      selectedEvidence,
      historyOpen
    }
  }
}

const readCacheRecords = (): AISearchCacheRecord[] =>
  JSON.parse(localStorage.getItem(SEARCH_CACHE_KEY) || '[]') as AISearchCacheRecord[]

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  vi.clearAllMocks()
})

describe('useSearchHistory', () => {
  it('loads and filters the persisted history list', () => {
    localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(['问题 A', 42, null, '问题 B']))

    const { result } = renderHook(() => useHistoryHarness())

    expect(result.current.history).toEqual(['问题 A', '问题 B'])
  })

  it('restores a history cache with its original scope, range and time override', () => {
    const query = '恢复历史问题'
    const cached = makeCacheRecord({
      query,
      scope: 'conversation',
      contactMd5: aiSearchGroup.md5,
      range: '7d',
      answer: '历史缓存答案',
      evidence: [makePipelineEvidence(1, aiSearchGroup)]
    }) as AISearchCacheRecord
    localStorage.setItem(SEARCH_CACHE_KEY, JSON.stringify([cached]))

    const { result } = renderHook(() => useHistoryHarness())
    act(() => result.current.restoreHistoryQuery(query))

    expect(result.current.state.query).toBe(query)
    expect(result.current.state.scope).toBe('conversation')
    expect(result.current.state.scopeContactMd5).toBe(aiSearchGroup.md5)
    expect(result.current.state.range).toBe('7d')
    expect(result.current.state.timeRangeOverride).toMatchObject({
      label: '近 7 天',
      reason: '恢复历史搜索的时间范围',
      source: 'user_selected'
    })
    expect(result.current.state.answer).toBe('历史缓存答案')
    expect(result.current.state.stage).toBe('result')
    expect(result.current.state.historyOpen).toBe(false)
    expect(onNotice).toHaveBeenCalledWith('已恢复这条历史问题的最近结果')
  })

  it('deletes a history item and all cache records for its normalized query', () => {
    const deleted = makeCacheRecord({ query: '待删除问题', answer: '应删除' })
    const retained = makeCacheRecord({ query: '保留问题', answer: '应保留' })
    localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(['待删除问题', '保留问题']))
    localStorage.setItem(SEARCH_CACHE_KEY, JSON.stringify([deleted, retained]))

    const { result } = renderHook(() => useHistoryHarness())
    act(() => result.current.removeHistoryQuery(' 待删除问题 '))

    expect(result.current.history).toEqual(['待删除问题', '保留问题'])
    expect(readCacheRecords()).toEqual([retained])

    act(() => result.current.removeHistoryQuery('待删除问题'))
    expect(result.current.history).toEqual(['保留问题'])
    expect(readCacheRecords()).toEqual([retained])
  })

  it('reads and applies a current cache hit while marking the active session result', () => {
    const cached = makeCacheRecord({
      query: '缓存命中问题',
      answer: '缓存命中答案',
      evidence: [makePipelineEvidence(1)]
    }) as AISearchCacheRecord
    localStorage.setItem(SEARCH_CACHE_KEY, JSON.stringify([cached]))
    const { result } = renderHook(() => useHistoryHarness())

    const found = result.current.readCachedResult(cached.key)
    expect(found).toEqual(cached)
    act(() => result.current.applyCachedResult(cached, '缓存命中问题'))

    expect(result.current.state.answer).toBe('缓存命中答案')
    expect(result.current.state.resultQuery).toBe('缓存命中问题')
    expect(result.current.state.evidence).toHaveLength(1)
    expect(sessionStorage.getItem(SEARCH_ACTIVE_RESULT_KEY)).toBe(cached.key)
  })

  it('preserves an intentionally incomplete cache collection instead of rebuilding it', () => {
    const evidence = makeCacheRecord({
      query: '不完整缓存',
      evidence: [makePipelineEvidence(1)]
    }).evidence as EvidenceItem[]
    const cached: AISearchCacheRecord = {
      version: 3,
      key: buildSearchCacheKey('global', '', '30d', '不完整缓存'),
      createdAt: 10,
      answer: '不完整',
      evidence,
      evidenceCollection: [],
      senderNames: {},
      messageCount: 1
    }
    const { result } = renderHook(() => useHistoryHarness())

    act(() => result.current.applyCachedResult(cached, '不完整缓存'))

    expect(result.current.state.evidence).toHaveLength(1)
    expect(result.current.state.evidenceCollection).toEqual([])
    expect(result.current.state.visibleEvidenceCount).toBe(0)
  })

  it('falls back to legacy evidence when evidenceCollection is absent', () => {
    const cached = makeCacheRecord({
      query: '旧缓存问题',
      evidence: [makePipelineEvidence(1)]
    }) as AISearchCacheRecord
    const { result } = renderHook(() => useHistoryHarness())

    act(() => result.current.applyCachedResult(cached, '旧缓存问题'))

    expect(result.current.state.evidenceCollection).toBe(result.current.state.evidence)
    expect(result.current.state.visibleEvidenceCount).toBe(1)
  })

  it('does not reuse an old cache after the caller marks a new search as bypassing cache', () => {
    const cached = makeCacheRecord({ query: '旧结果', answer: '旧答案' }) as AISearchCacheRecord
    localStorage.setItem(SEARCH_CACHE_KEY, JSON.stringify([cached]))
    const { result } = renderHook(() => useHistoryHarness())

    act(() => result.current.skipNextCache())
    const shouldBypass = result.current.consumeCacheBypass()

    expect(shouldBypass).toBe(true)
    expect(result.current.state.answer).toBe('')
    expect(result.current.consumeCacheBypass()).toBe(false)
    expect(result.current.readCachedResult(cached.key)).toEqual(cached)
  })

  it('persists a new compact cache record and its active session key', () => {
    const { result } = renderHook(() => useHistoryHarness())
    const evidence = makeCacheRecord({
      query: '新搜索问题',
      evidence: [makePipelineEvidence(1)]
    }).evidence as EvidenceItem[]

    act(() =>
      result.current.persistSearchResult({
        key: buildSearchCacheKey('global', '', '30d', '新搜索问题'),
        answer: '新答案',
        evidence,
        evidenceCollection: evidence,
        senderNames: { 'sender-1': '发送者 1' },
        messageCount: 20
      })
    )

    const records = readCacheRecords()
    expect(records).toHaveLength(1)
    expect(records[0].version).toBe(3)
    expect(records[0].answer).toBe('新答案')
    expect(sessionStorage.getItem(SEARCH_ACTIVE_RESULT_KEY)).toBe(records[0].key)
  })
})
