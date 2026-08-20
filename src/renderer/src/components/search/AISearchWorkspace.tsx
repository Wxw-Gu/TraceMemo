import React, { useMemo, useRef, useState } from 'react'
import { aiSearchIntentLabel, aiSearchRangeStart } from '../../../../shared/ai-search'
import type { AiSearchProgressEvent, AiSearchTimeRange } from '../../../../shared/ai-search'

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
  formatMeasuredDuration,
  formatSearchTraceOverview,
  knowledgeStateLabel
} from './searchFormatters'
import { mapPipelineResultToRendererResult } from './searchMappers'
import { createSearchResultResetState, resolveSearchResultViewTransition } from './searchState'
import { useSearchHistory } from './hooks/useSearchHistory'
import { useKnowledgeStatus } from './hooks/useKnowledgeStatus'
import { useExternalProviderConsent } from './hooks/useExternalProviderConsent'
import { EVIDENCE_PAGE_SIZE, useEvidenceCollection } from './hooks/useEvidenceCollection'
import { useAiSearchRun } from './hooks/useAiSearchRun'
import { ensureAiSearchDataConsent } from './services/aiSearchProviderConsent'
import { ExternalProviderConsentDialog } from './ExternalProviderConsentDialog'
import { AISearchComposer } from './AISearchComposer'
import { AISearchEvidencePanel } from './AISearchEvidencePanel'
import { Button } from '../ui'

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
    startKnowledgeSync
  } = useKnowledgeStatus({ dbReady, onNotice })
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
  } = useAiSearchRun()

  const resetSearchResult = (): void => {
    const reset = createSearchResultResetState()
    setAnalysisError(reset.analysisError)
    setAnswer(reset.answer)
    clearEvidenceCollection()
    setCachedAt(reset.cachedAt)
    setSearchTrace(reset.searchTrace)
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
  const cancelAnalysis = async (): Promise<void> => {
    clearExternalProviderConsent()
    const requestId = searchRunRequestId
    if (!requestId) return
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
    if (knowledgeSyncingRef.current) {
      onNotice('知识库正在同步，请等待同步完成后再开始分析')
      return
    }
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
      if (knowledgeSyncingRef.current) {
        onNotice('知识库正在同步，请等待同步完成后再开始分析')
        return
      }
      setStage('loading')
      resetSearchResult()
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
      const searchResult = outcome.result
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
      const viewTransition = resolveSearchResultViewTransition(searchResult, effectiveRange)
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
    setQuery('')
    setResultQuery('')
    setStage('idle')
    resetSearchResult()
    clearActiveResult()
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
            variant="outline"
            size="sm"
            className="px-2"
            onClick={() => void copyAnswer()}
            title="复制 AI 摘要"
          >
            复制摘要
          </Button>
          <Button
            variant="outline"
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
            <Button
              size="sm"
              className="w-full"
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
            </Button>
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
          <AISearchComposer
            query={query}
            sourceLabel={sourceLabel}
            rangeLabel={RANGE_LABELS[range]}
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
