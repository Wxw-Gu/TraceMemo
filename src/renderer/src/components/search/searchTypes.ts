import type { AIRuntimeModelConfig } from '../../../../shared/ai-provider'
import type {
  AiSearchAggregation,
  AiSearchAgentRun,
  AiSearchPipelineTimings,
  AiSearchProgressEvent,
  AiSearchProgressStage
} from '../../../../shared/ai-search'
import type { KnowledgeMessageKind, KnowledgeVoiceCoverage } from '../../../../shared/knowledge'
import type { Contact, Message } from '../../../../shared/types'

export type SearchStage = 'idle' | 'loading' | 'result' | 'partial' | 'insufficient'
export type SearchScope = 'global' | 'groups' | 'contacts' | 'conversation'
export type SearchRange = 'today' | '7d' | '30d' | 'all'
export type SearchIntent = 'general' | 'topic' | 'participants' | 'mixed'

export interface SearchTrace {
  knowledgeMessages: number
  retrievedEvidence: number
  finalEvidence: number
  timings: AiSearchPipelineTimings
  contextEvidence: number
  inputTokens?: number
  inputTokensEstimated: boolean
  aggregation: AiSearchAggregation
  invalidCitationIds: string[]
  agent: AiSearchAgentRun
  voiceCoverage?: KnowledgeVoiceCoverage
}

export type SearchProgressByStage = Partial<Record<AiSearchProgressStage, AiSearchProgressEvent>>

export interface EvidenceItem {
  /** Program-owned Final Evidence ID. Cached legacy records may omit it. */
  evidenceId?: string
  sourceKind?: KnowledgeMessageKind
  contact: Contact
  message: Message
}

export interface AISearchCacheRecord {
  version: 3
  key: string
  createdAt: number
  answer: string
  evidence: EvidenceItem[]
  /** Same-request browse collection; old cache records may not contain it. */
  evidenceCollection?: EvidenceItem[]
  senderNames: Record<string, string>
  messageCount: number
}

export interface GroupMemberName {
  wxid: string
  nickname?: string
  groupNickname?: string
  remark?: string
  wechatNickname?: string
}

export interface SenderDirectory {
  displayNames: Record<string, string>
  aliases: Record<string, string[]>
}

export interface SearchQueryPlan {
  intent: SearchIntent
  keywords: string[]
  variants: string[]
  source: 'local' | 'ai' | 'hybrid'
}

export interface SearchPassSummary {
  label: string
  keywords: string[]
  messageCount: number
}

export interface AISearchWorkspaceProps {
  contacts: Contact[]
  selectedContact: Contact | null
  dbReady: boolean
  aiModelConfig: AIRuntimeModelConfig
  onSelectContact: (contact: Contact) => void
  onOpenEvidence: (contact: Contact, createTime?: number) => void
  onOpenAISettings: () => void
  onNotice: (message: string) => void
}
