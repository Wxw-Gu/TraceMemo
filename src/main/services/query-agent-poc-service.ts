import type { AIChatToolCall, AIChatToolDefinition } from './ai-provider-service'
import { LOCAL_QUERY_TOOL_DEFINITIONS } from '../../shared/local-query-api'

const MAX_TOOL_CALLS = 5
const FORBIDDEN_INPUT_KEYS = new Set(['apiKey', 'authorization', 'token', 'databasePath', 'sql', 'wxid', 'md5'])

interface ToolSchema {
  type?: string
  required?: string[]
  additionalProperties?: boolean
  properties?: Record<string, ToolSchema>
  items?: ToolSchema
  enum?: unknown[]
  minLength?: number
  minimum?: number
  maximum?: number
  minItems?: number
  maxItems?: number
}

export interface ToolArgumentValidationError {
  status: 'invalid_tool_arguments'
  field: string
  constraint: string
  expected?: unknown
  actual?: unknown
  [key: string]: unknown
}

export interface QueryAgentProvider {
  getRuntimeConfig(): { configured: boolean; providerName: string; model: string; modelName: string }
  chatWithTools(
    messages: Array<Record<string, unknown>>,
    tools: AIChatToolDefinition[]
  ): Promise<{ success: boolean; data?: string; toolCalls?: AIChatToolCall[]; usage?: { input?: number; output?: number; total?: number; estimated?: boolean }; error?: string }>
}

export interface QueryAgentToolResult {
  status: string
  [key: string]: unknown
}

export interface QueryAgentTraceItem {
  toolName: string
  input: Record<string, unknown>
  durationMs: number
  status: string
  resultCount?: number
  evidenceCount?: number
}

export interface QueryAgentPocResult {
  question: string
  provider: string
  model: string
  modelCallCount: number
  toolCallCount: number
  firstModelMs?: number
  toolTotalMs: number
  finalModelMs?: number
  totalMs: number
  traces: QueryAgentTraceItem[]
  answer?: string
  error?: string
}

export type QueryAgentToolExecutor = (
  name: string,
  input: Record<string, unknown>
) => Promise<QueryAgentToolResult>

const SYSTEM_PROMPT = `你是 TraceMemo 的本地聊天查询助手。你只能使用提供的四个 Query Tool 获取事实。
Tool 返回的是事实来源。不得编造未返回的消息、猜测联系人、修改 resolvedTimeRange，或把 partial/unknown 当作 complete。不得把 sampled Evidence 当作完整聊天。
当 coverage complete 且结果为 0 时，可以说明当前可读取的完整范围没有找到；当 coverage partial/unknown 且结果为 0 时，必须说明无法确认绝对不存在。
缺少必要信息时直接用自然语言澄清；超出工具能力时说明不能可靠完成，并给出当前工具可以执行的替代方向。最终回答只基于工具结果。`

function toolDefinitions(): AIChatToolDefinition[] {
  return LOCAL_QUERY_TOOL_DEFINITIONS.map((tool) => ({
    type: 'function' as const,
    function: { name: tool.name, description: tool.description, parameters: tool.parameters }
  }))
}

function sanitizeInput(input: Record<string, unknown>): Record<string, unknown> {
  const sanitizeValue = (value: unknown): unknown => {
    if (typeof value === 'string') return value.length > 240 ? `${value.slice(0, 240)}...` : value
    if (Array.isArray(value)) return value.slice(0, 8).map(sanitizeValue)
    if (value && typeof value === 'object') return sanitizeInput(value as Record<string, unknown>)
    return value
  }
  const output: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (key === 'messageRef') output[key] = '[opaque-message-ref]'
    else if (!FORBIDDEN_INPUT_KEYS.has(key)) output[key] = sanitizeValue(value)
  }
  return output
}

function containsForbiddenKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenKey)
  if (!value || typeof value !== 'object') return false
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => FORBIDDEN_INPUT_KEYS.has(key) || containsForbiddenKey(child))
}

function actualType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function schemaTypeMatches(value: unknown, type: string): boolean {
  if (type === 'object') return Boolean(value && typeof value === 'object' && !Array.isArray(value))
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value)
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  return actualType(value) === type
}

function validateSchema(value: unknown, schema: ToolSchema, field = '$'): ToolArgumentValidationError | undefined {
  if (schema.type && !schemaTypeMatches(value, schema.type)) {
    return { status: 'invalid_tool_arguments', field, constraint: 'type', expected: schema.type, actual: actualType(value) }
  }
  if (schema.enum && !schema.enum.some((allowed) => Object.is(allowed, value))) {
    return { status: 'invalid_tool_arguments', field, constraint: 'enum', expected: schema.enum, actual: value }
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      return { status: 'invalid_tool_arguments', field, constraint: 'minLength', expected: schema.minLength, actual: value.length }
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      return { status: 'invalid_tool_arguments', field, constraint: 'minimum', expected: schema.minimum, actual: value }
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      return { status: 'invalid_tool_arguments', field, constraint: 'maximum', expected: schema.maximum, actual: value }
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      return { status: 'invalid_tool_arguments', field, constraint: 'minItems', expected: schema.minItems, actual: value.length }
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      return { status: 'invalid_tool_arguments', field, constraint: 'maxItems', expected: schema.maxItems, actual: value.length }
    }
    if (schema.items) {
      for (let index = 0; index < value.length; index += 1) {
        const error = validateSchema(value[index], schema.items, `${field}[${index}]`)
        if (error) return error
      }
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const objectValue = value as Record<string, unknown>
    for (const required of schema.required || []) {
      if (!(required in objectValue)) {
        return { status: 'invalid_tool_arguments', field: field === '$' ? required : `${field}.${required}`, constraint: 'required', expected: true, actual: false }
      }
    }
    const properties = schema.properties || {}
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(objectValue)) {
        if (!(key in properties)) {
          return { status: 'invalid_tool_arguments', field: field === '$' ? key : `${field}.${key}`, constraint: 'additionalProperties', expected: false, actual: true }
        }
      }
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (key in objectValue) {
        const error = validateSchema(objectValue[key], childSchema, field === '$' ? key : `${field}.${key}`)
        if (error) return error
      }
    }
  }
  return undefined
}

export function validateToolArguments(name: string, value: unknown): { input?: Record<string, unknown>; error?: ToolArgumentValidationError } {
  const definition = LOCAL_QUERY_TOOL_DEFINITIONS.find((tool) => tool.name === name)
  if (!definition) return { error: { status: 'invalid_tool_arguments', field: '$', constraint: 'tool', expected: 'supported tool', actual: name } }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: { status: 'invalid_tool_arguments', field: '$', constraint: 'type', expected: 'object', actual: actualType(value) } }
  }
  if (containsForbiddenKey(value)) {
    return { error: { status: 'invalid_tool_arguments', field: '$', constraint: 'forbidden_field' } }
  }
  const error = validateSchema(value, definition.parameters as ToolSchema)
  return error ? { error } : { input: value as Record<string, unknown> }
}

function resultCount(result: QueryAgentToolResult): { resultCount?: number; evidenceCount?: number } {
  return {
    resultCount: typeof result.returnedCount === 'number' ? result.returnedCount : undefined,
    evidenceCount: typeof result.evidenceCount === 'number' ? result.evidenceCount : Array.isArray(result.evidence) ? result.evidence.length : undefined
  }
}

export class QueryAgentPocService {
  constructor(private readonly provider: QueryAgentProvider, private readonly executeTool: QueryAgentToolExecutor) {}

  async run(question: string): Promise<QueryAgentPocResult> {
    const trimmed = question.trim()
    const startedAt = Date.now()
    const runtime = this.provider.getRuntimeConfig()
    const result: QueryAgentPocResult = { question: trimmed, provider: runtime.providerName, model: runtime.modelName || runtime.model, modelCallCount: 0, toolCallCount: 0, toolTotalMs: 0, totalMs: 0, traces: [] }
    if (!trimmed) return { ...result, error: '请输入查询问题', totalMs: Date.now() - startedAt }
    if (!runtime.configured) return { ...result, error: '当前 AI Provider 尚未配置', totalMs: Date.now() - startedAt }

    const messages: Array<Record<string, unknown>> = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: trimmed }
    ]
    const tools = toolDefinitions()
    let firstModelAt: number | undefined
    let finalModelDuration: number | undefined
    while (result.toolCallCount < MAX_TOOL_CALLS) {
      const modelStartedAt = Date.now()
      const model = await this.provider.chatWithTools(messages, tools)
      result.modelCallCount += 1
      const modelDuration = Date.now() - modelStartedAt
      if (firstModelAt === undefined) firstModelAt = Date.now()
      if (!model.success) return { ...result, error: model.error || '模型调用失败', firstModelMs: firstModelAt - startedAt, totalMs: Date.now() - startedAt }
      const calls = model.toolCalls || []
      if (calls.length === 0) {
        finalModelDuration = modelDuration
        result.answer = model.data?.trim() || '模型未返回答案'
        result.firstModelMs = firstModelAt - startedAt
        result.finalModelMs = finalModelDuration
        result.totalMs = Date.now() - startedAt
        return result
      }
      if (result.toolCallCount + calls.length > MAX_TOOL_CALLS) {
        return { ...result, error: `超过最大工具调用次数（${MAX_TOOL_CALLS}）`, firstModelMs: firstModelAt - startedAt, totalMs: Date.now() - startedAt }
      }
      messages.push({ role: 'assistant', content: model.data || '', tool_calls: calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) })
      for (const call of calls) {
        const inputStartedAt = Date.now()
        let toolResult: QueryAgentToolResult | undefined
        let traceInput: Record<string, unknown> = {}
        try {
          let parsed: unknown
          try { parsed = JSON.parse(call.arguments || '{}') } catch {
            toolResult = { status: 'invalid_tool_arguments', field: '$', constraint: 'json' }
          }
          if (!toolResult) {
            const validated = validateToolArguments(call.name, parsed)
            if (validated.error) {
              toolResult = validated.error
            } else {
              traceInput = validated.input || {}
              toolResult = await this.executeTool(call.name, traceInput)
            }
          }
        } catch (error) {
          if (!toolResult) toolResult = { status: 'invalid_request', error: error instanceof Error ? error.message : '工具调用失败' }
        }
        const completedToolResult = toolResult || { status: 'invalid_request', error: '工具调用失败' }
        const durationMs = Date.now() - inputStartedAt
        result.toolCallCount += 1
        result.toolTotalMs += durationMs
        const counts = resultCount(completedToolResult)
        result.traces.push({ toolName: call.name, input: sanitizeInput(traceInput), durationMs, status: completedToolResult.status, ...counts })
        messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: JSON.stringify(completedToolResult) })
      }
    }
    result.firstModelMs = firstModelAt ? firstModelAt - startedAt : undefined
    result.totalMs = Date.now() - startedAt
    return { ...result, error: `超过最大工具调用次数（${MAX_TOOL_CALLS}）` }
  }
}
