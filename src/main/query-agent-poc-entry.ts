/**
 * Query Agent CLI 入口（adapter）。
 *
 * 这里**只负责** CLI 专属的部分：argv 解析、HTTP Tool Executor、诊断摘要、stdout JSON。
 * Query Agent 的行为完全来自 `src/main/services/query-agent-service.ts` —— CLI 与桌面问问微信 /
 * Agent Hub 共用同一份实现，不存在第二套 prompt 或 orchestration。
 */
import './app-data-bootstrap'
import { app } from 'electron'
import { apiTokenStore } from './api-token-store'
import { AIProviderService } from './services/ai-provider-service'
import { QueryAgentService, type QueryAgentToolResult } from './services/query-agent-service'
import { parsePocInvocation } from './query-agent-poc-cli'
import { formatProviderDiagnostics, formatTiming } from './query-agent-poc-report'
import type { QueryCorpusScope } from '../shared/local-query-api'

/** CLI 侧没有联系人列表，范围说明只能是通用文案（生产由 UI 提供带名字的 label）。 */
const describePocScope = (scope: QueryCorpusScope): string => {
  if (scope.kind === 'all') return '所有聊天记录'
  if (scope.kind === 'groups') return '群聊专属（全部群聊）'
  return scope.kind === 'contact' ? '单聊专属（指定联系人）' : '当前会话'
}

const baseUrl = (process.env.TRACEMEMO_QUERY_API_BASE || 'http://127.0.0.1:6131/api/v1').replace(/\/+$/, '')
const invocation = parsePocInvocation(process.argv.slice(2))

async function callQueryApi(name: string, input: Record<string, unknown>): Promise<QueryAgentToolResult> {
  const paths: Record<string, string> = {
    query_messages: '/query/messages',
    search_messages: '/query/search',
    message_context: '/query/message-context',
    conversation_overview: '/query/conversation-overview'
  }
  const path = paths[name]
  if (!path) throw new Error(`不允许的工具: ${name}`)
  const token = apiTokenStore.getTokenForAuthentication()
  if (!token) throw new Error('Local Query API Token 不可用')
  const response = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(input) })
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>
  const status = typeof payload.status === 'string' ? payload.status : 'execution_failed'
  return { ...payload, status }
}

/**
 * CLI 的 Tool Executor：与生产的进程内 executor 等价 —— 语料边界由 Host 注入请求，
 * LLM 无法提供它。两者只差 transport（这里走 HTTP，生产走进程内调用）。
 */
const executePocTool = (
  name: string,
  input: Record<string, unknown>,
  context?: { conversationScope?: unknown }
): Promise<QueryAgentToolResult> =>
  callQueryApi(
    name,
    context?.conversationScope ? { ...input, scope: context.conversationScope } : input
  )

async function main(): Promise<void> {
  await app.whenReady()
  if (invocation.kind === 'tool') {
    // 裸工具诊断：直接调 Local Query API，用来在没有 GUI 的情况下审计引擎侧真实数据。
    const toolResult = await callQueryApi(invocation.toolName, invocation.args)
    process.stdout.write(`${JSON.stringify(toolResult, null, 2)}\n`)
    app.quit()
    return
  }
  const provider = new AIProviderService()
  const service = new QueryAgentService(provider, executePocTool)
  const result = await service.run(invocation.question, {
    ...(invocation.scope ? { conversationScope: { scope: invocation.scope, label: describePocScope(invocation.scope) } } : {})
  })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  // 诊断摘要写 stderr，保持 stdout 仍是纯 JSON，方便管道与脚本消费。
  process.stderr.write(formatTiming(result))
  process.stderr.write(formatProviderDiagnostics(result, provider.getRuntimeEndpointHost()))
  app.quit()
}

void main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`)
  app.quit()
})
