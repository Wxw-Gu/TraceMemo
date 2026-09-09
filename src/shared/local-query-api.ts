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
