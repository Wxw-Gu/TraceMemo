import type { AiSearchPipelineRequest, AiSearchPipelineResult } from '../../shared/ai-search'
import type {
  AskWechatEvidenceItem,
  AskWechatOutcome,
  AskWechatFallbackReason,
  AskWechatQueryRequest,
  AskWechatQueryResult,
  AskWechatScope,
  AskWechatStats,
  QueryAgentDiagnostics,
  QueryAgentEntry,
  QueryAgentProgressEvent
} from '../../shared/query-agent'
import { QueryAgentService, type QueryAgentResult } from './query-agent-service'
import { QueryAgentConversationMemory } from './query-agent-conversation-memory'

/** Provider 不可用时的用户可见文案。不下发内部错误、stack、raw provider response。 */
const PROVIDER_UNAVAILABLE_MESSAGE = '当前 AI 查询服务暂时不可用，请稍后再试。'
/** Runtime 不可恢复错误（且无法回退）时的用户可见文案。 */
const RUNTIME_FAILURE_MESSAGE = '本次查询没有完成，请稍后再试或换一种问法。'
const EMPTY_QUESTION_MESSAGE = '请先输入想了解的问题。'

export type AskWechatLegacyRunner = (
  request: AiSearchPipelineRequest
) => Promise<AiSearchPipelineResult>

export interface AskWechatLogRecord {
  level: 'info' | 'warn' | 'error'
  message: string
  details?: Record<string, unknown>
}

export interface AskWechatServiceOptions {
  /** 入口标记，只用于诊断。 */
  entry: QueryAgentEntry
  /**
   * 仅桌面使用：Runtime 不可恢复错误时允许回退 Legacy。
   * 不传表示该入口没有 Legacy fallback（Agent Hub 就没传）。
   */
  runLegacy?: AskWechatLegacyRunner
  log?: (record: AskWechatLogRecord) => void
  memory?: QueryAgentConversationMemory
}

/**
 * 「问问微信」/ Agent Hub 查询入口的 Adapter。
 *
 * 职责：调用 Query Agent Runtime、维护有界的澄清上下文、把结构化结果映射成可展示的形状、
 * 并决定是否允许 Legacy fallback。它**不含**任何 prompt / tool / temporalBasis 语义。
 *
 * Fallback 规则：只在 Runtime 不可恢复错误（异常 / tool limit）时回退 Legacy。
 * Provider 失败不回退（Legacy 用同一个 Provider，只会更慢）；0 结果、模型说"没找到"、
 * 要求澄清、答案很短 —— 一律不回退。
 */
export class AskWechatService {
  private readonly memory: QueryAgentConversationMemory

  constructor(
    private readonly runtime: QueryAgentService,
    private readonly options: AskWechatServiceOptions
  ) {
    this.memory = options.memory || new QueryAgentConversationMemory()
  }

  async ask(
    request: AskWechatQueryRequest,
    conversationKey = 'default',
    /**
     * 真实 Runtime 进度（ADDITIVE）。由 IPC 层转发给 renderer。
     * 不传时行为与之前完全一致；回调抛异常不会影响查询本身（Runtime 侧已兜住）。
     */
    onProgress?: (event: QueryAgentProgressEvent) => void
  ): Promise<AskWechatQueryResult> {
    const startedAt = Date.now()
    const question = String(request.text || '').trim()
    let result: QueryAgentResult
    try {
      result = await this.runtime.run(question, {
        history: this.memory.history(conversationKey),
        // 搜索范围：UI 决定的数据边界，Runtime 透传给 Engine 并结构性强制。
        ...(request.scope ? { conversationScope: request.scope } : {}),
        ...(onProgress ? { onProgress } : {})
      })
    } catch {
      // Runtime 抛出未分类异常 = UNEXPECTED_INTERNAL_ERROR，允许 Legacy fallback。
      const diagnostics = this.diagnostics(
        { provider: '', model: '', modelCallCount: 0, toolCallCount: 0, traces: [] },
        startedAt,
        'runtime_error'
      )
      this.writeLog('error', `Query Agent Runtime 异常（${this.options.entry}）`, diagnostics)
      return this.fallback(request, 'runtime_error', diagnostics)
    }

    if (result.errorKind === 'invalid_question') {
      return {
        engine: 'query-agent',
        status: 'error',
        message: EMPTY_QUESTION_MESSAGE,
        diagnostics: this.diagnostics(result, startedAt, 'invalid_question')
      }
    }

    if (result.errorKind === 'provider_unavailable' || result.errorKind === 'provider_failure') {
      const outcome: AskWechatOutcome = result.errorKind
      const diagnostics = this.diagnostics(result, startedAt, outcome)
      this.writeLog('warn', `查询 Provider 不可用（${this.options.entry}）`, diagnostics)
      return {
        engine: 'query-agent',
        status: 'provider_unavailable',
        message: PROVIDER_UNAVAILABLE_MESSAGE,
        diagnostics
      }
    }

    if (result.errorKind === 'tool_limit') {
      const diagnostics = this.diagnostics(result, startedAt, 'tool_limit')
      this.writeLog('warn', `查询超出工具调用上限（${this.options.entry}）`, diagnostics)
      return this.fallback(request, 'runtime_error', diagnostics)
    }

    if (!result.answer?.trim()) {
      const diagnostics = this.diagnostics(result, startedAt, 'runtime_error')
      this.writeLog('warn', `Query Agent 未返回回答（${this.options.entry}）`, diagnostics)
      return this.fallback(request, 'runtime_error', diagnostics)
    }

    const answer = result.answer.trim()
    // 澄清回答也记录：下一句（"是 BOBO"）需要接得上上文。
    this.memory.record(conversationKey, question, answer)
    const diagnostics = this.diagnostics(result, startedAt, 'answered')
    this.writeLog('info', `Query Agent 回答完成（${this.options.entry}）`, diagnostics)
    return {
      engine: 'query-agent',
      status: 'answered',
      answer,
      // 直接透传 Runtime 收集的真实证据：UI 不允许从 answer 文本反解析。
      evidence: (result.evidence || []) as AskWechatEvidenceItem[],
      stats: buildAskWechatStats(result, request.scope, startedAt),
      diagnostics
    }
  }

  /** 桌面点「新问题」时清掉当前会话的澄清上下文。 */
  forgetConversation(conversationKey = 'default'): void {
    this.memory.forget(conversationKey)
  }

  private async fallback(
    request: AskWechatQueryRequest,
    reason: AskWechatFallbackReason,
    diagnostics: QueryAgentDiagnostics
  ): Promise<AskWechatQueryResult> {
    if (!this.options.runLegacy) {
      return {
        engine: 'query-agent',
        status: 'error',
        message: RUNTIME_FAILURE_MESSAGE,
        diagnostics
      }
    }
    try {
      const legacyResult = await this.options.runLegacy({
        scope: 'global',
        range: 'all',
        ...request.legacy,
        requestId: request.requestId,
        text: request.text
      })
      this.writeLog('warn', `Query Agent 失败后回退 Legacy（${this.options.entry}）`, diagnostics, reason)
      return { engine: 'legacy', status: 'legacy', reason, result: legacyResult }
    } catch {
      this.writeLog('error', `Legacy fallback 也失败（${this.options.entry}）`, diagnostics, reason)
      return {
        engine: 'query-agent',
        status: 'error',
        message: RUNTIME_FAILURE_MESSAGE,
        diagnostics
      }
    }
  }

  private diagnostics(
    result: Pick<
      QueryAgentResult,
      'provider' | 'model' | 'modelCallCount' | 'toolCallCount' | 'traces'
    > &
      Partial<Pick<QueryAgentResult, 'totalMs'>>,
    startedAt: number,
    outcome: AskWechatOutcome
  ): QueryAgentDiagnostics {
    return {
      entry: this.options.entry,
      provider: result.provider,
      model: result.model,
      modelCallCount: result.modelCallCount,
      toolCallCount: result.toolCallCount,
      tools: (result.traces || []).map((trace) => trace.toolName),
      totalMs: result.totalMs || Date.now() - startedAt,
      outcome
    }
  }

  private writeLog(
    level: AskWechatLogRecord['level'],
    message: string,
    details: QueryAgentDiagnostics,
    fallbackReason?: AskWechatFallbackReason
  ): void {
    // 展开成匿名对象：只传形态字段（入口 / provider / 次数 / 耗时 / 结果），不含聊天内容。
    this.options.log?.({
      level,
      message,
      details: { ...details, ...(fallbackReason ? { fallbackReason } : {}) }
    })
  }
}

/**
 * 顶部统计只用**真实执行**产生的数字：三个 Query Tool 的数据来源不同
 * （`query_messages` 直读 WCDB，`search_messages` / `conversation_overview` 走检索），
 * 统计口径必须各自如实，不能套用统一的"已收录 / 读取"文案。
 */
export function buildAskWechatStats(
  result: Pick<
    QueryAgentResult,
    'traces' | 'evidence' | 'modelCallCount' | 'toolCallCount' | 'totalMs' | 'modelDurationsMs'
  >,
  scope: AskWechatScope | undefined,
  startedAt: number
): AskWechatStats {
  let messageCount = 0
  let matchedCount = 0
  let overviewSourceCount = 0
  const tools: string[] = []
  for (const trace of result.traces || []) {
    tools.push(trace.toolName)
    if (trace.toolName === 'query_messages') {
      messageCount += trace.resultCount || 0
    } else {
      matchedCount += trace.evidenceCount || 0
      overviewSourceCount += trace.sourceMessageCount || 0
    }
  }
  const totalMs = result.totalMs || Date.now() - startedAt
  // 真实拆解：模型总耗时直接来自每次模型调用的测量；本地查询 = 所有 Tool 的 durationMs 之和。
  // 两者不互相推算（用 total - model 反推会把"框架开销"混进"本地查询"，那是另一种谎）。
  const modelDurationsMs = (result.modelDurationsMs || []).filter((value) =>
    Number.isFinite(value)
  )
  const toolDurationsMs = (result.traces || [])
    .map((trace) => trace.durationMs)
    .filter((value) => Number.isFinite(value))
  return {
    tools,
    reads: {
      messageCount,
      matchedCount,
      overviewSourceCount,
      evidenceCount: (result.evidence || []).length
    },
    ...(scope
      ? { scope: { kind: scope.scope.kind, ...(scope.label ? { label: scope.label } : {}) } }
      : {}),
    modelCallCount: result.modelCallCount,
    toolCallCount: result.toolCallCount,
    totalMs,
    timings: {
      modelMs: modelDurationsMs.reduce((sum, value) => sum + value, 0),
      localQueryMs: toolDurationsMs.reduce((sum, value) => sum + value, 0),
      totalMs,
      ...(modelDurationsMs.length ? { modelDurationsMs } : {}),
      ...(toolDurationsMs.length ? { toolDurationsMs } : {})
    }
  }
}
