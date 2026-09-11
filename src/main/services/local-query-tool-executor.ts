import type {
  ConversationOverviewRequest,
  MessageContextRequest,
  QueryMessagesRequest,
  SearchMessagesRequest
} from '../../shared/local-query-api'
import type { LocalQueryApiService } from './local-query-api-service'
import type {
  QueryAgentToolContext,
  QueryAgentToolExecutor,
  QueryAgentToolResult
} from './query-agent-service'

/**
 * 进程内 Tool Executor：把 Query Agent 的 Tool 调用直接映射到 Local Query API Service。
 *
 * 桌面问问微信与 Agent Hub 共用这一份；不经过 HTTP、不需要 token、不依赖 6131 端口。
 * Local Query API 的 public contract 未改变：时间仍是 epoch seconds（absolute 的 ISO-8601
 * 已由 Runtime 在 Host 侧换算），temporalBasis 已在 Host 侧剥离。
 *
 * CLI 仍使用自己的 HTTP executor（它跑在独立进程里），属于 Adapter 层差异。
 */
export function createLocalQueryToolExecutor(
  queryApi: LocalQueryApiService
): QueryAgentToolExecutor {
  return async (
    name: string,
    input: Record<string, unknown>,
    context?: QueryAgentToolContext
  ): Promise<QueryAgentToolResult> => {
    // 语料边界由 Host 注入（LLM 无法提供，Tool schema 里也没有这个字段）。
    // 越界 target 由 Engine 结构化拒绝，这里不做语义判断。
    const request = context?.conversationScope
      ? { ...input, scope: context.conversationScope }
      : input
    switch (name) {
      case 'query_messages':
        // Local Query API 的 response 是显式 interface，没有 index signature，
        // 这里显式窄化到 Runtime 的宽松 Tool Result 形状（Runtime 只读 status 与计数字段）。
        return (await queryApi.messages(
          request as unknown as QueryMessagesRequest
        )) as unknown as QueryAgentToolResult
      case 'search_messages':
        return (await queryApi.search(
          request as unknown as SearchMessagesRequest
        )) as unknown as QueryAgentToolResult
      case 'message_context':
        return (await queryApi.context(
          request as unknown as MessageContextRequest
        )) as unknown as QueryAgentToolResult
      case 'conversation_overview':
        return (await queryApi.overview(
          request as unknown as ConversationOverviewRequest
        )) as unknown as QueryAgentToolResult
      default:
        throw new Error(`不允许的工具: ${name}`)
    }
  }
}
