import './app-data-bootstrap'
import { app } from 'electron'
import { apiTokenStore } from './api-token-store'
import { AIProviderService } from './services/ai-provider-service'
import { QueryAgentPocService, type QueryAgentToolResult } from './services/query-agent-poc-service'
import { parsePocQuestion } from './query-agent-poc-cli'
import { formatProviderDiagnostics, formatTiming } from './query-agent-poc-report'

const baseUrl = (process.env.TRACEMEMO_QUERY_API_BASE || 'http://127.0.0.1:6131/api/v1').replace(/\/+$/, '')
const question = parsePocQuestion(process.argv.slice(2))

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

async function main(): Promise<void> {
  await app.whenReady()
  const provider = new AIProviderService()
  const service = new QueryAgentPocService(provider, callQueryApi)
  const result = await service.run(question)
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
