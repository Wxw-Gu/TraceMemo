import React, { useMemo, useRef, useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { aiSearchIntentLabel, aiSearchRangeStart } from '../../../../shared/ai-search'
import type {
  AiSearchAggregation,
  AiSearchAgentRun,
  AiSearchPipelineTimings,
  AiSearchProgressEvent,
  AiSearchProgressStage,
  AiSearchTimeRange
} from '../../../../shared/ai-search'
import type { Contact } from '../../../../shared/types'

import type {
  AISearchCacheRecord,
  AISearchWorkspaceProps,
  EvidenceItem,
  SearchRange,
  SearchScope,
  SearchStage
} from './searchTypes'
import type { KnowledgeRuntimeStatus, KnowledgeVoiceCoverage } from '../../../../shared/knowledge'
import {
  RANGE_LABELS,
  SEARCH_ACTIVE_RESULT_KEY,
  SEARCH_CACHE_KEY,
  SEARCH_HISTORY_KEY,
  buildSearchCacheKey,
  compactCacheItem,
  currentTimestamp,
  formatMessageTime,
  messageIdentity,
  messageText,
  parseSearchCacheKey,
  readSearchCache,
  readSearchCacheByQuery,
  senderName,
  writeSearchCache
} from './searchUtils'
import { markdownToPlainText, renderMarkdown } from './searchMarkdown'

type SearchTrace = {
  knowledgeMessages: number
  retrievedEvidence: number
  finalEvidence: number
  timings: AiSearchPipelineTimings
  contextEvidence: number
  inputTokens?: number
  inputTokensEstimated: boolean
  aggregation: AiSearchAggregation
  invalidCitationIds: string[]
  agent: AiSearchAgentRun
  voiceCoverage?: KnowledgeVoiceCoverage
}

type SearchProgressByStage = Partial<Record<AiSearchProgressStage, AiSearchProgressEvent>>

type ExternalProviderConsent = {
  providerName: string
  recipient: string
}

const formatBytes = (bytes: number): string => {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`
}

const formatDuration = (milliseconds: number): string =>
  milliseconds >= 1000 ? `${(milliseconds / 1000).toFixed(1)}s` : `${milliseconds}ms`

const formatMeasuredDuration = (milliseconds: number | undefined): string =>
  milliseconds === undefined ? '未测量' : formatDuration(milliseconds)

const knowledgeStateLabel = (status: KnowledgeRuntimeStatus | null): string => {
  if (!status) return '读取中'
  return {
    unavailable: '未建立',
    building: '建立中',
    syncing: '增量同步',
    ready: '已同步',
    error: '异常'
  }[status.state]
}

const contactLabel = (contact: Contact | null | undefined): string =>
  contact?.m_nsNickName ||
  contact?.remark ||
  contact?.wechatNickname ||
  contact?.m_nsUsrName ||
  '未选择会话'

const fallbackEvidenceContact = (conversationId: string): Contact => ({
  md5: conversationId,
  m_nsUsrName: conversationId,
  m_nsNickName: '未加载的会话',
  type: conversationId.endsWith('@chatroom') ? 'group' : 'user'
})

export function AISearchWorkspace({
  contacts,
  selectedContact,
  dbReady,
  aiModelConfig,
  onSelectContact,
  onOpenEvidence,
  onOpenAISettings,
  onNotice
}: AISearchWorkspaceProps): React.ReactElement {
  const allContacts = useMemo(() => contacts.filter((contact) => contact.md5), [contacts])
  const [scope, setScope] = useState<SearchScope>('global')
  const [scopeContactMd5, setScopeContactMd5] = useState(selectedContact?.md5 || '')
  const [range, setRange] = useState<SearchRange>('30d')
  const [timeRangeOverride, setTimeRangeOverride] = useState<AiSearchTimeRange | undefined>()
  const [query, setQuery] = useState('')
  const [resultQuery, setResultQuery] = useState('')
  const [stage, setStage] = useState<SearchStage>('idle')
  const [answer, setAnswer] = useState('')
  const [evidence, setEvidence] = useState<EvidenceItem[]>([])
  const [selectedEvidence, setSelectedEvidence] = useState(0)
  const [analysisError, setAnalysisError] = useState('')
  const [messageCount, setMessageCount] = useState(0)
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
  const [senderNames, setSenderNames] = useState<Record<string, string>>({})
  const [cachedAt, setCachedAt] = useState(0)
  const [knowledgeStatus, setKnowledgeStatus] = useState<KnowledgeRuntimeStatus | null>(null)
  const [syncStarting, setSyncStarting] = useState(false)
  const [searchTrace, setSearchTrace] = useState<SearchTrace | null>(null)
  const [searchProgress, setSearchProgress] = useState<SearchProgressByStage>({})
  const [agentTrace, setAgentTrace] = useState<AiSearchAgentRun['trace']>([])
  const [searchDetailsOpen, setSearchDetailsOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [debugEnabled, setDebugEnabled] = useState(false)
  const [debugPanelOpen, setDebugPanelOpen] = useState(false)
  const [debugEntries, setDebugEntries] = useState<string[]>([])
  const [appLogPath, setAppLogPath] = useState('')
  const bypassCacheRef = useRef(false)
  const searchRequestIdRef = useRef('')
  const knowledgeSyncingRef = useRef(false)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const evidenceCardRefs = useRef(new Map<number, HTMLElement>())
  const externalConsentResolverRef = useRef<((approved: boolean) => void) | null>(null)
  const [externalProviderConsent, setExternalProviderConsent] =
    useState<ExternalProviderConsent | null>(null)
  const [evidenceFlash, setEvidenceFlash] = useState({ index: -1, nonce: 0 })

  const focusEvidence = (index: number): void => {
    if (!Number.isInteger(index) || index < 0 || index >= evidence.length) return
    setSelectedEvidence(index)
    setEvidenceFlash((current) => ({ index, nonce: current.nonce + 1 }))
  }

  const settleExternalProviderConsent = (approved: boolean): void => {
    const resolve = externalConsentResolverRef.current
    externalConsentResolverRef.current = null
    setExternalProviderConsent(null)
    resolve?.(approved)
  }

  const requestExternalProviderConsent = (
    providerName: string,
    recipient: string
  ): Promise<boolean> =>
    new Promise((resolve) => {
      externalConsentResolverRef.current = resolve
      setExternalProviderConsent({ providerName, recipient })
    })

  React.useEffect(
    () => () => {
      externalConsentResolverRef.current?.(false)
      externalConsentResolverRef.current = null
    },
    []
  )

  React.useEffect(() => {
    if (!externalProviderConsent) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') settleExternalProviderConsent(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [externalProviderConsent])

  React.useEffect(() => {
    if (evidenceFlash.index < 0) return
    evidenceCardRefs.current.get(evidenceFlash.index)?.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest'
    })
  }, [evidenceFlash])

  React.useEffect(() => {
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

  React.useEffect(() => {
    void Promise.all([window.api.getSettings(), window.api.getAppLogPath()]).then(
      ([settingsResult, logPath]) => {
        setDebugEnabled(settingsResult.settings.debugEnabled)
        setAppLogPath(logPath)
      }
    )
  }, [])

  React.useEffect(() => {
    let active = true
    void window.api
      .getKnowledgeStatus()
      .then((status) => {
        if (active) setKnowledgeStatus(status)
      })
      .catch(() => undefined)
    const unsubscribe = window.api.onKnowledgeStatus((status) => {
      if (active) setKnowledgeStatus(status)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  React.useEffect(
    () =>
      window.api.onAiSearchProgress((progress) => {
        if (progress.requestId !== searchRequestIdRef.current) return
        setSearchProgress((current) => ({ ...current, [progress.stage]: progress }))
        if (progress.agentTrace) {
          setAgentTrace((current) =>
            current.some((item) => item.sequence === progress.agentTrace?.sequence)
              ? current
              : [...current, progress.agentTrace as AiSearchAgentRun['trace'][number]]
          )
        }
      }),
    []
  )

  const addDebugEntry = (message: string, details: Record<string, unknown> = {}): void => {
    const entry = `${new Date().toLocaleTimeString('zh-CN')} ${message} ${JSON.stringify(details)}`
    setDebugEntries((current) => [entry, ...current].slice(0, 80))
    if (debugEnabled) {
      void window.api
        .writeAppLog({ level: 'info', scope: 'ai-search', message, details })
        .catch(() => undefined)
    }
  }

  const activeContact =
    allContacts.find((contact) => contact.md5 === (scopeContactMd5 || selectedContact?.md5)) ||
    selectedContact
  const sourceLabel = {
    global: '所有聊天记录',
    groups: '群聊专属',
    contacts: '联系人专属',
    conversation: contactLabel(activeContact)
  }[scope]
  const currentSyncConversation = knowledgeStatus?.currentConversationId
    ? contactLabel(
        allContacts.find((contact) => contact.md5 === knowledgeStatus.currentConversationId)
      )
    : ''
  const modelLabel = aiModelConfig.configured
    ? `${aiModelConfig.providerName} · ${aiModelConfig.modelName}`
    : '尚未配置 AI 模型'
  const knowledgeSyncing =
    syncStarting || knowledgeStatus?.state === 'building' || knowledgeStatus?.state === 'syncing'
  knowledgeSyncingRef.current = knowledgeSyncing

  const startKnowledgeSync = async (): Promise<void> => {
    if (!dbReady) {
      onNotice('请先连接微信数据后再建立本地知识库')
      return
    }
    setSyncStarting(true)
    try {
      const status = await window.api.startKnowledgeIndex()
      setKnowledgeStatus(status)
      onNotice(
        status.state === 'syncing'
          ? '已开始同步最新聊天记录'
          : '已开始建立本地知识库，可继续使用软件'
      )
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '启动知识库同步失败')
    } finally {
      setSyncStarting(false)
    }
  }

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
    setResultQuery(queryValue)
    setAnswer(cached.answer)
    setEvidence(cached.evidence)
    setSenderNames(cached.senderNames)
    setMessageCount(cached.messageCount)
    setCachedAt(cached.createdAt)
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
      scope === 'conversation' ? activeContact?.md5 || '' : '',
      range,
      historyQuery
    )
    const cached = readSearchCache(cacheKey) || readSearchCacheByQuery(historyQuery)?.record || null
    if (!cached) {
      setAnswer('')
      setEvidence([])
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

  const ensureAiSearchDataConsent = async (requestId: string): Promise<boolean> => {
    const status = await window.api.getAiSearchProviderStatus()
    if (!status.configured || !status.requiresConsent) return true
    if (!status.providerId || !status.recipient) throw new Error('当前 AI 服务信息不完整')
    const confirmed = await requestExternalProviderConsent(
      status.providerName || '当前 AI 服务',
      status.recipient
    )
    if (!confirmed) return false
    const authorized = await window.api.authorizeAiSearchExternalProvider({
      requestId,
      providerId: status.providerId,
      recipient: status.recipient
    })
    if (!authorized.success) throw new Error(authorized.error || '无法确认本次数据发送授权')
    return true
  }

  const cancelAnalysis = async (): Promise<void> => {
    const requestId = searchRequestIdRef.current
    if (!requestId) return
    searchRequestIdRef.current = ''
    setStage('idle')
    setAnalysisError('')
    setSearchProgress({})
    setAgentTrace([])
    setSearchDetailsOpen(false)
    onNotice('已取消本次分析')
    composerRef.current?.focus()
    try {
      await window.api.cancelAiSearch(requestId)
    } catch (error) {
      addDebugEntry('取消检索请求失败', {
        requestId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  const runAnalysis = async (
    event?: React.FormEvent,
    retry?: { range: SearchRange; timeRangeOverride?: AiSearchTimeRange }
  ): Promise<void> => {
    event?.preventDefault()
    if (stage === 'loading') return
    if (knowledgeSyncingRef.current) {
      onNotice('知识库正在同步，请等待同步完成后再开始分析')
      return
    }
    const normalizedQuery = query.trim()
    if (!normalizedQuery) {
      setAnalysisError('先输入一个想了解的问题')
      setStage('insufficient')
      return
    }
    if (!dbReady) {
      setAnalysisError('数据库尚未连接，暂时无法读取聊天记录')
      setStage('insufficient')
      return
    }
    const effectiveRange = retry?.range || range
    const effectiveTimeRangeOverride = retry?.timeRangeOverride || timeRangeOverride
    const cacheKey = buildSearchCacheKey(
      scope,
      scope === 'conversation' ? activeContact?.md5 || '' : '',
      effectiveRange,
      normalizedQuery
    )
    let requestId = ''
    try {
      const cached = bypassCacheRef.current ? null : readSearchCache(cacheKey)
      bypassCacheRef.current = false
      if (cached) {
        addDebugEntry('检索命中缓存', {
          scope,
          range: effectiveRange,
          messageCount: cached.messageCount
        })
        applyCachedResult(cached, normalizedQuery)
        setStage('result')
        onNotice('已使用最近的检索缓存，可点击刷新数据读取最新消息')
        return
      }
      requestId = globalThis.crypto?.randomUUID?.() || `search-${Date.now()}`
      try {
        if (!(await ensureAiSearchDataConsent(requestId))) {
          onNotice('已取消本次 AI Search，未执行检索，也未向远程 AI 服务发送聊天内容')
          return
        }
      } catch {
        onNotice('无法确认 AI 服务的数据发送授权，本次检索未执行')
        return
      }
      if (knowledgeSyncingRef.current) {
        onNotice('知识库正在同步，请等待同步完成后再开始分析')
        return
      }
      setStage('loading')
      setAnalysisError('')
      setAnswer('')
      setEvidence([])
      setSelectedEvidence(0)
      setCachedAt(0)
      setSearchTrace(null)
      setSearchProgress({})
      setAgentTrace([])
      setSearchDetailsOpen(false)
      searchRequestIdRef.current = requestId
      const searchResult = await window.api.runAiSearch({
        requestId,
        text: normalizedQuery,
        scope,
        range: effectiveRange,
        conversationId: scope === 'conversation' ? activeContact?.md5 : undefined,
        timeRangeOverride: effectiveTimeRangeOverride
      })
      if (searchRequestIdRef.current !== requestId) return
      addDebugEntry('主进程搜索任务完成', {
        status: searchResult.status,
        candidateEvidenceCount: searchResult.candidateEvidenceCount,
        finalEvidenceCount: searchResult.evidence.length,
        elapsedMs: searchResult.elapsedMs,
        errorStage: searchResult.errorStage
      })
      if (searchResult.status === 'cancelled') {
        onNotice('已取消本次分析')
        setStage('idle')
        return
      }
      const contactsById = new Map(allContacts.map((contact) => [contact.md5, contact]))
      const evidenceItems: EvidenceItem[] = searchResult.evidence.map((item): EvidenceItem => {
        // Contacts may still be paging in while the derived database already
        // has a valid conversation id. Evidence must never be discarded just
        // because the renderer directory is temporarily incomplete.
        const contact = contactsById.get(item.conversationId) || {
          ...fallbackEvidenceContact(item.conversationId),
          m_nsNickName: item.conversationName,
          type: item.conversationType
        }
        return {
          evidenceId: item.id,
          sourceKind: item.sourceKind,
          contact,
          message: {
            id: item.messageId,
            from: item.senderId || 'user',
            type: item.sourceKind === 'voice' ? '语音转写' : '检索消息',
            datetime: new Date(item.timestamp).toLocaleString('zh-CN', { hour12: false }),
            content: item.text,
            isSender: item.sender === '我',
            name: item.sender,
            senderId: item.senderId,
            createTime: Math.floor(item.timestamp / 1000)
          }
        }
      })
      setSearchTrace({
        knowledgeMessages: searchResult.knowledge.indexedMessageCount,
        retrievedEvidence: searchResult.candidateEvidenceCount,
        finalEvidence: evidenceItems.length,
        timings: searchResult.timings,
        contextEvidence: searchResult.contextEvidenceCount,
        inputTokens: searchResult.ai?.inputTokens,
        inputTokensEstimated: searchResult.ai?.inputTokensEstimated || false,
        aggregation: searchResult.aggregation,
        invalidCitationIds: searchResult.citationValidation?.invalidCitationIds || [],
        agent: searchResult.agent,
        voiceCoverage: searchResult.knowledge.voiceCoverage
      })
      setAgentTrace(searchResult.agent.trace)
      setEvidence(evidenceItems)
      setSenderNames(
        Object.fromEntries(
          evidenceItems
            .filter(({ message }) => Boolean(message.senderId && message.name))
            .map(({ message }) => [message.senderId as string, message.name as string])
        )
      )
      setMessageCount(searchResult.knowledge.totalMessages)
      if (searchResult.status === 'no_evidence') {
        setAnalysisError(`${RANGE_LABELS[effectiveRange]}内没有找到与问题相关的聊天消息。`)
        setStage('insufficient')
        return
      }
      if (searchResult.status === 'retrieval_incomplete') {
        setAnalysisError(searchResult.error || '当前检索未完整覆盖聊天记录，未生成总结。')
        setStage('partial')
        return
      }
      if (searchResult.status === 'failed') {
        setAnalysisError(searchResult.error || '本地搜索暂时无法完成')
        setStage('insufficient')
        return
      }
      if (searchResult.status === 'ai_failed') {
        setAnalysisError(searchResult.error || '证据已找到，但 AI 暂时无法生成回答')
        setStage('partial')
        return
      }
      if (!searchResult.answer) throw new Error('搜索任务未返回回答')
      setResultQuery(normalizedQuery)
      setAnswer(searchResult.answer)
      rememberQuery(normalizedQuery)
      const cacheRecord: AISearchCacheRecord = {
        version: 3,
        key: cacheKey,
        createdAt: currentTimestamp(),
        answer: searchResult.answer,
        evidence: evidenceItems.map(compactCacheItem),
        senderNames: Object.fromEntries(
          evidenceItems
            .filter(({ message }) => Boolean(message.senderId && message.name))
            .map(({ message }) => [message.senderId as string, message.name as string])
        ),
        messageCount: searchResult.knowledge.totalMessages
      }
      writeSearchCache(cacheRecord)
      try {
        sessionStorage.setItem(SEARCH_ACTIVE_RESULT_KEY, cacheRecord.key)
      } catch {
        // Result restoration is optional and must not block search.
      }
      setStage('result')
    } catch (error) {
      if (requestId && searchRequestIdRef.current !== requestId) return
      const errorMessage = error instanceof Error ? error.message : '读取聊天记录失败'
      addDebugEntry('检索失败', { error: errorMessage })
      setAnalysisError(errorMessage)
      setStage('insufficient')
    } finally {
      if (requestId && searchRequestIdRef.current === requestId) searchRequestIdRef.current = ''
    }
  }

  const copyAnswer = async (): Promise<void> => {
    if (!answer) return
    const result = await window.api.copyText(markdownToPlainText(answer))
    onNotice(result.success ? 'AI 摘要已复制' : result.error || '复制失败')
  }

  const startNewQuestion = (): void => {
    bypassCacheRef.current = false
    setQuery('')
    setResultQuery('')
    setStage('idle')
    setAnswer('')
    setEvidence([])
    setSelectedEvidence(0)
    setAnalysisError('')
    setCachedAt(0)
    setSearchTrace(null)
    setSearchProgress({})
    setAgentTrace([])
    setSearchDetailsOpen(false)
    try {
      sessionStorage.removeItem(SEARCH_ACTIVE_RESULT_KEY)
    } catch {
      // Session restoration is optional and must not block a fresh question.
    }
    composerRef.current?.focus()
  }

  const renderIdle = (): React.ReactElement => (
    <div className="ai-search-empty">
      <div className="ai-search-empty-mark" aria-hidden>
        <span>✦</span>
      </div>
      <span className="ai-search-kicker">LOCAL AI WORKSPACE</span>
      <h2>把聊天记录变成可追问的答案</h2>
      <p>聊天数据在本机检索并保留证据；使用外部 AI 服务前会说明并请求确认发送范围。</p>
      <div className="ai-search-prompts">
        {[
          '交友群"张三"最近聊了什么?',
          '工作群"李四"今天发布了什么任务?',
          '我和"老李"最近聊了什么话题?',
          '全局搜一下 我和谁聊过 去健身?'
        ].map((prompt) => (
          <button key={prompt} type="button" onClick={() => setQuery(prompt)}>
            {prompt}
          </button>
        ))}
      </div>
    </div>
  )

  const renderLoading = (): React.ReactElement => {
    const plan = searchProgress.search_plan_ready?.plan || searchProgress.query_understanding?.plan
    const understanding = searchProgress.search_plan_ready || searchProgress.query_understanding
    const knowledge = searchProgress.knowledge_searching
    const evidenceProgress = searchProgress.evidence_ready || searchProgress.evidence_ranking
    const aggregation = searchProgress.aggregation
    const ai = searchProgress.ai_generating
    const stepClass = (progress?: AiSearchProgressEvent): string =>
      progress?.status === 'completed'
        ? 'done'
        : progress?.status === 'error'
          ? 'error'
          : progress
            ? 'active'
            : ''
    const mark = (progress?: AiSearchProgressEvent): string =>
      progress?.status === 'completed'
        ? '✓'
        : progress?.status === 'error'
          ? '!'
          : progress
            ? '◉'
            : '○'
    return (
      <div className="ai-search-loading">
        <span className="ai-search-kicker">本地检索进行中</span>
        <h2>{ai?.status === 'running' ? '正在生成带来源的回答' : '正在理解并查找相关消息'}</h2>
        <p>
          范围：{plan?.scopeLabel || sourceLabel} · {plan?.rangeLabel || RANGE_LABELS[range]}
        </p>
        <div className="ai-search-pipeline" aria-label="本次检索过程">
          <section className={`ai-search-pipeline-step ${stepClass(understanding)}`}>
            <span className="ai-search-pipeline-mark">{mark(understanding)}</span>
            <div>
              <strong>理解搜索条件</strong>
              {understanding?.status === 'running' && <p>{understanding.message}</p>}
              {plan && (
                <div className="ai-search-pipeline-details">
                  {plan.keywords.length > 0 && <span>关键词「{plan.keywords.join('、')}」</span>}
                  <span>时间「{plan.rangeLabel}」</span>
                  <span>范围「{plan.scopeLabel}」</span>
                  {plan.contactNames.map((name) => (
                    <span key={name}>联系人「{name}」</span>
                  ))}
                  <span>目标「{aiSearchIntentLabel(plan.intent)}」</span>
                </div>
              )}
            </div>
          </section>
          {agentTrace.length > 0 && (
            <section className="ai-search-pipeline-step done">
              <span className="ai-search-pipeline-mark">✓</span>
              <div>
                <strong>本地检索策略</strong>
                {agentTrace
                  .filter((item) => item.event === 'toolCallEnd' || item.event === 'agentDecision')
                  .slice(-3)
                  .map((item) => (
                    <p key={item.sequence}>
                      {item.toolName ? `${item.toolName} · ` : ''}
                      {item.label}
                      {item.resultCount !== undefined ? ` · ${item.resultCount} 条` : ''}
                    </p>
                  ))}
              </div>
            </section>
          )}
          <section className={`ai-search-pipeline-step ${stepClass(knowledge)}`}>
            <span className="ai-search-pipeline-mark">{mark(knowledge)}</span>
            <div>
              <strong>从本地知识库查找</strong>
              {knowledge && <p>{knowledge.message}</p>}
              {knowledge?.stats?.knowledgeMessageCount !== undefined && (
                <div className="ai-search-pipeline-details">
                  <span>
                    知识库已收录 {knowledge.stats.knowledgeMessageCount.toLocaleString()} 条消息
                  </span>
                  {knowledge.stats.matchedMessages !== undefined && (
                    <span>找到 {knowledge.stats.matchedMessages.toLocaleString()} 条相关消息</span>
                  )}
                </div>
              )}
            </div>
          </section>
          <section className={`ai-search-pipeline-step ${stepClass(evidenceProgress)}`}>
            <span className="ai-search-pipeline-mark">{mark(evidenceProgress)}</span>
            <div>
              <strong>整理原始证据</strong>
              {evidenceProgress && <p>{evidenceProgress.message}</p>}
              {evidenceProgress?.stats?.matchedMessages !== undefined && (
                <div className="ai-search-pipeline-details">
                  <span>相关消息 {evidenceProgress.stats.matchedMessages.toLocaleString()} 条</span>
                  {evidenceProgress.stats.evidenceCount !== undefined && (
                    <span>保留 {evidenceProgress.stats.evidenceCount} 条 Evidence</span>
                  )}
                </div>
              )}
            </div>
          </section>
          <section className={`ai-search-pipeline-step ${stepClass(aggregation)}`}>
            <span className="ai-search-pipeline-mark">{mark(aggregation)}</span>
            <div>
              <strong>按人物和会话整理</strong>
              {aggregation && <p>{aggregation.message}</p>}
              {aggregation?.stats?.peopleCount !== undefined && (
                <div className="ai-search-pipeline-details">
                  <span>{aggregation.stats.peopleCount} 人</span>
                  {aggregation.stats.conversationCount !== undefined && (
                    <span>{aggregation.stats.conversationCount} 个会话</span>
                  )}
                </div>
              )}
            </div>
          </section>
          <section className={`ai-search-pipeline-step ${stepClass(ai)}`}>
            <span className="ai-search-pipeline-mark">{mark(ai)}</span>
            <div>
              <strong>生成带来源的回答</strong>
              {ai && (
                <p>
                  {ai.message}
                  {ai.modelName ? ` · ${ai.modelName}` : ''}
                </p>
              )}
              {ai?.stats?.contextEvidenceCount !== undefined && (
                <div className="ai-search-pipeline-details">
                  <span>已提供 {ai.stats.contextEvidenceCount} 条相关消息</span>
                  {ai.stats.tokenEstimate !== undefined && (
                    <span>上下文约 {ai.stats.tokenEstimate.toLocaleString()} Tokens</span>
                  )}
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    )
  }

  const renderSearchDetails = (): React.ReactElement | null => {
    const plan = searchProgress.completed?.plan || searchProgress.search_plan_ready?.plan
    if (!plan || !searchTrace) return null
    const ai = searchProgress.completed || searchProgress.ai_generating
    return (
      <details
        className="ai-search-details"
        open={searchDetailsOpen}
        onToggle={(event) => setSearchDetailsOpen(event.currentTarget.open)}
      >
        <summary>查看检索详情</summary>
        <div className="ai-search-details-grid">
          <section>
            <strong>搜索条件</strong>
            <span>关键词：{plan.keywords.join('、') || '未识别到明确关键词'}</span>
            <span>时间范围：{plan.rangeLabel}</span>
            <span>搜索范围：{plan.scopeLabel}</span>
            <span>查询意图：{aiSearchIntentLabel(plan.intent)}</span>
          </section>
          <section>
            <strong>本地知识库</strong>
            <span>已收录消息：{searchTrace.knowledgeMessages.toLocaleString()}</span>
            <span>候选消息：{searchTrace.retrievedEvidence.toLocaleString()}</span>
            <span>Final Evidence：{searchTrace.finalEvidence}</span>
            {searchTrace.voiceCoverage && !searchTrace.voiceCoverage.voiceCoverageComplete && (
              <span className="ai-search-voice-coverage-warning">
                当前范围存在{' '}
                {Math.max(
                  0,
                  searchTrace.voiceCoverage.voiceMessageCount -
                    searchTrace.voiceCoverage.transcribedVoiceCount
                )}{' '}
                条未转写语音，回答可能未覆盖这些内容。
              </span>
            )}
            <span>本地知识库：{formatDuration(searchTrace.timings.knowledgeSearchMs)}</span>
            <span>
              Worker：排队 {formatMeasuredDuration(searchTrace.timings.workerQueueMs)} · 执行{' '}
              {formatMeasuredDuration(searchTrace.timings.workerExecutionMs)} · 全库统计{' '}
              {formatMeasuredDuration(searchTrace.timings.globalCountMs)} · 语音统计{' '}
              {formatMeasuredDuration(searchTrace.timings.voiceCoverageMs)}
            </span>
            <span>
              SQLite：FTS {formatDuration(searchTrace.timings.ftsMs)} · 消息读取{' '}
              {formatDuration(searchTrace.timings.messageLoadMs)}
            </span>
            <span>
              Sender：{formatMeasuredDuration(searchTrace.timings.senderEnrichmentMs)} · WCDB 排队{' '}
              {formatMeasuredDuration(searchTrace.timings.wcdbQueueMs)} · WCDB 执行{' '}
              {formatMeasuredDuration(searchTrace.timings.wcdbExecutionMs)}
            </span>
            <span>
              IPC：{formatMeasuredDuration(searchTrace.timings.ipcMs)} · 序列化{' '}
              {formatMeasuredDuration(searchTrace.timings.serializationMs)} · Other{' '}
              {formatMeasuredDuration(searchTrace.timings.otherMs)}
            </span>
          </section>
          <section>
            <strong>AI 回答</strong>
            <span>上下文消息：{searchTrace.contextEvidence}</span>
            <span>
              输入：{(searchTrace.inputTokens || 0).toLocaleString()} Tokens
              {searchTrace.inputTokensEstimated ? '（估算）' : ''}
            </span>
            {ai?.modelName && <span>模型：{ai.modelName}</span>}
            <span>AI 生成：{formatDuration(searchTrace.timings.aiGenerationMs)}</span>
            {searchTrace.invalidCitationIds.length > 0 && (
              <span>已移除无效引用：{searchTrace.invalidCitationIds.join('、')}</span>
            )}
          </section>
          <section>
            <strong>处理过程</strong>
            <span>
              受控检索：
              {searchTrace.agent.mode === 'agent'
                ? `${searchTrace.agent.toolCalls} 次 Tool`
                : '已使用旧检索 fallback'}
            </span>
            <span>理解问题：{formatDuration(searchTrace.timings.queryUnderstandingMs)}</span>
            <span>确认范围：{formatDuration(searchTrace.timings.contactResolutionMs)}</span>
            <span>
              Evidence 整理：
              {formatDuration(
                searchTrace.timings.candidateRankingMs + searchTrace.timings.evidenceBuildMs
              )}
            </span>
            <span>
              人物聚合：{searchTrace.aggregation.peopleCount} 人 ·{' '}
              {searchTrace.aggregation.conversationCount} 个会话 ·{' '}
              {formatDuration(searchTrace.timings.aggregationMs)}
            </span>
            <span>总耗时：{formatDuration(searchTrace.timings.totalMs)}</span>
          </section>
          {searchTrace.agent.trace.length > 0 && (
            <section className="ai-search-details-trace">
              <strong>检索轨迹</strong>
              {searchTrace.agent.trace.map((item) => (
                <span key={item.sequence}>
                  {item.toolName ? `${item.toolName}：` : ''}
                  {item.label}
                  {item.resultCount !== undefined ? ` · ${item.resultCount} 条` : ''}
                  {item.uniqueCandidateCount !== undefined
                    ? ` · 唯一 ${item.uniqueCandidateCount}`
                    : ''}
                  {item.newCandidateCount !== undefined
                    ? ` · 新候选 ${item.newCandidateCount}`
                    : ''}
                  {item.newEvidenceCount !== undefined
                    ? ` · 新 Evidence ${item.newEvidenceCount}`
                    : ''}
                  {item.newConversationCount !== undefined
                    ? ` · 新会话 ${item.newConversationCount}`
                    : ''}
                  {item.newSenderCount !== undefined ? ` · 新 sender ${item.newSenderCount}` : ''}
                  {item.queryFingerprint ? ` · fp ${item.queryFingerprint}` : ''}
                  {item.hasMore !== undefined ? ` · hasMore ${item.hasMore ? '是' : '否'}` : ''}
                  {item.elapsedMs !== undefined ? ` · ${formatDuration(item.elapsedMs)}` : ''}
                </span>
              ))}
            </section>
          )}
        </div>
      </details>
    )
  }

  const renderResult = (): React.ReactElement => (
    <div className="ai-search-result">
      <div className="ai-search-result-header">
        <div>
          <span className="ai-search-kicker">✓ 已完成</span>
          <h2>{resultQuery || query}</h2>
          <p>
            知识库已收录 {messageCount.toLocaleString()} 条消息 → 找到{' '}
            {searchTrace?.retrievedEvidence || 0} 条相关消息 → {evidence.length} 条 Evidence →
            已生成回答{cachedAt ? ' · 已使用缓存' : ''}
          </p>
          {searchTrace && (
            <div className="ai-search-trace" aria-label="本次检索追踪">
              <span>总耗时 {formatDuration(searchTrace.timings.totalMs)}</span>
              <span>本地检索 {formatDuration(searchTrace.timings.knowledgeSearchMs)}</span>
              <span>AI {formatDuration(searchTrace.timings.aiGenerationMs)}</span>
              <span>上下文 {searchTrace.contextEvidence} 条</span>
            </div>
          )}
          {renderSearchDetails()}
        </div>
        <div className="ai-search-result-actions">
          <button type="button" onClick={startNewQuestion} title="清空当前结果并提出新问题">
            新问题
          </button>
          <button type="button" onClick={() => void copyAnswer()} title="复制 AI 摘要">
            复制摘要
          </button>
          <button
            type="button"
            onClick={() => {
              bypassCacheRef.current = true
              void runAnalysis()
            }}
            title="跳过缓存并重新读取聊天记录"
          >
            刷新数据
          </button>
        </div>
      </div>
      <section className="ai-search-summary-block">
        <div className="ai-search-section-heading">
          <span />
          摘要
        </div>
        <div className="ai-search-answer">
          {renderMarkdown(answer, {
            evidenceCount: evidence.length,
            onEvidenceClick: focusEvidence
          })}
        </div>
        {evidence.length > 0 && (
          <div className="ai-search-answer-evidence" aria-label="AI 引用证据">
            <span>引用：</span>
            {evidence.map((_, index) => (
              <button key={index} type="button" onClick={() => focusEvidence(index)}>
                E{index + 1}
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  )

  const renderInsufficient = (): React.ReactElement => (
    <div className="ai-search-insufficient">
      <div className="ai-search-insufficient-icon">!</div>
      <span className="ai-search-kicker">检索反馈</span>
      <h2>{analysisError || '当前范围没有足够证据'}</h2>
      <p>可以扩大时间范围、切换群聊，或换一个更具体的问题。</p>
      <button
        type="button"
        className="primary"
        onClick={() => {
          const expandToAll = range === '30d' || range === 'all'
          setRange(expandToAll ? 'all' : '30d')
          setTimeRangeOverride(
            expandToAll
              ? {
                  label: '全部历史',
                  reason: '用户主动扩大到全部历史',
                  source: 'user_retry'
                }
              : undefined
          )
          bypassCacheRef.current = true
          void runAnalysis(undefined, {
            range: expandToAll ? 'all' : '30d',
            timeRangeOverride: expandToAll
              ? {
                  label: '全部历史',
                  reason: '用户主动扩大到全部历史',
                  source: 'user_retry'
                }
              : undefined
          })
        }}
      >
        {range === '30d' || range === 'all' ? '搜索全部历史' : '扩大到近 30 天'}
      </button>
    </div>
  )

  const renderPartial = (): React.ReactElement => (
    <div className="ai-search-insufficient ai-search-partial">
      <div className="ai-search-insufficient-icon">!</div>
      <span className="ai-search-kicker">证据已就绪</span>
      <h2>证据已找到，但 AI 暂时无法生成回答</h2>
      <p>{analysisError}。右侧仍可查看并跳转到本次找到的原始消息。</p>
      {renderSearchDetails()}
    </div>
  )

  return (
    <div className="ai-search-workspace">
      <header className="ai-search-header">
        <div>
          <span className="ai-search-kicker">TraceMemo · LOCAL INTELLIGENCE</span>
          <h1>问问你的微信</h1>
          <p>在本地聊天记录中提炼主题、结论和可追溯证据</p>
        </div>
        <div className="ai-search-header-actions">
          <div className="ai-search-knowledge-pill">
            <span className="ai-search-knowledge-dot" aria-hidden />
            Knowledge {knowledgeStateLabel(knowledgeStatus)}
          </div>
          <div className="ai-search-model-status">
            <span className={aiModelConfig.configured ? 'ready' : 'warning'} />
            <span>{modelLabel}</span>
            {!aiModelConfig.configured && (
              <button type="button" onClick={onOpenAISettings}>
                配置模型
              </button>
            )}
          </div>
          {debugEnabled && (
            <button
              type="button"
              className={`ai-search-debug-button ${debugPanelOpen ? 'active' : ''}`}
              onClick={() => setDebugPanelOpen((open) => !open)}
              title="查看本次检索诊断信息"
            >
              诊断日志
            </button>
          )}
        </div>
      </header>
      {debugEnabled && debugPanelOpen && (
        <section className="ai-search-debug-panel">
          <div className="ai-search-debug-header">
            <div>
              <strong>检索诊断</strong>
              <span>
                {debugEnabled ? '已写入应用日志' : '仅显示本次会话，设置中可开启持久化日志'}
              </span>
            </div>
            <div className="ai-search-debug-actions">
              <button type="button" onClick={() => setDebugEntries([])}>
                清空
              </button>
              <button type="button" onClick={() => void window.api.revealAppLog()}>
                打开日志文件夹
              </button>
            </div>
          </div>
          {appLogPath && <small className="ai-search-debug-path">{appLogPath}</small>}
          <pre>{debugEntries.length ? debugEntries.join('\n') : '等待下一次检索操作...'}</pre>
        </section>
      )}
      <div className="ai-search-grid">
        <aside className="ai-search-scope-panel">
          <section className="ai-search-filter-section">
            <span className="ai-search-field-label">搜索范围</span>
            <div className="ai-search-secondary-menu">
              {[
                ['global', '所有聊天记录'],
                ['groups', '群聊专属'],
                ['contacts', '单聊专属']
              ].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={scope === value ? 'active' : ''}
                  onClick={() => setScope(value as SearchScope)}
                >
                  <span aria-hidden>
                    {value === 'global' ? '▣' : value === 'groups' ? '♧' : '♙'}
                  </span>
                  {label}
                </button>
              ))}
              <button
                type="button"
                className={scope === 'conversation' ? 'active' : ''}
                disabled={!activeContact}
                onClick={() => {
                  if (!activeContact) {
                    onNotice('请先在档案中选择一个会话')
                    return
                  }
                  setScope('conversation')
                  setScopeContactMd5(activeContact.md5)
                  onSelectContact(activeContact)
                }}
              >
                <span aria-hidden>⌁</span>
                当前会话{activeContact ? ` · ${contactLabel(activeContact)}` : ''}
              </button>
            </div>
          </section>

          <section className="ai-search-filter-section ai-search-time-section">
            <span className="ai-search-field-label">时间范围</span>
            <div className="ai-search-time-menu">
              {(Object.keys(RANGE_LABELS) as SearchRange[]).map((item) => (
                <button
                  key={item}
                  type="button"
                  className={range === item ? 'active' : ''}
                  aria-pressed={range === item}
                  onClick={() => {
                    setRange(item)
                    setTimeRangeOverride({
                      startTime: aiSearchRangeStart(item),
                      endTime: undefined,
                      label: RANGE_LABELS[item],
                      reason: '用户在界面选择的时间范围',
                      source: 'user_selected'
                    })
                  }}
                >
                  <span aria-hidden>{item === 'all' ? '▣' : item === 'today' ? '▤' : '◷'}</span>
                  {item === 'all' ? '不限时间' : RANGE_LABELS[item]}
                </button>
              ))}
            </div>
          </section>

          <section
            className={`ai-search-knowledge-card ${knowledgeStatus?.state || 'unavailable'}`}
            aria-label="知识库同步状态"
          >
            <div className="ai-search-knowledge-card-heading">
              <div>
                <span>KNOWLEDGE BASE</span>
                <strong>{knowledgeStateLabel(knowledgeStatus)}</strong>
              </div>
              <span className="ai-search-knowledge-dot" aria-hidden />
            </div>
            <p className="ai-search-knowledge-description">
              {knowledgeStatus?.state === 'unavailable'
                ? '知识库不会自动建立，只有点击下方按钮后才会在后台同步。'
                : '后台增量同步不会影响原始微信聊天记录。'}
            </p>
            {(knowledgeStatus?.state === 'building' || knowledgeStatus?.state === 'syncing') && (
              <div className="ai-search-sync-progress">
                <div className="ai-search-sync-progress-top">
                  <span>
                    已处理 {knowledgeStatus.processedMessages.toLocaleString()} 条
                    {knowledgeStatus.totalMessages
                      ? ` / ${knowledgeStatus.totalMessages.toLocaleString()}`
                      : ''}
                  </span>
                  <span>
                    {knowledgeStatus.totalMessages
                      ? `${Math.min(100, Math.round((knowledgeStatus.processedMessages / knowledgeStatus.totalMessages) * 100))}%`
                      : '统计中'}
                  </span>
                </div>
                <div className="ai-search-sync-progress-track">
                  <span
                    style={{
                      width: knowledgeStatus.totalMessages
                        ? `${Math.min(100, (knowledgeStatus.processedMessages / knowledgeStatus.totalMessages) * 100)}%`
                        : '35%'
                    }}
                  />
                </div>
              </div>
            )}
            <div className="ai-search-knowledge-details">
              <div>
                <span>已索引消息</span>
                <strong>{(knowledgeStatus?.indexedMessageCount || 0).toLocaleString()}</strong>
              </div>
              <div>
                <span>知识片段</span>
                <strong>{(knowledgeStatus?.indexedChunkCount || 0).toLocaleString()}</strong>
              </div>
              <div>
                <span>磁盘占用</span>
                <strong>
                  {formatBytes(
                    (knowledgeStatus?.databaseBytes || 0) +
                      (knowledgeStatus?.walBytes || 0) +
                      (knowledgeStatus?.shmBytes || 0)
                  )}
                </strong>
              </div>
              {knowledgeStatus?.currentConversationId &&
                (knowledgeStatus.state === 'building' || knowledgeStatus.state === 'syncing') && (
                  <div>
                    <span>当前会话</span>
                    <strong>
                      {currentSyncConversation === '未选择会话'
                        ? '正在切换会话'
                        : currentSyncConversation}
                    </strong>
                  </div>
                )}
            </div>
            {knowledgeStatus?.state === 'error' && (
              <p className="ai-search-knowledge-error">
                {knowledgeStatus.lastError || '同步异常，旧搜索仍可使用。'}
              </p>
            )}
            <button
              type="button"
              className="ai-search-knowledge-action"
              disabled={
                syncStarting ||
                knowledgeStatus?.state === 'building' ||
                knowledgeStatus?.state === 'syncing'
              }
              onClick={() => void startKnowledgeSync()}
            >
              {syncStarting ||
              knowledgeStatus?.state === 'building' ||
              knowledgeStatus?.state === 'syncing'
                ? '同步中…'
                : knowledgeStatus?.state === 'ready'
                  ? '同步最新记录'
                  : '建立本地知识库'}
            </button>
            <details className="ai-search-knowledge-more">
              <summary>同步详情</summary>
              <p>
                账号：
                {knowledgeStatus?.accountId
                  ? `${knowledgeStatus.accountId.slice(0, 12)}…`
                  : '未连接'}
              </p>
              <p>状态：{knowledgeStateLabel(knowledgeStatus)}</p>
              <p>索引独立保存，不会删除或修改微信原始数据库。</p>
            </details>
          </section>
        </aside>
        <main className="ai-search-main">
          <div className="ai-search-main-scroll">
            {stage === 'idle' && renderIdle()}
            {stage === 'loading' && renderLoading()}
            {stage === 'result' && renderResult()}
            {stage === 'partial' && renderPartial()}
            {stage === 'insufficient' && renderInsufficient()}
          </div>
          <form className="ai-search-composer" onSubmit={(event) => void runAnalysis(event)}>
            <div className="ai-search-composer-meta">
              <span>正在询问</span>
              <strong>{sourceLabel}</strong>
              <em>{RANGE_LABELS[range]}</em>
              <Popover.Root open={historyOpen} onOpenChange={setHistoryOpen}>
                <Popover.Trigger asChild>
                  <button type="button" className="ai-search-history-trigger">
                    历史提问{history.length ? ` · ${history.length}` : ''}
                  </button>
                </Popover.Trigger>
                <Popover.Portal>
                  <Popover.Content
                    className="ai-search-history-popover"
                    aria-label="历史提问"
                    side="top"
                    align="end"
                    sideOffset={8}
                    collisionPadding={16}
                  >
                    <div className="ai-search-history-popover-heading">
                      <strong>历史提问</strong>
                      <Popover.Close asChild>
                        <button type="button" aria-label="关闭历史提问">
                          ×
                        </button>
                      </Popover.Close>
                    </div>
                    {history.length ? (
                      history.map((item) => (
                        <div className="ai-search-history-popover-item" key={item}>
                          <button
                            type="button"
                            onClick={() => restoreHistoryQuery(item)}
                            title={item}
                          >
                            {item}
                          </button>
                          <button
                            type="button"
                            onClick={() => removeHistoryQuery(item)}
                            aria-label={`删除历史问题：${item}`}
                            title="删除这条历史问题"
                          >
                            ×
                          </button>
                        </div>
                      ))
                    ) : (
                      <span className="ai-search-history-empty">还没有历史提问</span>
                    )}
                  </Popover.Content>
                </Popover.Portal>
              </Popover.Root>
            </div>
            <div className="ai-search-composer-row">
              <textarea
                ref={composerRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) {
                    return
                  }
                  event.preventDefault()
                  void runAnalysis()
                }}
                placeholder="例如：技术交流群最近讨论了哪些 Windows 性能问题？"
                rows={2}
              />
              {stage === 'loading' ? (
                <button
                  type="button"
                  className="cancel"
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    void cancelAnalysis()
                  }}
                >
                  取消分析
                  <span>×</span>
                </button>
              ) : (
                <button
                  type="submit"
                  className="primary"
                  disabled={knowledgeSyncing}
                  title={knowledgeSyncing ? '知识库同步完成后才能开始分析' : undefined}
                >
                  {knowledgeSyncing ? '同步中，暂不可分析' : '开始分析'}
                  <span>→</span>
                </button>
              )}
            </div>
            <div className="ai-search-composer-foot">
              <span>Enter 发送 · Shift + Enter 换行</span>
              <span>AI 仅使用当前搜索所需的受控证据</span>
            </div>
          </form>
        </main>
        <aside className="ai-search-evidence-panel">
          <div className="ai-search-panel-heading">
            <div>
              <span>可追溯数据</span>
              <strong>证据与来源</strong>
            </div>
            {evidence.length > 0 && (
              <span className="ai-search-count-badge">{evidence.length} 条样本</span>
            )}
          </div>
          {evidence.length ? (
            evidence.map((item, index) => (
              <article
                key={`${messageIdentity(item.message)}-${index}-${evidenceFlash.index === index ? evidenceFlash.nonce : 0}`}
                ref={(node) => {
                  if (node) evidenceCardRefs.current.set(index, node)
                  else evidenceCardRefs.current.delete(index)
                }}
                className={`ai-search-evidence-card ${selectedEvidence === index ? 'active' : ''} ${evidenceFlash.index === index ? 'focus-flash' : ''}`}
                style={{ animationDelay: `${Math.min(index, 7) * 45}ms` }}
                onClick={() => {
                  focusEvidence(index)
                }}
              >
                <span className="ai-search-evidence-card-top">
                  <strong>
                    {item.evidenceId || `E${index + 1}`} ·{' '}
                    {senderName(item.message, item.contact, senderNames)}
                  </strong>
                  <time>{formatMessageTime(item.message)}</time>
                </span>
                <span className="ai-search-evidence-conversation">{item.contact.m_nsNickName}</span>
                {item.sourceKind === 'voice' && (
                  <span className="ai-search-evidence-source-kind">语音转写</span>
                )}
                <span className="ai-search-evidence-text">{messageText(item.message)}</span>
                <button
                  type="button"
                  className="ai-search-evidence-link"
                  onClick={(event) => {
                    event.stopPropagation()
                    onOpenEvidence(item.contact, item.message.createTime)
                  }}
                >
                  跳转到原聊天 ↗
                </button>
              </article>
            ))
          ) : (
            <div className="ai-search-evidence-empty">
              <div>⌕</div>
              <strong>等待检索结果</strong>
              <span>分析完成后，这里会显示支持结论的原始消息。</span>
            </div>
          )}
        </aside>
      </div>
      {externalProviderConsent && (
        <div
          className="ai-search-consent-backdrop"
          role="presentation"
          onMouseDown={() => settleExternalProviderConsent(false)}
        >
          <section
            className="ai-search-consent-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ai-search-consent-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <span className="ai-search-kicker">AI SEARCH</span>
            <h2 id="ai-search-consent-title">确认发送本次搜索资料</h2>
            <p>
              将向 <strong>{externalProviderConsent.providerName}</strong>（
              {externalProviderConsent.recipient}
              ）发送当前问题、受控检索所需的受限上下文，以及最多 8 条最终 Evidence。
            </p>
            <p className="ai-search-consent-note">
              不会发送完整微信数据库、全量聊天记录、密钥、绝对路径或内部会话/消息引用 ID。
            </p>
            <div className="ai-search-consent-actions">
              <button type="button" onClick={() => settleExternalProviderConsent(false)}>
                取消
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => settleExternalProviderConsent(true)}
              >
                继续并发送
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
