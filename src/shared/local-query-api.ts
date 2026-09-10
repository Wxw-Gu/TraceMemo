import type { KnowledgeEvidence, KnowledgeVoiceCoverage } from './knowledge'

export type QueryDirection = 'any' | 'from_target' | 'to_target'
export type QueryOrder = 'asc' | 'desc'
export type QueryMessageType =
  | 'text'
  | 'image'
  | 'voice'
  | 'video'
  | 'file'
  | 'link'
  | 'sticker'
  | 'system'
  | 'other'
export interface LocalQueryToolDefinition {
  name: 'query_messages' | 'search_messages' | 'message_context' | 'conversation_overview'
  description: string
  parameters: Record<string, unknown>
}
const targetSchema = { type: 'object', properties: { query: { type: 'string', minLength: 1 } }, required: ['query'], additionalProperties: false }
// LLM-facing 绝对时间契约：只接受带时区偏移的 ISO-8601 字符串，避免 epoch 单位歧义。
// Local Query API 内部仍使用 epoch seconds（见 QueryTimeRange），由 Host Adapter 负责转换。
const timeRangeSchema = {
  type: 'object',
  properties: {
    kind: { enum: ['all', 'today', 'yesterday', 'this_week', 'last_7_days', 'this_month', 'previous_month', 'this_year', 'previous_year', 'absolute'] },
    startTime: { type: 'string', minLength: 1, description: '仅 kind=absolute 时必填。带时区偏移的 ISO-8601 字符串，例如 2026-08-01T00:00:00+08:00 或 2026-07-31T16:00:00Z。不接受 epoch 数字，也不接受无时区的裸本地时间。' },
    endTime: { type: 'string', minLength: 1, description: '仅 kind=absolute 时必填。含义与格式同 startTime，且不得早于 startTime。' }
  },
  required: ['kind'],
  additionalProperties: false
}
export const LOCAL_QUERY_TOOL_DEFINITIONS: LocalQueryToolDefinition[] = [
  { name: 'query_messages', description: '精确读取符合联系人、时间、方向、消息类型、顺序等结构条件的消息；适合具体事实和 earliest/latest 等时间边界查询，边界查询使用 order 与 limit。若结果为 0 且条件明显不合适，可再查一次并合理扩大或更换条件，但条件必须与上一次实质不同。', parameters: { type: 'object', required: ['target', 'timeRange'], additionalProperties: false, properties: { target: targetSchema, timeRange: timeRangeSchema, direction: { enum: ['any', 'from_target', 'to_target'] }, messageTypes: { type: 'array', items: { enum: ['text', 'image', 'voice', 'video', 'file', 'link', 'sticker', 'system', 'other'] } }, order: { enum: ['asc', 'desc'] }, limit: { type: 'integer', minimum: 1, maximum: 200 }, excludeSystem: { type: 'boolean' } } } },
  { name: 'search_messages', description: '在指定联系人和时间范围内做关键词检索并返回相关 Evidence。queries 的每一项都是一次独立的字面检索：一项只放一个简短关键词，不要把多个近义词或整句话放进同一项，也不要指望一项内部被拆词理解。首次最多 4 项；只有在本次检索完全没有 Evidence 时，才允许再检索一次，且每一项都必须与上一次实质不同。', parameters: { type: 'object', required: ['target', 'timeRange', 'queries'], additionalProperties: false, properties: { target: targetSchema, timeRange: timeRangeSchema, queries: { type: 'array', description: '独立检索项列表，每项一个简短关键词，最多 4 项；每一项单独检索，不会组合成一句话理解。', minItems: 1, maxItems: 4, items: { type: 'string', minLength: 1 } }, limit: { type: 'integer', minimum: 1, maximum: 200 } } } },
  { name: 'message_context', description: '补充已找到的单条有价值 Evidence 的前后消息；仅在该 Evidence 缺少语境、无法判断含义时使用，不是默认确认步骤。', parameters: { type: 'object', required: ['messageRef'], additionalProperties: false, properties: { messageRef: { type: 'string', minLength: 1 }, before: { type: 'integer', minimum: 0, maximum: 50 }, after: { type: 'integer', minimum: 0, maximum: 50 } } } },
  { name: 'conversation_overview', description: '提取指定联系人和时间范围的整体聊天覆盖样本；只用于 broad summary，不是语义搜索 fallback，也不能确定 earliest/latest 等精确时间边界。', parameters: { type: 'object', required: ['target', 'timeRange'], additionalProperties: false, properties: { target: targetSchema, timeRange: timeRangeSchema } } }
]
export type QueryTimeRange =
  | { kind: 'all' | 'today' | 'yesterday' | 'this_week' | 'last_7_days' | 'this_month' | 'previous_month' | 'this_year' | 'previous_year' }
  | { kind: 'absolute'; startTime?: number; endTime?: number }
export interface QueryTarget { query: string }
export interface ResolvedTimeRange { kind: QueryTimeRange['kind']; startTime?: number; endTime?: number; label: string }
export interface QueryMessagesRequest {
  target: QueryTarget
  timeRange: QueryTimeRange
  direction?: QueryDirection
  messageTypes?: QueryMessageType[]
  order?: QueryOrder
  limit?: number
  excludeSystem?: boolean
}
export interface QueryMessage {
  messageRef: string
  timestamp: number
  datetime: string
  sender: string
  direction: 'from_target' | 'to_target'
  messageType: QueryMessageType
  sourceKind: QueryMessageType
  text?: string
  attachment?: {
    kind: Exclude<QueryMessageType, 'text' | 'voice' | 'system' | 'other' | 'link'>
    name?: string
    url?: string
    sizeBytes?: number
  }
}
export interface QueryMessagesResponse {
  status: string
  target?: { displayName: string; type: 'user' | 'group' }
  query?: Omit<QueryMessagesRequest, 'target' | 'timeRange'> & { resolvedTimeRange: ResolvedTimeRange }
  coverage?: { state: 'complete' | 'partial' | 'unknown' }
  returnedCount?: number
  messages?: QueryMessage[]
  candidates?: Array<{ displayName: string; type: 'user' | 'group' }>
}
export interface SearchMessagesRequest {
  target: QueryTarget
  timeRange: QueryTimeRange
  query: string
  variants?: string[]
  limit?: number
}
export interface SearchMessagesResponse {
  status: string
  target?: { displayName: string; type: 'user' | 'group' }
  resolvedTimeRange?: ResolvedTimeRange
  coverage?: { state: 'complete' | 'partial' | 'unknown' }
  probeCount?: number
  evidenceCount?: number
  evidence?: Array<Pick<KnowledgeEvidence, 'timestamp' | 'sender' | 'sourceKind' | 'text'> & { messageRef: string }>
  candidates?: Array<{ displayName: string; type: 'user' | 'group' }>
}
export interface MessageContextRequest { messageRef: string; before?: number; after?: number }
export interface MessageContextResponse {
  status: string
  anchor?: QueryMessage
  before?: QueryMessage[]
  after?: QueryMessage[]
}
export interface ConversationOverviewRequest { target: QueryTarget; timeRange: QueryTimeRange }
export interface ConversationOverviewResponse {
  status: string
  target?: { displayName: string; type: 'user' | 'group' }
  resolvedTimeRange?: ResolvedTimeRange
  coverage?: { state: 'complete' | 'partial' | 'unknown' }
  sourceMessageCount?: number
  evidenceCount?: number
  sourceCoverage?: { state: 'complete' | 'partial' | 'unknown'; sourceMessageCount: number }
  selection?: { mode: 'temporal_coverage'; selectedEvidenceCount: number; sampled: boolean }
  voiceCoverage?: KnowledgeVoiceCoverage
  evidence?: Array<Pick<KnowledgeEvidence, 'timestamp' | 'sender' | 'sourceKind' | 'text'> & { messageRef: string }>
  candidates?: Array<{ displayName: string; type: 'user' | 'group' }>
}
export interface QueryCapabilitiesResponse {
  version: 1
  tools: Record<string, { operation: string; directions?: QueryDirection[]; messageTypes?: QueryMessageType[]; timeRanges: QueryTimeRange['kind'][]; limitMax?: number }>
}
