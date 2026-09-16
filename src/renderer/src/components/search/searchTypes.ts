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
  /**
   * 命中所依赖的派生来源。
   *
   * `image_ocr` = 这条结果靠**图片里的文字**命中，而不是群友真的发了一条文字消息。
   * 有值时 Evidence 卡片显示轻量来源标记（「图片文字」）。
   */
  derivedSource?: 'image_ocr'
  /** 「从图片里读出来的文字」片段，只作命中解释。 */
  imageOcrText?: string
  contact: Contact
  message: Message
  /**
   * 稳定消息引用（opaque，可还原成 `{conversationId, messageId}`）。
   *
   * 只靠「会话 + 秒级时间戳」无法定位到**这一条**消息 —— 同一秒可能有多条，
   * 而且时间戳只能定位到"附近"。Archive 的跳转优先用它。
   * 老缓存记录 / Legacy 路径可能没有它，所以必须是可选的。
   */
  messageRef?: string
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
  /**
   * 跳转到证据的原聊天。
   *
   * 传整条 EvidenceItem 而不是 `(contact, createTime)`：后者丢掉了稳定身份（messageRef），
   * 跳转只能靠"会话 + 秒级时间戳"猜，而会话 id 若来自展示层合成的 key 则完全跳不过去。
   */
  onOpenEvidence: (evidence: EvidenceItem) => void
  onOpenAISettings: () => void
  onNotice: (message: string) => void
}
