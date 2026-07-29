import React, { useMemo, useRef, useState } from 'react'
import type { Contact, Message } from '../../../../shared/types'
import { SearchIcon } from '../chat/icons'

import type {
  AISearchCacheRecord,
  AISearchWorkspaceProps,
  EvidenceItem,
  GroupMemberName,
  SearchPassSummary,
  SearchRange,
  SearchScope,
  SearchStage,
  SenderDirectory
} from './searchTypes'
import {
  RANGE_LABELS,
  SEARCH_CACHE_KEY,
  SEARCH_HISTORY_KEY,
  buildLocalSearchPlan,
  buildSearchCacheKey,
  compactCacheItem,
  currentTimestamp,
  evidenceIdentity,
  formatMemberName,
  formatMessageDate,
  formatMessageTime,
  getRangeStart,
  includesSearchAlias,
  messageDateKey,
  messageIdentity,
  messageText,
  mergeSearchPlans,
  normalizeSearchText,
  parseSearchCacheKey,
  parseSearchPlanResponse,
  readSearchCache,
  readSearchCacheByQuery,
  selectEvenly,
  selectEvidenceByDate,
  senderName,
  writeSearchCache
} from './searchUtils'
import { renderMarkdown } from './searchMarkdown'

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
  const availableContacts = allContacts.slice(0, 80)
  const [scope, setScope] = useState<SearchScope>('global')
  const [scopeContactMd5, setScopeContactMd5] = useState(selectedContact?.md5 || '')
  const [range, setRange] = useState<SearchRange>('7d')
  const [contactFilter, setContactFilter] = useState('')
  const [query, setQuery] = useState('')
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
  const [debugEnabled, setDebugEnabled] = useState(false)
  const [debugPanelOpen, setDebugPanelOpen] = useState(false)
  const [debugEntries, setDebugEntries] = useState<string[]>([])
  const [appLogPath, setAppLogPath] = useState('')
  const bypassCacheRef = useRef(false)

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
    availableContacts.find(
      (contact) => contact.md5 === (scopeContactMd5 || selectedContact?.md5)
    ) || selectedContact
  const visibleContacts = availableContacts.filter((contact) => {
    const keyword = contactFilter.trim().toLowerCase()
    if (!keyword) return true
    return (
      contact.m_nsNickName.toLowerCase().includes(keyword) ||
      contact.m_nsUsrName.toLowerCase().includes(keyword)
    )
  })
  const sourceLabel =
    scope === 'conversation' ? activeContact?.m_nsNickName || '未选择会话' : '全局搜索'
  const modelLabel = aiModelConfig.configured
    ? `${aiModelConfig.providerName} · ${aiModelConfig.modelName}`
    : '尚未配置 AI 模型'

  const buildSourceContacts = (): Contact[] => {
    if (scope === 'conversation') return activeContact ? [activeContact] : []
    return allContacts
  }

  const loadSourcePages = async (
    sourceContacts: Contact[],
    startTime: number | undefined
  ): Promise<{ contact: Contact; messages: Message[] }[]> => {
    const pages = new Array<{ contact: Contact; messages: Message[] }>(sourceContacts.length)
    let nextIndex = 0
    const worker = async (): Promise<void> => {
      while (nextIndex < sourceContacts.length) {
        const index = nextIndex
        nextIndex += 1
        const contact = sourceContacts[index]
        pages[index] = {
          contact,
          messages: await window.api.getMessages(contact.md5, startTime)
        }
      }
    }
    const workerCount = Math.min(6, sourceContacts.length)
    await Promise.all(Array.from({ length: workerCount }, () => worker()))
    return pages
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
      const nextRecords = records.filter((item) => {
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
      localStorage.setItem(SEARCH_CACHE_KEY, JSON.stringify(nextRecords))
    } catch {
      // Cache cleanup is optional and must not interrupt the current workspace.
    }
    onNotice('已删除这条最近提问')
  }

  const applyCachedResult = (cached: AISearchCacheRecord, queryValue = query.trim()): void => {
    setAnswer(cached.answer)
    setEvidence(cached.evidence)
    setSenderNames(cached.senderNames)
    setMessageCount(cached.messageCount)
    setCachedAt(cached.createdAt)
    rememberQuery(queryValue)
  }

  const restoreHistoryQuery = (historyQuery: string): void => {
    setQuery(historyQuery)
    setSelectedEvidence(0)
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
      onNotice('这条提问没有可恢复的缓存，请点击开始分析重新读取消息')
      return
    }
    const cachedLocation = parseSearchCacheKey(cached.key)
    if (cachedLocation) {
      setScope(cachedLocation.scope)
      setRange(cachedLocation.range)
      setScopeContactMd5(cachedLocation.contactMd5)
    }
    setAnalysisError('')
    applyCachedResult(cached, historyQuery)
    setStage('result')
    onNotice('已恢复这条提问的检索结果')
  }

  const loadSenderDirectory = async (sourceContacts: Contact[]): Promise<SenderDirectory> => {
    const groupContacts = sourceContacts.filter((contact) => contact.type === 'group')
    const snapshots = await Promise.all(
      groupContacts.map(async (contact) => {
        const snapshot = (await window.api.getGroupSnapshot(contact.md5)) as {
          members?: GroupMemberName[]
        } | null
        return snapshot?.members || []
      })
    )
    const displayNames: Record<string, string> = {}
    const aliases: Record<string, string[]> = {}
    snapshots.flat().forEach((member) => {
      if (!member.wxid) return
      displayNames[member.wxid] = formatMemberName(member)
      aliases[member.wxid] = [
        member.groupNickname,
        member.nickname,
        member.remark,
        member.wechatNickname,
        member.wxid
      ].filter((name): name is string => Boolean(name?.trim()))
    })
    return { displayNames, aliases }
  }

  const runAnalysis = async (event?: React.FormEvent): Promise<void> => {
    event?.preventDefault()
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
    if (!aiModelConfig.configured) {
      setAnalysisError('尚未配置 AI 模型，请先在设置中添加可用的模型供应商')
      setStage('insufficient')
      return
    }

    const sourceContacts = buildSourceContacts()
    if (!sourceContacts.length) {
      setAnalysisError('没有可检索的聊天范围')
      setStage('insufficient')
      return
    }

    setStage('loading')
    setAnalysisError('')
    setAnswer('')
    setEvidence([])
    setSelectedEvidence(0)
    setCachedAt(0)
    const cacheKey = buildSearchCacheKey(
      scope,
      scope === 'conversation' ? activeContact?.md5 || '' : '',
      range,
      normalizedQuery
    )
    try {
      const cached = bypassCacheRef.current ? null : readSearchCache(cacheKey)
      bypassCacheRef.current = false
      if (cached) {
        addDebugEntry('检索命中缓存', { scope, range, messageCount: cached.messageCount })
        applyCachedResult(cached, normalizedQuery)
        setStage('result')
        onNotice('已使用最近的检索缓存，可点击刷新数据读取最新消息')
        return
      }
      const localSearchPlan = buildLocalSearchPlan(normalizedQuery)
      let searchPlan = localSearchPlan
      try {
        const planResult = await window.api.aiChat([
          {
            role: 'system',
            content:
              '你是本地聊天检索规划器，不回答用户问题。请从用户问题中提取用于本地数据库检索的主题词和同义短语，只输出 JSON：{"intent":"general|topic|participants|mixed","keywords":["..."],"variants":["..."]}。删除“全局搜索、我和谁聊过、这个话题”等意图词，不要编造人名或聊天内容。'
          },
          {
            role: 'user',
            content: `用户问题：${normalizedQuery}`
          }
        ])
        const aiPlan =
          planResult.success && planResult.data ? parseSearchPlanResponse(planResult.data) : null
        searchPlan = mergeSearchPlans(localSearchPlan, aiPlan)
        addDebugEntry('AI 检索规划完成', {
          source: searchPlan.source,
          intent: searchPlan.intent,
          keywords: searchPlan.keywords,
          variants: searchPlan.variants,
          aiPlanSuccess: Boolean(aiPlan)
        })
      } catch (error) {
        addDebugEntry('AI 检索规划失败，使用本地规划', {
          error: error instanceof Error ? error.message : '未知错误',
          keywords: localSearchPlan.keywords
        })
      }
      const startTime = getRangeStart(range)
      const pages = await loadSourcePages(sourceContacts, startTime)
      const sourceMessages = pages.flatMap((page) =>
        page.messages.map((message) => ({ contact: page.contact, message }))
      )
      const uniqueMessages = Array.from(
        new Map(
          sourceMessages.map((item) => [
            `${item.contact.md5}:${messageIdentity(item.message)}`,
            item
          ])
        ).values()
      ).sort((left, right) => (left.message.createTime || 0) - (right.message.createTime || 0))
      if (!uniqueMessages.length) {
        addDebugEntry('检索没有消息', { contactCount: sourceContacts.length, scope, range })
        setAnalysisError('当前范围内没有找到可分析的消息，请扩大时间范围或更换会话')
        setStage('insufficient')
        return
      }

      const queryKeywords = searchPlan.keywords
      const fuzzySearchKeywords = searchPlan.variants
      const contactNamesInQuery = sourceContacts.filter((contact) =>
        [contact.m_nsNickName, contact.m_nsUsrName, contact.remark, contact.wechatNickname]
          .filter((name): name is string => Boolean(name?.trim()))
          .some((name) => includesSearchAlias(normalizedQuery, name))
      )
      const senderDirectoryContacts =
        scope === 'conversation' ? sourceContacts : contactNamesInQuery
      const querySenderDirectory = await loadSenderDirectory(senderDirectoryContacts)
      const matchedSenderIds = new Set(
        Object.entries(querySenderDirectory.aliases)
          .filter(([, aliases]) =>
            aliases.some((name) => includesSearchAlias(normalizedQuery, name))
          )
          .map(([senderId]) => senderId)
      )
      const matchedContactIds = new Set(contactNamesInQuery.map((contact) => contact.md5))
      const senderMatchedMessages = uniqueMessages.filter(({ message }) => {
        const senderFields = [message.name, message.senderId, message.from].filter(
          (value): value is string => Boolean(value?.trim())
        )
        return (
          senderFields.some((value) => matchedSenderIds.has(value)) ||
          senderFields.some((value) => includesSearchAlias(normalizedQuery, value))
        )
      })
      const senderMessageIds = new Set(senderMatchedMessages.map(evidenceIdentity))
      const searchPasses = [
        { label: '主题精确匹配', keywords: queryKeywords },
        { label: 'AI 变体匹配', keywords: fuzzySearchKeywords }
      ]
      const keywordMatchedMap = new Map<string, EvidenceItem>()
      const passSummaries: SearchPassSummary[] = []
      for (const pass of searchPasses) {
        const passMatches = uniqueMessages.filter(({ message }) => {
          const text = normalizeSearchText(messageText(message))
          return pass.keywords.some((keyword) => text.includes(normalizeSearchText(keyword)))
        })
        passMatches.forEach((item) => keywordMatchedMap.set(evidenceIdentity(item), item))
        passSummaries.push({
          label: pass.label,
          keywords: pass.keywords,
          messageCount: passMatches.length
        })
      }
      const keywordMatchedMessages = Array.from(keywordMatchedMap.values())
      const keywordMessageIds = new Set(keywordMatchedMessages.map(evidenceIdentity))
      const relevantMessages = uniqueMessages.filter(({ contact, message }) => {
        if (matchedContactIds.has(contact.md5)) return true
        const itemKey = evidenceIdentity({ contact, message })
        return senderMessageIds.has(itemKey) || keywordMessageIds.has(itemKey)
      })
      const hasSearchConstraint =
        queryKeywords.length > 0 || fuzzySearchKeywords.length > 0 || matchedContactIds.size > 0
      if (!relevantMessages.length && hasSearchConstraint) {
        const attemptedTerms = Array.from(new Set([...queryKeywords, ...fuzzySearchKeywords])).join(
          '、'
        )
        const noResultMessage = `${RANGE_LABELS[range]}内没有找到包含“${attemptedTerms || '主题关键词'}”的聊天消息。已完成精确匹配和智能变体匹配，未回退到全量消息；可以扩大时间范围或换一个更具体的词。`
        addDebugEntry('检索未找到相关消息', {
          contactCount: sourceContacts.length,
          uniqueMessageCount: uniqueMessages.length,
          passSummaries,
          fallbackToAllMessages: false
        })
        setAnalysisError(noResultMessage)
        setStage('insufficient')
        return
      }
      const analysisMessages = relevantMessages.length ? relevantMessages : uniqueMessages
      addDebugEntry('检索消息匹配完成', {
        contactCount: sourceContacts.length,
        uniqueMessageCount: uniqueMessages.length,
        contactNameMatchCount: contactNamesInQuery.length,
        searchIntent: searchPlan.intent,
        searchPlanSource: searchPlan.source,
        queryKeywords,
        fuzzyKeywordCount: fuzzySearchKeywords.length,
        passSummaries,
        queryAliasCount: Object.keys(querySenderDirectory.aliases).length,
        senderMatchCount: matchedSenderIds.size,
        senderMessageCount: senderMatchedMessages.length,
        keywordMessageCount: keywordMatchedMessages.length,
        relevantMessageCount: relevantMessages.length,
        fallbackToAllMessages: relevantMessages.length === 0
      })
      const analysisContactIds = new Set(analysisMessages.map(({ contact }) => contact.md5))
      const analysisContacts = sourceContacts.filter((contact) =>
        analysisContactIds.has(contact.md5)
      )
      const resolvedSenderNames = {
        ...querySenderDirectory.displayNames,
        ...(
          await loadSenderDirectory(
            analysisContacts.filter((contact) => !matchedContactIds.has(contact.md5))
          )
        ).displayNames
      }
      const primaryMessages = senderMatchedMessages.length
        ? senderMatchedMessages
        : keywordMatchedMessages
      const primaryMessageIds = new Set(primaryMessages.map(evidenceIdentity))
      const selectedEvidenceItems = primaryMessages.length
        ? selectEvenly(primaryMessages, 8)
        : selectEvidenceByDate(analysisMessages, 8)
      const contextItems = primaryMessages.length
        ? [
            ...selectEvenly(primaryMessages, Math.min(160, primaryMessages.length)),
            ...selectEvidenceByDate(
              analysisMessages.filter((item) => !primaryMessageIds.has(evidenceIdentity(item))),
              80
            )
          ]
        : selectEvidenceByDate(analysisMessages, 240)
      const dateCounts = new Map<string, number>()
      const senderCounts = new Map<string, number>()
      analysisMessages.forEach(({ contact, message }) => {
        const date = messageDateKey(message)
        dateCounts.set(date, (dateCounts.get(date) || 0) + 1)
        const name = senderName(message, contact, resolvedSenderNames)
        senderCounts.set(name, (senderCounts.get(name) || 0) + 1)
      })
      const dateSummary = Array.from(dateCounts.entries())
        .map(([date, count]) => `${formatMessageDate(date)} ${count} 条`)
        .join('、')
      const senderSummary = Array.from(senderCounts.entries())
        .sort(([, left], [, right]) => right - left)
        .slice(0, 12)
        .map(([name, count]) => `${name} ${count} 条`)
        .join('、')
      const asksConversationParticipants =
        searchPlan.intent === 'participants' || searchPlan.intent === 'mixed'
      const context = contextItems
        .map(
          ({ contact, message }) =>
            `[${formatMessageTime(message)}] ${contact.m_nsNickName} / ${senderName(message, contact, resolvedSenderNames)}: ${messageText(message)}`
        )
        .join('\n')
      const aiResult = await window.api.aiChat([
        {
          role: 'system',
          content:
            '你是 WechatExplorer 的本地聊天记录分析助手。只能基于提供的消息回答，不得编造事实。请用中文回答，先给出简短摘要，再列出关键主题、结论和不确定性。对人物问题只能描述群聊中的发言主题和可能角色，不做人格或敏感属性判断。'
        },
        {
          role: 'user',
          content: `检索范围：${sourceLabel}，时间：${RANGE_LABELS[range]}\n用户问题：${normalizedQuery}\n检索意图：${searchPlan.intent}\n检索关键词：${queryKeywords.join('、') || '未提取到主题关键词'}\n检索变体：${fuzzySearchKeywords.join('、') || '无'}\n相关消息数：${analysisMessages.length}\n目标成员消息数：${senderMatchedMessages.length}\n检索范围消息总数：${uniqueMessages.length}\n覆盖日期：${new Set(analysisMessages.map((item) => messageDateKey(item.message))).size} 天\n按日期统计：${dateSummary}\n主要发言者统计：${senderSummary}\n${asksConversationParticipants ? '\n这是一个“我和谁聊过”的问题，请按聊天会话和联系人归纳，优先列出实际出现主题关键词的会话，不要根据全量消息猜测。' : ''}\n以下是按检索轮次命中的原始消息，优先级最高的消息排在前面，不代表全部消息：\n${context}`
        }
      ])
      if (!aiResult.success || !aiResult.data) {
        setAnalysisError(aiResult.error || 'AI 分析失败，请稍后重试')
        setStage('insufficient')
        return
      }
      setAnswer(aiResult.data)
      setEvidence(selectedEvidenceItems)
      setSenderNames(resolvedSenderNames)
      setMessageCount(uniqueMessages.length)
      rememberQuery(normalizedQuery)
      writeSearchCache({
        version: 1,
        key: cacheKey,
        createdAt: currentTimestamp(),
        answer: aiResult.data,
        evidence: selectedEvidenceItems.map(compactCacheItem),
        senderNames: resolvedSenderNames,
        messageCount: uniqueMessages.length
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
    const result = await window.api.copyText(answer)
    onNotice(result.success ? 'AI 摘要已复制' : result.error || '复制失败')
  }

  const renderIdle = (): React.ReactElement => (
    <div className="ai-search-empty">
      <div className="ai-search-empty-mark" aria-hidden>
        <span>✦</span>
      </div>
      <span className="ai-search-kicker">LOCAL AI WORKSPACE</span>
      <h2>把聊天记录变成可追问的答案</h2>
      <p>选择范围，用自然语言提问。AI 只读取本地聊天数据，并为每个结论保留证据。</p>
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

  const renderLoading = (): React.ReactElement => (
    <div className="ai-search-loading">
      <div className="ai-search-spinner" aria-hidden />
      <span className="ai-search-kicker">AI 正在分析</span>
      <h2>正在读取本地消息并提取证据</h2>
      <p>
        范围：{sourceLabel} · {RANGE_LABELS[range]}
      </p>
      <div className="ai-search-loading-steps">
        <span className="done">● 建立本地数据范围</span>
        <span className="active">● 提取关键消息</span>
        <span>○ 生成带证据的摘要</span>
      </div>
    </div>
  )

  const renderResult = (): React.ReactElement => (
    <div className="ai-search-result">
      <div className="ai-search-result-header">
        <div>
          <span className="ai-search-kicker">AI 深度检索结果</span>
          <h2>{query}</h2>
          <p>
            {sourceLabel} · {RANGE_LABELS[range]} · 基于 {messageCount} 条消息 · 证据采样{' '}
            {evidence.length} 条{cachedAt ? ' · 已使用缓存' : ''}
          </p>
        </div>
        <div className="ai-search-result-actions">
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
        <div className="ai-search-answer">{renderMarkdown(answer)}</div>
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
          setRange('30d')
          setStage('idle')
        }}
      >
        扩大到近 30 天
      </button>
    </div>
  )

  return (
    <div className="ai-search-workspace">
      <header className="ai-search-header">
        <div>
          <span className="ai-search-kicker">WechatExplorer · LOCAL INTELLIGENCE</span>
          <h1>AI 智能检索</h1>
          <p>在本地聊天记录中提炼主题、结论和可追溯证据</p>
        </div>
        <div className="ai-search-header-actions">
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
          <div className="ai-search-panel-heading">
            <div>
              <span>范围与过滤</span>
              <strong>检索范围</strong>
            </div>
            <span className="ai-search-local-badge">本地</span>
          </div>
          <div className="ai-search-scope-toggle">
            <button
              type="button"
              className={scope === 'global' ? 'active' : ''}
              onClick={() => setScope('global')}
            >
              全局搜索
            </button>
            <button
              type="button"
              className={scope === 'conversation' ? 'active' : ''}
              onClick={() => {
                if (activeContact) {
                  setScope('conversation')
                  setScopeContactMd5(activeContact.md5)
                  return
                }
                onNotice('请先从下方选择一个会话')
              }}
            >
              指定会话
            </button>
          </div>
          <p className="ai-search-scope-help">
            {scope === 'global'
              ? '全局搜索会读取全部群聊和私聊；左侧列表用于快速指定会话。'
              : '指定会话只读取当前高亮的一个群聊或私聊。'}
          </p>
          <label className="ai-search-field-label" htmlFor="ai-search-contact-filter">
            会话
          </label>
          <div className="ai-search-filter-input">
            <SearchIcon />
            <input
              id="ai-search-contact-filter"
              value={contactFilter}
              onChange={(event) => setContactFilter(event.target.value)}
              placeholder="搜索群聊或联系人"
            />
          </div>
          <div className="ai-search-contact-list">
            {visibleContacts.map((contact) => (
              <button
                key={contact.md5}
                type="button"
                className={`ai-search-contact ${scope === 'conversation' && scopeContactMd5 === contact.md5 ? 'active' : ''}`}
                onClick={() => {
                  setScope('conversation')
                  setScopeContactMd5(contact.md5)
                  onSelectContact(contact)
                }}
              >
                <span className="ai-search-contact-avatar">
                  {contact.avatar ? (
                    <img src={contact.avatar} alt="" />
                  ) : (
                    contact.m_nsNickName.charAt(0)
                  )}
                </span>
                <span>
                  <strong>{contact.m_nsNickName || contact.m_nsUsrName}</strong>
                  <small>{contact.type === 'group' ? '群聊' : '联系人'}</small>
                </span>
              </button>
            ))}
            {!visibleContacts.length && <span className="ai-search-muted">没有匹配的会话</span>}
          </div>
          <div className="ai-search-field-heading">
            <label className="ai-search-field-label">时间范围</label>
            <span>当前：{RANGE_LABELS[range]}</span>
          </div>
          <div className="ai-search-range-grid">
            {(Object.keys(RANGE_LABELS) as SearchRange[]).map((item) => (
              <button
                key={item}
                type="button"
                className={range === item ? 'active' : ''}
                aria-pressed={range === item}
                onClick={() => setRange(item)}
              >
                {RANGE_LABELS[item]}
              </button>
            ))}
          </div>
          <div className="ai-search-filter-note">
            <span>●</span> 当前分析只读取本机数据库，不会操作微信。
          </div>
          {history.length > 0 && (
            <div className="ai-search-history">
              <label className="ai-search-field-label">最近提问</label>
              {history.map((item) => (
                <div className="ai-search-history-item" key={item}>
                  <button
                    type="button"
                    onClick={() => restoreHistoryQuery(item)}
                    title="恢复这条提问"
                  >
                    {item}
                  </button>
                  <button
                    type="button"
                    className="ai-search-history-delete"
                    aria-label={`删除最近提问：${item}`}
                    title="删除这条提问"
                    onClick={() => removeHistoryQuery(item)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </aside>
        <main className="ai-search-main">
          <div className="ai-search-main-scroll">
            {stage === 'idle' && renderIdle()}
            {stage === 'loading' && renderLoading()}
            {stage === 'result' && renderResult()}
            {stage === 'insufficient' && renderInsufficient()}
          </div>
          <form className="ai-search-composer" onSubmit={(event) => void runAnalysis(event)}>
            <div className="ai-search-composer-meta">
              <span>正在询问</span>
              <strong>{sourceLabel}</strong>
              <em>{RANGE_LABELS[range]}</em>
            </div>
            <div className="ai-search-composer-row">
              <textarea
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="例如：技术交流群最近讨论了哪些 Windows 性能问题？"
                rows={2}
              />
              <button type="submit" className="primary" disabled={stage === 'loading'}>
                {stage === 'loading' ? '分析中' : '开始分析'}
                <span>→</span>
              </button>
            </div>
            <div className="ai-search-composer-foot">
              <span>Enter 发送 · Shift + Enter 换行</span>
              <span>AI 只使用当前搜索范围内的消息</span>
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
          <div className="ai-search-evidence-meta">
            <span>范围</span>
            <strong>{sourceLabel}</strong>
            <span>时间</span>
            <strong>{RANGE_LABELS[range]}</strong>
          </div>
          {evidence.length ? (
            evidence.map((item, index) => (
              <button
                key={`${messageIdentity(item.message)}-${index}`}
                type="button"
                className={`ai-search-evidence-card ${selectedEvidence === index ? 'active' : ''}`}
                onClick={() => {
                  setSelectedEvidence(index)
                  onOpenEvidence(item.contact, item.message.createTime)
                }}
              >
                <span className="ai-search-evidence-card-top">
                  <strong>{senderName(item.message, item.contact, senderNames)}</strong>
                  <time>{formatMessageTime(item.message)}</time>
                </span>
                <span className="ai-search-evidence-conversation">{item.contact.m_nsNickName}</span>
                <span className="ai-search-evidence-text">{messageText(item.message)}</span>
                <span className="ai-search-evidence-link">跳转到档案 ↗</span>
              </button>
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
    </div>
  )
}
