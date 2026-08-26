import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { aiSearchRangeStart } from '../../../../../shared/ai-search'
import type { AiSearchTimeRange } from '../../../../../shared/ai-search'
import {
  RANGE_LABELS,
  SEARCH_ACTIVE_RESULT_KEY,
  SEARCH_CACHE_KEY,
  SEARCH_HISTORY_KEY,
  buildSearchCacheKey,
  parseSearchCacheKey,
  readSearchCache,
  readSearchCacheByQuery,
  writeSearchCache
} from '../searchUtils'
import { createSearchCacheRecord, mapCacheRecordToResult } from '../searchMappers'
import type {
  AISearchCacheRecord,
  EvidenceItem,
  SearchRange,
  SearchScope,
  SearchStage
} from '../searchTypes'

const DEFAULT_EVIDENCE_PAGE_SIZE = 8

type UseSearchHistoryOptions = {
  query: string
  scope: SearchScope
  range: SearchRange
  conversationContactMd5: string
  evidencePageSize?: number
  setQuery: Dispatch<SetStateAction<string>>
  setScope: Dispatch<SetStateAction<SearchScope>>
  setScopeContactMd5: Dispatch<SetStateAction<string>>
  setRange: Dispatch<SetStateAction<SearchRange>>
  setTimeRangeOverride: Dispatch<SetStateAction<AiSearchTimeRange | undefined>>
  setResultQuery: Dispatch<SetStateAction<string>>
  setAnswer: Dispatch<SetStateAction<string>>
  setEvidence: Dispatch<SetStateAction<EvidenceItem[]>>
  setEvidenceCollection: Dispatch<SetStateAction<EvidenceItem[]>>
  setVisibleEvidenceCount: Dispatch<SetStateAction<number>>
  setSenderNames: Dispatch<SetStateAction<Record<string, string>>>
  setMessageCount: Dispatch<SetStateAction<number>>
  setCachedAt: Dispatch<SetStateAction<number>>
  setAnalysisError: Dispatch<SetStateAction<string>>
  setStage: Dispatch<SetStateAction<SearchStage>>
  setSelectedEvidence: Dispatch<SetStateAction<number>>
  setHistoryOpen: Dispatch<SetStateAction<boolean>>
  onNotice: (message: string) => void
}

type PersistSearchResultInput = {
  key: string
  answer: string
  evidence: EvidenceItem[]
  evidenceCollection: EvidenceItem[]
  senderNames: Record<string, string>
  messageCount: number
}

export function useSearchHistory({
  query,
  scope,
  range,
  conversationContactMd5,
  evidencePageSize = DEFAULT_EVIDENCE_PAGE_SIZE,
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
}: UseSearchHistoryOptions): {
  history: string[]
  rememberQuery: (value: string) => void
  removeHistoryQuery: (historyQuery: string) => void
  restoreHistoryQuery: (historyQuery: string) => void
  applyCachedResult: (cached: AISearchCacheRecord, queryValue?: string) => void
  readCachedResult: (cacheKey: string) => AISearchCacheRecord | null
  persistSearchResult: (input: PersistSearchResultInput) => AISearchCacheRecord
  clearActiveResult: () => void
  skipNextCache: () => void
  consumeCacheBypass: () => boolean
  clearCacheBypass: () => void
} {
  const [history, setHistory] = useState<string[]>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY) || '[]')
      return Array.isArray(stored)
        ? stored.filter((item): item is string => typeof item === 'string')
        : []
    } catch {
      return []
    }
  })
  const bypassCacheRef = useRef(false)

  const rememberQuery = (value: string): void => {
    setHistory((current) => {
      const next = [value, ...current.filter((item) => item !== value)].slice(0, 10)
      try {
        localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(next))
      } catch {
        // History persistence is optional and must not interrupt analysis.
      }
      return next
    })
  }

  const removeHistoryQuery = (historyQuery: string): void => {
    setHistory((current) => {
      const next = current.filter((item) => item !== historyQuery)
      try {
        localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(next))
      } catch {
        // History persistence is optional and must not interrupt analysis.
      }
      return next
    })
    try {
      const records = JSON.parse(
        localStorage.getItem(SEARCH_CACHE_KEY) || '[]'
      ) as AISearchCacheRecord[]
      const queryKey = historyQuery.trim().toLowerCase()
      localStorage.setItem(
        SEARCH_CACHE_KEY,
        JSON.stringify(
          records.filter((item) => {
            try {
              const keyParts = JSON.parse(item.key) as unknown
              return !(
                Array.isArray(keyParts) &&
                typeof keyParts[3] === 'string' &&
                keyParts[3] === queryKey
              )
            } catch {
              return true
            }
          })
        )
      )
    } catch {
      // Cache cleanup is optional and must not interrupt the current workspace.
    }
  }

  const applyCachedResult = (cached: AISearchCacheRecord, queryValue = query.trim()): void => {
    const mapped = mapCacheRecordToResult(cached, queryValue, evidencePageSize)
    setResultQuery(mapped.resultQuery)
    setAnswer(mapped.answer)
    setEvidence(mapped.evidence)
    setEvidenceCollection(mapped.evidenceCollection)
    setVisibleEvidenceCount(mapped.visibleEvidenceCount)
    setSenderNames(mapped.senderNames)
    setMessageCount(mapped.messageCount)
    setCachedAt(mapped.cachedAt)
    rememberQuery(queryValue)
    try {
      sessionStorage.setItem(SEARCH_ACTIVE_RESULT_KEY, cached.key)
    } catch {
      // Result restoration is optional and must not block search.
    }
  }

  const restoreHistoryQuery = (historyQuery: string): void => {
    setQuery(historyQuery)
    setSelectedEvidence(0)
    setHistoryOpen(false)
    const cacheKey = buildSearchCacheKey(
      scope,
      scope === 'conversation' ? conversationContactMd5 : '',
      range,
      historyQuery
    )
    const cached = readSearchCache(cacheKey) || readSearchCacheByQuery(historyQuery)?.record || null
    if (!cached) {
      setAnswer('')
      setEvidence([])
      setEvidenceCollection([])
      setVisibleEvidenceCount(0)
      setCachedAt(0)
      setStage('idle')
      onNotice('已填入历史问题，点击开始分析可重新查询最新消息')
      return
    }
    const cachedLocation = parseSearchCacheKey(cached.key)
    if (cachedLocation) {
      setScope(cachedLocation.scope)
      setRange(cachedLocation.range)
      setScopeContactMd5(cachedLocation.contactMd5)
      setTimeRangeOverride({
        startTime: aiSearchRangeStart(cachedLocation.range),
        endTime: undefined,
        label: RANGE_LABELS[cachedLocation.range],
        reason: '恢复历史搜索的时间范围',
        source: 'user_selected'
      })
    }
    setAnalysisError('')
    applyCachedResult(cached, historyQuery)
    setStage('result')
    onNotice('已恢复这条历史问题的最近结果')
  }

  const persistSearchResult = (input: PersistSearchResultInput): AISearchCacheRecord => {
    const record = createSearchCacheRecord({
      ...input,
      createdAt: Date.now()
    })
    writeSearchCache(record)
    try {
      sessionStorage.setItem(SEARCH_ACTIVE_RESULT_KEY, record.key)
    } catch {
      // Result persistence is optional and must not block search.
    }
    return record
  }

  const clearActiveResult = (): void => {
    try {
      sessionStorage.removeItem(SEARCH_ACTIVE_RESULT_KEY)
    } catch {
      // Result cleanup is optional and must not interrupt the current workspace.
    }
  }

  const skipNextCache = (): void => {
    bypassCacheRef.current = true
  }

  const consumeCacheBypass = (): boolean => {
    const shouldBypass = bypassCacheRef.current
    bypassCacheRef.current = false
    return shouldBypass
  }

  const clearCacheBypass = (): void => {
    bypassCacheRef.current = false
  }

  useEffect(() => {
    try {
      const cacheKey = sessionStorage.getItem(SEARCH_ACTIVE_RESULT_KEY)
      if (!cacheKey) return
      const cached = readSearchCache(cacheKey)
      const location = parseSearchCacheKey(cacheKey)
      if (!cached || !location) {
        sessionStorage.removeItem(SEARCH_ACTIVE_RESULT_KEY)
        return
      }
      setQuery(location.query)
      setScope(location.scope)
      setScopeContactMd5(location.contactMd5)
      setRange(location.range)
      setTimeRangeOverride({
        startTime: aiSearchRangeStart(location.range),
        endTime: undefined,
        label: RANGE_LABELS[location.range],
        reason: '恢复上次查看的搜索结果',
        source: 'user_selected'
      })
      setAnalysisError('')
      applyCachedResult(cached, location.query)
      setStage('result')
    } catch {
      sessionStorage.removeItem(SEARCH_ACTIVE_RESULT_KEY)
    }
  }, [])

  return {
    history,
    rememberQuery,
    removeHistoryQuery,
    restoreHistoryQuery,
    applyCachedResult,
    readCachedResult: readSearchCache,
    persistSearchResult,
    clearActiveResult,
    skipNextCache,
    consumeCacheBypass,
    clearCacheBypass
  }
}
