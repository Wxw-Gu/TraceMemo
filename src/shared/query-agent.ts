import type { AiSearchPipelineRequest, AiSearchPipelineResult } from './ai-search'
import type { QueryCorpusScope } from './local-query-api'

/**
 * Query Agent 生产接入的跨层 contract。
 *
 * 只描述「入口 → QueryAgentRuntime → 回答」这一段：桌面问问微信与 Agent Hub 共用同一份定义。
 * 这里**不包含**任何 Tool / prompt / temporalBasis 语义 —— 那些属于
 * `src/main/services/query-agent-service.ts`，不跨层暴露。
 */

export type QueryAgentEntry = 'desktop' | 'agent-hub'

/**
 * 搜索范围（WHERE TO SEARCH）。
 *
 * 与时间（WHEN）完全正交：时间是问题文本的一部分，由 temporalBasis 理解；
 * 范围是 UI 的确定性数据边界，由 Host 结构性强制（LLM 无法修改，越界 target 会被拒绝）。
 */
export interface AskWechatScope {
  scope: QueryCorpusScope
  /** 人类可读的范围说明（UI 本来就知道，用于向模型描述范围与展示统计）。 */
  label?: string
}

/** 展示用证据：只含可读字段，不含 wxid / md5 / DB id / raw Tool JSON。 */
export interface AskWechatEvidenceItem {
  messageRef: string
  conversationName?: string
  conversationType?: 'user' | 'group'
  sender?: string
  /** epoch ms */
  timestamp?: number
  messageType?: string
  text?: string
  attachment?: { kind?: string; name?: string; url?: string; sizeBytes?: number }
  /** 产生这条证据的 Tool（诊断 / 分组）。 */
  source: string
}

/**
 * 顶部统计用的**真实**读取数字。
 * 不再使用"知识库已收录"这类与具体 Tool 无关的 Legacy 文案：
 * query_messages 直读 WCDB，search / overview 走不同路径。
 */
export interface AskWechatStats {
  /** 本次实际使用的 Tool（顺序即调用顺序）。 */
  tools: string[]
  /** 各 Tool 的结构化计数。 */
  reads: {
    /** query_messages 读到的消息条数（多次求和）。 */
    messageCount: number
    /** search_messages / overview 命中的证据条数（多次求和）。 */
    matchedCount: number
    /** 会话概览覆盖的源消息条数。 */
    overviewSourceCount: number
    /** 去重后的证据条数。 */
    evidenceCount: number
  }
  /** 本次语料边界（用于"搜索所有群聊"这类文案）。 */
  scope?: { kind: QueryCorpusScope['kind']; label?: string }
  modelCallCount: number
  toolCallCount: number
  totalMs: number
  /**
   * 耗时拆解（ADDITIVE）。
   *
   * 只有总耗时时用户无法回答"这几十秒花在哪"。这里按用户能读懂的口径拆开
   * （AI / 本地查询 / 总耗时）；更细的每次模型调用耗时留在诊断里，dev 模式才看。
   */
  timings?: {
    /** 所有模型调用耗时之和（Model #1 + Model #2 + …）。 */
    modelMs: number
    /** 本地 Tool 执行耗时之和（检索 / 读取，不含模型）。 */
    localQueryMs: number
    /** 端到端总耗时。 */
    totalMs: number
    /** 每次模型调用的耗时（按顺序），仅用于 dev 模式的细分展示。 */
    modelDurationsMs?: number[]
    /** 每次 Tool 调用的耗时（按顺序），仅用于 dev 模式的细分展示。 */
    toolDurationsMs?: number[]
  }
}

/**
 * 生产进度阶段。**只描述真实 Runtime 生命周期**：
 * - `understanding`：第 1 次模型调用正在进行（模型在决定要查什么）
 * - `searching`：正在执行一个 Query Tool（本地检索）
 * - `organizing_evidence`：刚拿到 Tool Result，在整理证据 / 决定是否继续
 * - `generating_answer`：模型在已有 Tool 结果之上组织最终回答
 * - `completed`：本次 run 结束（成功或失败）
 *
 * 刻意**没有**百分比、没有"预计剩余"：事件只在真实边界发出，不存在"每 N 秒假装跳一步"
 * 的定时器 —— UI 阶段必须能对应到实际发生的事。
 */
export type QueryAgentProgressStage =
  | 'understanding'
  | 'searching'
  | 'organizing_evidence'
  | 'generating_answer'
  | 'completed'

export interface QueryAgentProgressEvent {
  stage: QueryAgentProgressStage
  /** 从本次 run 开始的已用时间。 */
  elapsedMs: number
  /** 真实进入该阶段的时间戳。 */
  at: number
  /**
   * 正在执行 / 刚完成的 Tool 名。
   *
   * 只用于 UI 侧把 `searching` 细分成"正在搜索聊天记录"/"正在搜索较大范围"等可读文案。
   * **绝不**直接呈现给用户（不能暴露 toolName / SQL / FTS 等内部概念）。
   */
  toolName?: string
  /** 到目前为止已发生的模型调用次数（含正在进行的那次）。 */
  modelCallCount: number
  /** 到目前为止已完成的工具调用次数。 */
  toolCallCount: number
}

/**
 * 诊断摘要：只含**形态**信息（入口 / provider / 调用次数 / 耗时 / 工具路径 / 结果类型）。
 * 绝不含聊天原文、Evidence、messageRef、token、内部 id。
 */
export interface QueryAgentDiagnostics {
  entry: QueryAgentEntry
  provider: string
  model: string
  modelCallCount: number
  toolCallCount: number
  /** 本次实际使用到的 Tool 名称（顺序即调用顺序），不含参数。 */
  tools: string[]
  totalMs: number
  outcome: AskWechatOutcome
}

export type AskWechatOutcome =
  | 'answered'
  | 'provider_unavailable'
  | 'provider_failure'
  | 'tool_limit'
  | 'invalid_question'
  | 'runtime_error'

export interface AskWechatQueryRequest {
  requestId: string
  text: string
  /** 搜索范围（UI 决定）。省略 = 不限制（等价于 all）。 */
  scope?: AskWechatScope
  /**
   * Legacy fallback 需要沿用 UI 当前的范围 / 会话选择（可选；缺省 global + all）。
   *
   * Query Agent 主路径**不消费**这些字段：时间语义来自问题本身（temporalBasis），
   * 不能被 UI 的时间开关覆盖。
   */
  legacy?: Partial<Omit<AiSearchPipelineRequest, 'requestId' | 'text'>>
}

/** 允许回退 Legacy 的原因（仅 Runtime 不可恢复错误）。 */
export type AskWechatFallbackReason = 'runtime_error'

export type AskWechatQueryResult =
  /** Query Agent 正常回答（含 clarification：模型用自然语言追问，UI 当普通回复显示）。 */
  | {
      engine: 'query-agent'
      status: 'answered'
      answer: string
      /** 本次回答实际依据的证据（去重、限量）；UI 不允许从 answer 反解析。 */
      evidence: AskWechatEvidenceItem[]
      stats: AskWechatStats
      diagnostics: QueryAgentDiagnostics
    }
  /**
   * Provider 不可用 / 未配置。
   * 不回退 Legacy：Legacy 走同一个 AIProviderService，同样会失败，只会增加等待时间。
   */
  | {
      engine: 'query-agent'
      status: 'provider_unavailable'
      message: string
      diagnostics: QueryAgentDiagnostics
    }
  /** Runtime 抛出未分类异常 → 按既定规则回退 Legacy。 */
  | {
      engine: 'legacy'
      status: 'legacy'
      reason: AskWechatFallbackReason
      result: AiSearchPipelineResult
    }
  /** 无法回答且不回退（空问题等）。 */
  | { engine: 'query-agent'; status: 'error'; message: string; diagnostics: QueryAgentDiagnostics }

export interface AskWechatConfig {
  /** Query Agent 是否为桌面问问微信的主路径。 */
  queryAgentEnabled: boolean
}
