import type { AgentTaskErrorKind, AgentTaskReply } from '../../shared/agent-task'

/**
 * AgentTaskProvider —— 可替换的任务投递接口。
 *
 * 第一版实现是 WorkBuddy；接口刻意只包含三件事：在线检测、投递、拉回复。
 * 任何「执行 shell / 发微信 / 改仓库」的能力都**不属于**这个接口。
 */

export interface AgentTaskProviderRequestOptions {
  signal?: AbortSignal
}

export interface AgentTaskProvider {
  readonly id: string
  /** 远端助理是否在线。false 时调用方必须放弃提交，不能降级成「假装已提交」。 */
  checkOnline(options?: AgentTaskProviderRequestOptions): Promise<boolean>
  /**
   * 投递一条指令，返回远端消息 id。
   *
   * 该调用**不是幂等的**：调用方负责按 `triggerKey` 去重，
   * 并在失败时区分「确定没提交」与「不确定是否提交」。
   */
  submitTask(
    input: { content: string },
    options?: AgentTaskProviderRequestOptions
  ): Promise<{ messageId: string }>
  /** 按游标增量拉取回复。 */
  fetchReplies(
    afterMessageId: string,
    options?: AgentTaskProviderRequestOptions & { limit?: number }
  ): Promise<AgentTaskReply[]>
}

export class AgentTaskProviderError extends Error {
  constructor(
    readonly kind: AgentTaskErrorKind,
    message: string,
    readonly retryable = false,
    readonly httpStatus?: number
  ) {
    super(message)
    this.name = 'AgentTaskProviderError'
  }
}

/** 把任意异常归类成可持久化的错误类型；未知异常一律 `internal`，不猜。 */
export function classifyProviderError(error: unknown): {
  kind: AgentTaskErrorKind
  message: string
  retryable: boolean
} {
  if (error instanceof AgentTaskProviderError) {
    return { kind: error.kind, message: error.message, retryable: error.retryable }
  }
  return {
    kind: 'internal',
    message: error instanceof Error ? error.message : String(error),
    retryable: false
  }
}
