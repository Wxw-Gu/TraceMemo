import React, { useMemo, useRef, useState } from 'react'
import { aiSearchIntentLabel, aiSearchRangeStart } from '../../../../shared/ai-search'
import type {
  AiSearchPipelineResult,
  AiSearchProgressEvent,
  AiSearchTimeRange
} from '../../../../shared/ai-search'

import type {
  AISearchWorkspaceProps,
  SearchRange,
  SearchScope,
  SearchStage,
  SearchTrace
} from './searchTypes'
import { RANGE_LABELS, createSearchRequestContext } from './searchUtils'
import { markdownToPlainText, renderMarkdown } from './searchMarkdown'
import {
  contactLabel,
  formatBytes,
  formatDuration,
  formatIndexDate,
  formatKnowledgeProcessed,
  formatMeasuredDuration,
  formatSearchTraceOverview,
  knowledgeIsStale,
  knowledgeStateLabel
} from './searchFormatters'
import { mapPipelineResultToRendererResult } from './searchMappers'
import { createSearchResultResetState, resolveSearchResultViewTransition } from './searchState'
import { useSearchHistory } from './hooks/useSearchHistory'
import { useKnowledgeStatus } from './hooks/useKnowledgeStatus'
import {
  QUERY_AGENT_PROGRESS_STEPS,
  queryAgentProgressLabel,
  queryAgentProgressStepIndex,
  useQueryAgentProgress
} from './hooks/useQueryAgentProgress'
import { useExternalProviderConsent } from './hooks/useExternalProviderConsent'
import { EVIDENCE_PAGE_SIZE, useEvidenceCollection } from './hooks/useEvidenceCollection'
import { useAiSearchRun } from './hooks/useAiSearchRun'
import { ensureAiSearchDataConsent } from './services/aiSearchProviderConsent'
import { ExternalProviderConsentDialog } from './ExternalProviderConsentDialog'
import { AISearchComposer } from './AISearchComposer'
import { AISearchEvidencePanel } from './AISearchEvidencePanel'
import { ImageTextIndexCard } from './ImageTextIndexCard'
import {
  forgetAskWechatConversation,
  requestAskWechatQuery,
  resolveQueryAgentEnabled
} from './queryAgentBridge'
import {
  askWechatToolLabels,
  formatAskWechatStats,
  mapAskWechatEvidence
} from './askWechatPresentation'
import type { AskWechatScope, AskWechatStats } from '../../../../shared/query-agent'
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui'

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
  const [analysisError, setAnalysisError] = useState('')
  const [messageCount, setMessageCount] = useState(0)
  const [senderNames, setSenderNames] = useState<Record<string, string>>({})
  const [cachedAt, setCachedAt] = useState(0)
  const [searchTrace, setSearchTrace] = useState<SearchTrace | null>(null)
  const [searchDetailsOpen, setSearchDetailsOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [debugEnabled, setDebugEnabled] = useState(false)
  const [debugPanelOpen, setDebugPanelOpen] = useState(false)
  const [debugEntries, setDebugEntries] = useState<string[]>([])
  const [appLogPath, setAppLogPath] = useState('')
  const composerRef = useRef<HTMLTextAreaElement>(null)
  /** Query Agent 主路径的当前请求 id（它不走 useAiSearchRun，需要自己的失效判断）。 */
  const askRequestRef = useRef('')
  /** Query Agent 是否为当前主路径：控制"搜索范围 / 时间范围"的显隐（主路径隐藏时间范围）。 */
  const [queryAgentEnabled, setQueryAgentEnabled] = useState(false)
  /** Query Agent 本次回答的真实统计（读取条数 / 证据条数 / 模型调用 / 耗时）。 */
  const [askStats, setAskStats] = useState<AskWechatStats | null>(null)
  const {
    evidence,
    setEvidence,
    evidenceCollection,
    setEvidenceCollection,
    setVisibleEvidenceCount,
    selectedEvidence,
    setSelectedEvidence,
    visibleEvidence,
    hasMoreEvidence,
    evidenceFlash,
    setEvidenceResult,
    clearEvidenceCollection,
    loadMoreEvidence,
    focusEvidence,
    jumpToEvidence,
    setEvidenceCardRef
  } = useEvidenceCollection({ onOpenEvidence })

  const {
    history,
    rememberQuery,
    restoreHistoryQuery,
    removeHistoryQuery,
    applyCachedResult,
    readCachedResult,
    persistSearchResult,
    clearActiveResult,
    skipNextCache,
    consumeCacheBypass,
    clearCacheBypass
  } = useSearchHistory({
    query,
    scope,
    range,
    conversationContactMd5:
      allContacts.find((contact) => contact.md5 === (scopeContactMd5 || selectedContact?.md5))
        ?.md5 ||
      selectedContact?.md5 ||
      '',
    evidencePageSize: EVIDENCE_PAGE_SIZE,
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
  const {
    knowledgeStatus,
    syncStarting,
    knowledgeSyncing,
    knowledgeSyncingRef,
    cancelRequested,
    startKnowledgeSync,
    cancelKnowledgeSync
  } = useKnowledgeStatus({ dbReady, onNotice })
  const {
    progress: qaProgress,
    begin: beginQueryAgentProgress,
    end: endQueryAgentProgress
  } = useQueryAgentProgress()
  const {
    externalProviderConsent,
    requestExternalProviderConsent,
    settleExternalProviderConsent,
    clearExternalProviderConsent
  } = useExternalProviderConsent()
  const {
    requestId: searchRunRequestId,
    progress: searchProgress,
    agentTrace,
    createRequestId,
    startSearch,
    cancelSearch,
    resetSearchRun
  } = useAiSearchRun({
    onAnswerDelta: (delta) => setAnswer((current) => current + delta)
  })

  const resetSearchResult = (): void => {
    const reset = createSearchResultResetState()
    setAnalysisError(reset.analysisError)
    setAnswer(reset.answer)
    clearEvidenceCollection()
    setCachedAt(reset.cachedAt)
    setSearchTrace(reset.searchTrace)
    setAskStats(null)
    resetSearchRun()
    setSearchDetailsOpen(reset.searchDetailsOpen)
  }

  React.useEffect(() => {
    void Promise.all([window.api.getSettings(), window.api.getAppLogPath()]).then(
      ([settingsResult, logPath]) => {
        setDebugEnabled(settingsResult.settings.debugEnabled)
        setAppLogPath(logPath)
      }
    )
  }, [])

  // 这个开关只影响"界面暴露哪些边界控件"：Query Agent 主路径保留搜索范围、隐藏时间范围。
  React.useEffect(() => {
    let active = true
    void resolveQueryAgentEnabled().then((enabled) => {
      if (active) setQueryAgentEnabled(enabled)
    })
    return () => {
      active = false
    }
  }, [])

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
    contacts: '单聊专属',
    conversation: contactLabel(activeContact)
  }[scope]

  /**
   * UI 搜索范围 → Query Agent 的 conversationScope（WHERE TO SEARCH）。
   *
   * 这是确定性数据边界，与时间（WHEN，由问题的 temporalBasis 理解）完全正交；
   * 结果会由 Engine 结构性强制：越界 target 会被拒绝，模型无法自行扩大范围。
   */
  const currentAskWechatScope = (): AskWechatScope | undefined => {
    if (scope === 'global') return { scope: { kind: 'all' }, label: '所有聊天记录' }
    if (scope === 'groups') return { scope: { kind: 'groups' }, label: '群聊专属' }
    if (scope === 'contacts') {
      const contact = allContacts.find(
        (item) => item.md5 === (scopeContactMd5 || selectedContact?.md5)
      )
      if (!contact) return undefined
      return {
        scope: { kind: 'contact', conversationId: contact.md5 },
        label: `单聊专属：${contactLabel(contact)}`
      }
    }
    if (!activeContact) return undefined
    return {
      scope: { kind: 'current', conversationId: activeContact.md5 },
      label: `当前会话：${contactLabel(activeContact)}`
    }
  }
  const currentSyncConversation = knowledgeStatus?.currentConversationId
    ? contactLabel(
        allContacts.find((contact) => contact.md5 === knowledgeStatus.currentConversationId)
      )
    : ''
  /**
   * Knowledge 卡片的分区可见性。取值口径与改动前**完全一致**（只认 building / syncing），
   * 只是抽成具名变量，避免在 JSX 里重复三元又把 TypeScript 的收窄打断。
   */
  const knowledgeIsRunning =
    knowledgeStatus?.state === 'building' || knowledgeStatus?.state === 'syncing'
  const knowledgeMainLoopLagMs = knowledgeStatus?.pass?.mainLoopLagMs ?? 0
  const knowledgeCurrentConversationName =
    currentSyncConversation === '未选择会话' ? '正在切换会话' : currentSyncConversation
  const modelLabel = aiModelConfig.configured
    ? `${aiModelConfig.providerName} · ${aiModelConfig.modelName}`
    : '尚未配置 AI 模型'
  const cancelAnalysis = async (): Promise<void> => {
    clearExternalProviderConsent()
    const requestId = searchRunRequestId
    const askRequestId = askRequestRef.current
    if (!requestId && !askRequestId) return
    askRequestRef.current = ''
    setStage('idle')
    setAnalysisError('')
    setSearchDetailsOpen(false)
    onNotice('已取消本次分析')
    composerRef.current?.focus()
    try {
      await cancelSearch()
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
    // 索引同步中**不允许**禁止查询：同步是后台的、可取消的、可断点续传的；
    // 索引没追平时按 partial + freshness warning 如实作答（覆盖范围由主进程的
    // coverage/freshness 契约给出），绝不把用户挡在门外。
    const {
      normalizedQuery,
      effectiveRange,
      effectiveTimeRangeOverride,
      conversationId,
      cacheKey
    } = createSearchRequestContext({
      query,
      scope,
      range,
      timeRangeOverride,
      activeContactMd5: activeContact?.md5,
      knowledgeGeneration: knowledgeStatus
        ? `${knowledgeStatus.state}:${knowledgeStatus.indexedMessageCount}:${knowledgeStatus.indexedChunkCount}:${knowledgeStatus.processedMessages}`
        : undefined,
      retry
    })
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
    // Legacy AI Search 结果的统一落地（Query Agent 的 Legacy fallback 也走这里，保证展示路径只有一条）。
    const applyPipelineResult = (
      searchResult: AiSearchPipelineResult,
      appliedRange: SearchRange
    ): void => {
      addDebugEntry('主进程搜索任务完成', {
        status: searchResult.status,
        candidateEvidenceCount: searchResult.candidateEvidenceCount,
        finalEvidenceCount: searchResult.evidence.length,
        elapsedMs: searchResult.elapsedMs,
        errorStage: searchResult.errorStage
      })
      const mappedResult = mapPipelineResultToRendererResult(searchResult, allContacts)
      setSearchTrace(mappedResult.searchTrace)
      setEvidenceResult(mappedResult.evidence, mappedResult.evidenceCollection)
      setSenderNames(mappedResult.senderNames)
      setMessageCount(mappedResult.messageCount)
      const viewTransition = resolveSearchResultViewTransition(searchResult, appliedRange)
      if (viewTransition.stage !== 'result') {
        setAnalysisError(viewTransition.analysisError)
        setStage(viewTransition.stage)
        return
      }
      if (!viewTransition.answer) throw new Error('搜索任务未返回回答')
      setResultQuery(normalizedQuery)
      setAnswer(viewTransition.answer)
      rememberQuery(normalizedQuery)
      persistSearchResult({
        key: cacheKey,
        answer: viewTransition.answer,
        evidence: mappedResult.evidence,
        evidenceCollection: mappedResult.evidenceCollection,
        senderNames: mappedResult.senderNames,
        messageCount: mappedResult.messageCount
      })
      setStage('result')
    }
    try {
      const cached = consumeCacheBypass() ? null : readCachedResult(cacheKey)
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
      const requestId = createRequestId()
      try {
        if (
          !(await ensureAiSearchDataConsent({
            requestId,
            api: window.api,
            requestExternalProviderConsent
          }))
        ) {
          onNotice('已取消本次 AI Search，未执行检索，也未向远程 AI 服务发送聊天内容')
          return
        }
      } catch {
        onNotice('无法确认 AI 服务的数据发送授权，本次检索未执行')
        return
      }
      // 索引正在追新：降级成提示而不是阻断。用户问的是"最近谁聊过 X"，
      // 拿一份明确标注覆盖范围的 partial 结果，永远好过一句"请等同步完成"。
      if (knowledgeSyncingRef.current) {
        onNotice('知识库正在后台同步，本次结果可能未覆盖最新消息')
      }
      setStage('loading')
      resetSearchResult()
      if (await resolveQueryAgentEnabled()) {
        // Query Agent 主路径：查询大脑换成 QueryAgentService（与微信 Agent Hub 同一实现）。
        // Legacy 只在 Runtime 不可恢复错误时由主进程回退，并以 engine='legacy' 返回 legacy 结果。
        setQueryAgentEnabled(true)
        askRequestRef.current = requestId
        // 订阅**本次** requestId 的真实进度；`finally` 里一定退订，
        // 否则下一次查询会被上一次的残留阶段污染成"假进度"。
        beginQueryAgentProgress(requestId)
        const askResult = await requestAskWechatQuery({
          requestId,
          text: normalizedQuery,
          // 搜索范围是 UI 决定的数据边界；时间不在 UI 上（写进问题，由 temporalBasis 理解）。
          scope: currentAskWechatScope(),
          legacy: {
            scope,
            range: effectiveRange,
            conversationId,
            timeRangeOverride: effectiveTimeRangeOverride
          }
        }).finally(() => endQueryAgentProgress())
        // 桥缺失（旧 preload / 测试环境）时不算 Query Agent 失败，直接走下面的 Legacy 路径。
        if (!askResult) {
          askRequestRef.current = ''
        } else if (askRequestRef.current !== requestId) {
          return
        } else {
          askRequestRef.current = ''
          if (askResult.engine === 'legacy') {
            applyPipelineResult(askResult.result, effectiveRange)
            return
          }
          if (askResult.status === 'answered') {
            const mappedEvidence = mapAskWechatEvidence(askResult.evidence)
            addDebugEntry('查询 Agent 完成', { ...askResult.diagnostics })
            setResultQuery(normalizedQuery)
            setAnswer(askResult.answer)
            // 真实证据直接来自 Runtime 收集的 Tool 结果，不从回答文本反解析。
            setEvidenceResult(mappedEvidence, mappedEvidence)
            setAskStats(askResult.stats)
            setMessageCount(0)
            rememberQuery(normalizedQuery)
            persistSearchResult({
              key: cacheKey,
              answer: askResult.answer,
              evidence: mappedEvidence,
              evidenceCollection: mappedEvidence,
              senderNames: {},
              messageCount: 0
            })
            setStage('result')
            return
          }
          // Provider 不可用 / Runtime 失败且无法回退：给出明确文案，不静默回退成另一次搜索。
          const failureMessage =
            askResult.status === 'provider_unavailable' || askResult.status === 'error'
              ? askResult.message
              : '本次查询没有完成，请稍后再试。'
          setAskStats(null)
          addDebugEntry('查询失败', { ...askResult.diagnostics })
          setAnalysisError(failureMessage)
          setStage('insufficient')
          return
        }
      }
      const outcome = await startSearch({
        requestId,
        text: normalizedQuery,
        scope,
        range: effectiveRange,
        conversationId,
        timeRangeOverride: effectiveTimeRangeOverride
      })
      if (outcome.kind === 'stale') return
      if (outcome.kind === 'cancelled') {
        onNotice('已取消本次分析')
        setStage('idle')
        return
      }
      if (outcome.kind === 'failed') {
        addDebugEntry('检索失败', { error: outcome.error })
        setAnalysisError(outcome.error)
        setStage('insufficient')
        return
      }
      applyPipelineResult(outcome.result, effectiveRange)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '读取聊天记录失败'
      addDebugEntry('检索失败', { error: errorMessage })
      setAnalysisError(errorMessage)
      setStage('insufficient')
    }
  }

  const copyAnswer = async (): Promise<void> => {
    if (!answer) return
    const result = await window.api.copyText(markdownToPlainText(answer))
    onNotice(result.success ? 'AI 摘要已复制' : result.error || '复制失败')
  }

  const startNewQuestion = (): void => {
    clearCacheBypass()
    askRequestRef.current = ''
    // 新问题 = 新的对话上下文：清掉 Query Agent 的澄清记忆，避免和上一次追问串味。
    forgetAskWechatConversation()
    setQuery('')
    setResultQuery('')
    setStage('idle')
    resetSearchResult()
    clearActiveResult()
    composerRef.current?.focus()
  }

  const renderIdle = (): React.ReactElement => (
    <div className="ai-search-empty">
      <span className="ai-search-kicker">本地搜索</span>
      <h2>把聊天记录变成可追问的答案</h2>
      <p>聊天数据在本机检索并保留证据；使用外部 AI 服务前会说明并请求确认发送范围。</p>
      <span className="ai-search-prompt-label">可以这样问</span>
      <div className="ai-search-prompts">
        {[
          '交友群"张三"最近聊了什么?',
          '工作群"李四"今天发布了什么任务?',
          '我和"老李"最近聊了什么话题?',
          '全局搜一下 我和谁聊过 去健身?'
        ].map((prompt) => (
          <Button
            key={prompt}
            type="button"
            variant="ghost"
            size="sm"
            className="h-auto w-full justify-start rounded-none px-0 py-2.5 text-left font-normal"
            onClick={() => setQuery(prompt)}
          >
            {prompt}
          </Button>
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
    // Query Agent 主路径：不产生 Legacy 的进度事件，也不固定说"从知识库检索"
    // （query_messages 直读微信数据库）。
    // 阶段与文案由**真实 Runtime 生命周期**驱动，不是静态 4 步：
    // 用户能看到"现在卡在哪一步、已经过去多久"。
    if (queryAgentEnabled) {
      const currentStep = queryAgentProgressStepIndex(qaProgress)
      const wideScope = scope === 'global' || scope === 'groups'
      return (
        <div className="ai-search-loading">
          <span className="ai-search-kicker">正在查询本地聊天记录</span>
          <h2>{queryAgentProgressLabel(qaProgress, wideScope)}</h2>
          <p>
            搜索范围：{sourceLabel}
            {qaProgress ? ` · 已用时 ${formatDuration(qaProgress.elapsedMs)}` : ''}
          </p>
          <div className="ai-search-pipeline" aria-label="本次查询过程">
            {QUERY_AGENT_PROGRESS_STEPS.map((step, index) => {
              const state = index < currentStep ? 'done' : index === currentStep ? 'active' : ''
              return (
                <section key={step.stage} className={`ai-search-pipeline-step ${state}`}>
                  <span className="ai-search-pipeline-mark">
                    {index < currentStep ? '✓' : index === currentStep ? '◉' : '○'}
                  </span>
                  <div>
                    <strong>{step.label}</strong>
                    {/* 当前步的副提示：Tool 阶段说明"在搜什么范围"，模型阶段说明在做什么。 */}
                    {index === currentStep && (
                      <span className="block text-[10px] text-muted-foreground">
                        {queryAgentProgressLabel(qaProgress, wideScope)}
                      </span>
                    )}
                  </div>
                </section>
              )
            })}
          </div>
        </div>
      )
    }
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
        {answer && (
          <section
            className="ai-search-summary-block ai-search-streaming-answer"
            aria-label="正在生成的回答"
            aria-live="polite"
          >
            <div className="ai-search-section-heading">
              <span />
              回答生成中
            </div>
            <div className="ai-search-answer">{renderMarkdown(answer)}</div>
          </section>
        )}
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
          {askStats ? (
            <>
              <p>已生成回答</p>
              <div className="ai-search-trace" aria-label="本次查询真实统计">
                {formatAskWechatStats(askStats).map((chip) => (
                  <span key={chip}>{chip}</span>
                ))}
                {askWechatToolLabels(askStats.tools).map((label) => (
                  <span key={label}>能力：{label}</span>
                ))}
              </div>
              {/* 耗时拆解：把总耗时还原成"AI 花了多少 / 本地查询花了多少"。
                  普通 UI 只出现这三个用户能理解的名字，不出现 firstModelMs / toolTotalMs
                  这类工程字段；逐次调用的细节只在 dev 模式展开，供排障用。 */}
              {askStats.timings && (
                <div className="ai-search-trace" aria-label="本次查询耗时拆解">
                  <span data-testid="query-timing-total">
                    总耗时 {formatDuration(askStats.timings.totalMs)}
                  </span>
                  <span data-testid="query-timing-model">
                    AI {formatDuration(askStats.timings.modelMs)}
                  </span>
                  <span data-testid="query-timing-local">
                    本地查询 {formatDuration(askStats.timings.localQueryMs)}
                  </span>
                  {import.meta.env.DEV && (
                    <span data-testid="query-timing-dev-detail">
                      dev 逐次调用：AI [
                      {askStats.timings.modelDurationsMs?.map((v) => Math.round(v)).join(', ') ||
                        '-'}
                      ] ms · 本地 [
                      {askStats.timings.toolDurationsMs?.map((v) => Math.round(v)).join(', ') || '-'}
                      ] ms
                    </span>
                  )}
                </div>
              )}
            </>
          ) : (
            <>
              <p>
                知识库已收录 {messageCount.toLocaleString()} 条消息 →{' '}
                {cachedAt
                  ? `缓存中保留 ${evidenceCollection.length} 条 Evidence`
                  : searchTrace?.retrievedEvidence !== undefined
                    ? `读取 ${searchTrace.retrievedEvidence} 条范围消息`
                    : `读取 ${evidence.length} 条消息`}{' '}
                → {evidence.length} 条 Evidence → 已生成回答{cachedAt ? ' · 已使用缓存' : ''}
              </p>
              {searchTrace &&
                (() => {
                  const overview = formatSearchTraceOverview(searchTrace)
                  return (
                    <div className="ai-search-trace" aria-label="本次检索追踪">
                      <span>总耗时 {overview.totalDuration}</span>
                      <span>本地检索 {overview.knowledgeDuration}</span>
                      <span>AI {overview.aiDuration}</span>
                      <span>上下文 {overview.contextEvidence}</span>
                    </div>
                  )
                })()}
            </>
          )}
          {renderSearchDetails()}
        </div>
        <div className="ai-search-result-actions">
          <Button
            variant="outline"
            size="sm"
            className="px-2"
            onClick={startNewQuestion}
            title="清空当前结果并提出新问题"
          >
            新问题
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="px-2"
            onClick={() => void copyAnswer()}
            title="复制 AI 摘要"
          >
            复制摘要
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="px-2"
            onClick={() => {
              skipNextCache()
              void runAnalysis()
            }}
            title="跳过缓存并重新读取聊天记录"
          >
            刷新数据
          </Button>
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
      {queryAgentEnabled ? (
        <p>可以切换聊天范围，或换一个更具体的问题。</p>
      ) : (
        <>
          <p>可以扩大时间范围、切换群聊，或换一个更具体的问题。</p>
          <Button
            size="sm"
            className="mt-5"
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
              skipNextCache()
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
          </Button>
        </>
      )}
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
          <span className="ai-search-kicker">TraceMemo 本地搜索</span>
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
              <Button variant="link" size="sm" onClick={onOpenAISettings}>
                配置模型
              </Button>
            )}
          </div>
          {debugEnabled && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDebugPanelOpen((open) => !open)}
              title="查看本次检索诊断信息"
              aria-expanded={debugPanelOpen}
              aria-controls="ai-search-debug-panel"
            >
              诊断日志
            </Button>
          )}
        </div>
      </header>
      {debugEnabled && debugPanelOpen && (
        <section id="ai-search-debug-panel" className="ai-search-debug-panel">
          <div className="ai-search-debug-header">
            <div>
              <strong>检索诊断</strong>
              <span>
                {debugEnabled ? '已写入应用日志' : '仅显示本次会话，设置中可开启持久化日志'}
              </span>
            </div>
            <div className="ai-search-debug-actions">
              <Button variant="outline" size="sm" onClick={() => setDebugEntries([])}>
                清空
              </Button>
              <Button variant="outline" size="sm" onClick={() => void window.api.revealAppLog()}>
                打开日志文件夹
              </Button>
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
            {/* 单聊专属需要一个明确的联系人（Legacy 下同样由档案选择决定，这里在 Query Agent 主路径提供显式选择） */}
            {queryAgentEnabled && scope === 'contacts' && (
              <Select
                value={scopeContactMd5 || selectedContact?.md5 || ''}
                onValueChange={(value) => setScopeContactMd5(value)}
              >
                <SelectTrigger aria-label="选择单聊联系人" className="mt-2 w-full">
                  <SelectValue placeholder="选择联系人" />
                </SelectTrigger>
                <SelectContent>
                  {allContacts
                    .filter((contact) => contact.type !== 'group')
                    .map((contact) => (
                      <SelectItem key={contact.md5} value={contact.md5}>
                        {contactLabel(contact)}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            )}
          </section>

          {queryAgentEnabled ? (
            <section className="ai-search-filter-section">
              <span className="ai-search-field-label">时间</span>
              <p className="mt-1 text-[11px] leading-[17px] text-muted-foreground">
                时间直接写在问题里，例如「上个月 BOBO 发过什么文件？」「最近 7 天群里聊了什么？」
              </p>
            </section>
          ) : (
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
          )}

          <section
            className={`ai-search-knowledge-card ${knowledgeStatus?.state || 'unavailable'}`}
            aria-label="知识库同步状态"
          >
            {/* 卡片自上而下固定五段：HEADER → CURRENT PASS → DATABASE STATUS → CURRENT → ACTION。
                每段的「标签 / 数值」行都用同一套栅格（label 可收缩、value 取自然宽且不折断），
                侧栏只有 ~145px 可用宽度，靠栅格而不是靠缩字号来避免挤成一团。 */}
            <div className="ai-search-knowledge-heading">
              <div className="ai-search-knowledge-heading-text">
                <span className="ai-search-knowledge-kicker">KNOWLEDGE BASE</span>
                {/* 折行规则在 CSS 里（word-break: keep-all）：中文不在字与字之间断开，
                    「 · 」两侧的空格仍是断点，所以折成两行时只会断在「可用 · 」之后。 */}
                <strong className="ai-search-knowledge-state" data-testid="knowledge-state-label">
                  {knowledgeStateLabel(knowledgeStatus)}
                </strong>
              </div>
              <span className="ai-search-knowledge-dot" aria-hidden />
            </div>
            <p className="ai-search-knowledge-description">
              {knowledgeStatus?.state === 'unavailable'
                ? '知识库不会自动建立，只有点击下方按钮后才会在后台同步。'
                : knowledgeStatus?.state === 'cancelled'
                  ? '同步已取消。已经建立的索引仍然可用，下次同步会从中断处继续，不会从头重扫。'
                  : knowledgeIsStale(knowledgeStatus) && knowledgeStatus?.indexLatestAt
                    ? `索引还没追上最新聊天：跨会话搜索目前只覆盖到 ${formatIndexDate(knowledgeStatus.indexLatestAt)}，之后的记录需要同步后才可检索。不影响你现在提问，但答案会标注覆盖范围。`
                    : '后台增量同步不会影响原始微信聊天记录，也不会阻塞提问。'}
            </p>
            {/* CURRENT PASS：只有这一遍真的在跑时才出现。 */}
            {knowledgeIsRunning && (
              <div className="ai-search-knowledge-pass">
                <div className="ai-search-knowledge-rows">
                  <div className="ai-search-knowledge-row">
                    <span className="ai-search-knowledge-label">会话进度</span>
                    <strong className="ai-search-knowledge-value">
                      {knowledgeStatus.pass
                        ? `${knowledgeStatus.pass.processedConversations.toLocaleString()} / ${knowledgeStatus.pass.totalConversations.toLocaleString()}`
                        : '准备中'}
                    </strong>
                  </div>
                </div>
                <div className="ai-search-sync-progress-track">
                  <span
                    style={{
                      // 有真实分母时用真实比例；没有分母时不再假装 35% 的"假进度条"，
                      // 改成一条不确定态（UI 上用动画表示"在跑"）。
                      width: knowledgeStatus.pass?.totalConversations
                        ? `${Math.min(
                            100,
                            (knowledgeStatus.pass.processedConversations /
                              knowledgeStatus.pass.totalConversations) *
                              100
                          )}%`
                        : '100%',
                      ...(knowledgeStatus.pass?.totalConversations
                        ? {}
                        : { animation: 'ai-search-indeterminate 1.4s ease-in-out infinite' })
                    }}
                  />
                </div>
                {/* 「已处理 X 条 / 统计中」是**无分母**的伪进度。这里改成两个真实数字：
                    新增索引（真的写进去的）与已扫描（读了多少），口径写清楚。
                    这一句太长，允许在「 · 」处折成两行（同上，交给 CSS 处理）。 */}
                <p className="ai-search-knowledge-pass-line" data-testid="knowledge-pass-progress">
                  {formatKnowledgeProcessed(knowledgeStatus)}
                </p>
                {knowledgeStatus.pass && (
                  <p className="ai-search-knowledge-pass-line" data-testid="knowledge-pass-scope">
                    {knowledgeStatus.pass.phase === 'backfill'
                      ? `后台补齐历史：${(knowledgeStatus.pass.backfillCompletedConversations ?? 0).toLocaleString()} / ${(knowledgeStatus.pass.backfillConversations ?? 0).toLocaleString()} 个久未更新的会话`
                      : knowledgeStatus.pass.phase === 'catchup'
                        ? `正在追最新消息：${(knowledgeStatus.pass.catchupConversations ?? 0).toLocaleString()} 个会话有新内容`
                        : `正在建立索引：${(knowledgeStatus.pass.totalConversations ?? 0).toLocaleString()} 个会话`}
                  </p>
                )}
                {knowledgeStatus.pass && knowledgeStatus.pass.skippedConversations > 0 && (
                  <p className="ai-search-knowledge-pass-line">
                    已跳过 {knowledgeStatus.pass.skippedConversations.toLocaleString()} 个没有新消息的会话
                  </p>
                )}
              </div>
            )}
            <div className="ai-search-knowledge-rows">
              <div className="ai-search-knowledge-row">
                <span className="ai-search-knowledge-label">已索引消息</span>
                <strong className="ai-search-knowledge-value">
                  {(knowledgeStatus?.indexedMessageCount || 0).toLocaleString()}
                </strong>
              </div>
              <div className="ai-search-knowledge-row">
                <span className="ai-search-knowledge-label">知识片段</span>
                <strong className="ai-search-knowledge-value">
                  {(knowledgeStatus?.indexedChunkCount || 0).toLocaleString()}
                </strong>
              </div>
              {knowledgeStatus?.indexLatestAt ? (
                <div className="ai-search-knowledge-row">
                  <span className="ai-search-knowledge-label">最新索引</span>
                  <strong className="ai-search-knowledge-value">
                    {formatIndexDate(knowledgeStatus.indexLatestAt)}
                  </strong>
                </div>
              ) : null}
              <div className="ai-search-knowledge-row">
                <span className="ai-search-knowledge-label">磁盘占用</span>
                <strong className="ai-search-knowledge-value">
                  {formatBytes(
                    (knowledgeStatus?.databaseBytes || 0) +
                      (knowledgeStatus?.walBytes || 0) +
                      (knowledgeStatus?.shmBytes || 0)
                  )}
                </strong>
              </div>
            </div>
            {(knowledgeStatus?.currentConversationId && knowledgeIsRunning) ||
            (knowledgeStatus?.pass && knowledgeStatus.pass.mainLoopLagMs > 0) ? (
              <div className="ai-search-knowledge-rows">
                {knowledgeStatus?.currentConversationId && knowledgeIsRunning && (
                  <div className="ai-search-knowledge-row">
                    <span className="ai-search-knowledge-label">当前会话</span>
                    {/* 会话名可以很长（群名 / 备注），这里必须省略而不是撑破侧栏。 */}
                    <strong
                      className="ai-search-knowledge-value ai-search-knowledge-value--truncate"
                      title={knowledgeCurrentConversationName}
                    >
                      {knowledgeCurrentConversationName}
                    </strong>
                  </div>
                )}
                {knowledgeMainLoopLagMs > 0 && (
                  <div className="ai-search-knowledge-row">
                    <span className="ai-search-knowledge-label">界面卡顿峰值</span>
                    <strong className="ai-search-knowledge-value">
                      {formatDuration(knowledgeMainLoopLagMs)}
                    </strong>
                  </div>
                )}
              </div>
            ) : null}
            {knowledgeStatus?.state === 'error' && (
              <p className="ai-search-knowledge-error">
                {knowledgeStatus.lastError || '同步异常，已建立的索引仍可使用。'}
              </p>
            )}
            {knowledgeStatus?.state === 'cancelled' && (
              <p className="ai-search-knowledge-error">
                上一遍同步被取消，已建立的索引仍然可用；下次同步会从断点继续。
              </p>
            )}
            <div className="ai-search-knowledge-actions">
              <Button
                size="sm"
                className="ai-search-knowledge-primary"
                disabled={syncStarting || cancelRequested || knowledgeIsRunning}
                onClick={() => void startKnowledgeSync()}
              >
                {syncStarting
                  ? '启动中…'
                  : knowledgeIsRunning
                    ? '同步中…'
                    : knowledgeStatus?.indexedMessageCount
                      ? '同步最新记录'
                      : '建立本地知识库'}
              </Button>
              {knowledgeIsRunning && (
                <Button
                  size="sm"
                  variant="outline"
                  className="ai-search-knowledge-cancel"
                  data-testid="knowledge-cancel-sync"
                  disabled={cancelRequested || knowledgeStatus?.pass?.cancellable === false}
                  onClick={() => void cancelKnowledgeSync()}
                >
                  {cancelRequested ? '正在取消…' : '取消同步'}
                </Button>
              )}
            </div>
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
          {/* 图片文字索引：与 Knowledge 卡片平级、但**独立的一维能力**。
              文字消息索引完整不代表图片里的文字搜得到，所以两个入口必须并列可见。 */}
          <ImageTextIndexCard dbReady={dbReady} onNotice={onNotice} />
        </aside>
        <main className="ai-search-main">
          <div className="ai-search-main-scroll">
            {stage === 'idle' && renderIdle()}
            {stage === 'loading' && renderLoading()}
            {stage === 'result' && renderResult()}
            {stage === 'partial' && renderPartial()}
            {stage === 'insufficient' && renderInsufficient()}
          </div>
          <AISearchComposer
            query={query}
            sourceLabel={sourceLabel}
            rangeLabel={queryAgentEnabled ? '时间由问题决定' : RANGE_LABELS[range]}
            history={history}
            historyOpen={historyOpen}
            loading={stage === 'loading'}
            knowledgeSyncing={knowledgeSyncing}
            inputRef={composerRef}
            onQueryChange={setQuery}
            onHistoryOpenChange={setHistoryOpen}
            onRestoreHistory={restoreHistoryQuery}
            onRemoveHistory={removeHistoryQuery}
            onSubmit={() => void runAnalysis()}
            onCancel={() => void cancelAnalysis()}
          />
        </main>
        <AISearchEvidencePanel
          evidence={visibleEvidence}
          collectionCount={evidenceCollection.length}
          selectedEvidence={selectedEvidence}
          evidenceFlash={evidenceFlash}
          senderNames={senderNames}
          hasMoreEvidence={hasMoreEvidence}
          onFocusEvidence={focusEvidence}
          onJumpToEvidence={jumpToEvidence}
          onLoadMoreEvidence={loadMoreEvidence}
          setEvidenceCardRef={setEvidenceCardRef}
        />
      </div>
      <ExternalProviderConsentDialog
        consent={externalProviderConsent}
        onCancel={() => settleExternalProviderConsent(false)}
        onConfirm={() => settleExternalProviderConsent(true)}
      />
    </div>
  )
}
