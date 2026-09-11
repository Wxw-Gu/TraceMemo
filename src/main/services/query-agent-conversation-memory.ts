import type { QueryAgentHistoryTurn } from './query-agent-service'

/**
 * 最小多轮澄清上下文的边界（刻意写成显式常量，便于审计）。
 *
 * 只保留极少数轮次、极短文本、极短有效期 —— 目的是让"你说的是哪位联系人？"这类
 * 澄清之后的下一句能被接上，而不是实现 Agent 长期记忆。
 */
export const CONVERSATION_MEMORY_MAX_TURNS = 2
export const CONVERSATION_MEMORY_QUESTION_MAX_CHARS = 300
export const CONVERSATION_MEMORY_ANSWER_MAX_CHARS = 800
export const CONVERSATION_MEMORY_TTL_MS = 10 * 60 * 1000

interface ConversationEntry {
  turns: QueryAgentHistoryTurn[]
  updatedAt: number
}

function truncate(value: string, maxChars: number): string {
  const normalized = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars)}…` : normalized
}

/**
 * 有界的问答上下文。
 *
 * 隐私边界：
 * - 只保存「用户问题 + Query Agent 最终回答」，**不保存** Tool 结果 / Evidence / 聊天原文；
 * - 只存在内存，不落盘、不进日志、不跨进程；
 * - 超过 TTL 或超过轮次上限即丢弃。
 */
export class QueryAgentConversationMemory {
  private readonly entries = new Map<string, ConversationEntry>()

  constructor(private readonly now: () => number = () => Date.now()) {}

  history(key: string): QueryAgentHistoryTurn[] {
    const entry = this.entries.get(key)
    if (!entry) return []
    if (this.now() - entry.updatedAt > CONVERSATION_MEMORY_TTL_MS) {
      this.entries.delete(key)
      return []
    }
    return entry.turns.map((turn) => ({ ...turn }))
  }

  record(key: string, question: string, answer: string): void {
    const turn: QueryAgentHistoryTurn = {
      question: truncate(question, CONVERSATION_MEMORY_QUESTION_MAX_CHARS),
      answer: truncate(answer, CONVERSATION_MEMORY_ANSWER_MAX_CHARS)
    }
    if (!turn.question || !turn.answer) return
    const previous = this.history(key)
    this.entries.set(key, {
      turns: [...previous, turn].slice(-CONVERSATION_MEMORY_MAX_TURNS),
      updatedAt: this.now()
    })
  }

  /** 只忘记某一路会话（例如用户点了「新问题」）。不传 key 时清空全部。 */
  forget(key?: string): void {
    if (key === undefined) {
      this.entries.clear()
      return
    }
    this.entries.delete(key)
  }
}
