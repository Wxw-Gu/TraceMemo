export type ReportHeat = '高' | '中' | '低'
export type ReportMode = 'compact' | 'full'

export const selectHeroParticipantNames = (names: string[]): string[] =>
  Array.from(new Set(names.map((name) => name.trim()).filter(Boolean))).slice(0, 4)

export type ReportSectionKey =
  | 'hero'
  | 'topics'
  | 'importantMessages'
  | 'actions'
  | 'moments'
  | 'analytics'
  | 'keywords'
  | 'resources'
  | 'qa'
  | 'storylines'
  | 'reversals'
  | 'gallery'
  | 'vision'
  | 'voices'
  | 'badges'
  | 'chains'

export interface ReportSectionMeta {
  enabled: boolean
  importance: number
  confidence: number
  totalCount: number
  displayedCount: number
  hiddenCount?: number
}

export interface ReportTopicConclusion {
  text: string
  sourceMessageIds?: string[]
}

export interface ReportTopic {
  title: string
  timeRange: string
  heat: ReportHeat
  participants: string[]
  summary: string
  conclusion?: string
  conclusions?: ReportTopicConclusion[]
  keywords: string[]
  sourceMessageIds?: string[]
  image?: {
    imageUrl?: string
    note: string
    sourceMessageIds?: string[]
    /** AI 图片识别缓存 key(由 visionGallery 提供,main 渲染时按此取 base64) */
    imageHash?: string
    /** AI 真实识别的描述(来自 ImageInsight.description) */
    aiDescription?: string
  } | null
}

export interface ReportResource {
  title: string
  description: string
  sender?: string
  sourceMessageIds?: string[]
}

export interface ReportImportantMessage {
  sender: string
  time: string
  content: string
  note: string
  sourceMessageIds?: string[]
  importance?: number
  confidence?: number
}

export interface ReportQuoteMessage {
  sender: string
  content: string
  sourceMessageId?: string
}

export interface ReportQuote {
  messages: ReportQuoteMessage[]
  note: string
  sourceMessageIds?: string[]
  importance?: number
  confidence?: number
}

export interface ReportQuestionAnswer {
  question: string
  answer: string
  answerer?: string
  sourceMessageIds?: string[]
}

export interface ReportTopicHeat {
  topic: string
  score: number
}

export interface ReportSpeakerRank {
  name: string
  count: number
}

export interface ReportHero {
  headline: string
  summary: string
  keyTakeaway?: string
  pendingNote?: string
  statusLine?: string
}

export interface ReportMediaGalleryItem {
  sender: string
  time: string
  imageUrl: string
  note: string
  stats?: string
  inferenceLabel?: string
  sourceMessageIds?: string[]
  replyCount?: number
}

/**
 * 图片 AI 理解结果(由 ImageInsightService 提供)。
 * 与 ReportMediaGalleryItem 不同:本类型不含 imageUrl(由 main 渲染时按需注入),
 * description 是 AI 真实识别的结果(非基于上下文的推断)。
 */
export interface ReportVisionGalleryItem {
  messageId: string
  imageHash: string
  sender: string
  time: string
  description: string
  ocrText?: string
  tags: string[]
  category: 'screenshot' | 'photo' | 'meme' | 'document' | 'chart' | 'other'
  importance: 'low' | 'medium' | 'high'
  sourceMessageIds?: string[]
  /** 预加载好的 dataURL,render 时直接嵌进 HTML */
  imageUrl?: string
}

export interface ReportVoiceHighlight {
  title: string
  sender: string
  note: string
  sourceMessageIds?: string[]
}

export interface ReportVoiceLeaderboardItem {
  sender: string
  count: number
  durationSec: number
}

export interface ReportFunBadge {
  title: string
  owner: string
  note: string
}

export interface ReportTodoItem {
  task: string
  owner?: string | null
  deadline?: string | null
  topic?: string | null
  note?: string
  sourceMessageIds?: string[]
  importance?: number
  confidence?: number
}

export interface ReportUnresolvedItem {
  question: string
  owner?: string
  status: '待跟进' | '暂未回答' | '进行中'
  note: string
  lastDiscussedAt?: string | null
  sourceMessageIds?: string[]
  importance?: number
  confidence?: number
}

export interface ReportStorylineStage {
  time: string
  event: string
  sourceMessageIds?: string[]
}

export interface ReportStoryline {
  title: string
  stages: ReportStorylineStage[]
  result?: string
  sourceMessageIds?: string[]
}

export interface ReportReversal {
  topic: string
  initialView: string
  finalView: string
  note?: string
  sourceMessageIds?: string[]
}

export interface ReportParticipantChain {
  topic: string
  chain: string[]
  note?: string
  sourceMessageIds?: string[]
}

export interface ReportSummaryStats {
  messageCount: number
  activeUsers: number
  topicCount: number
  mediaCount: number
  imageCount: number
  voiceCount: number
  stickerCount: number
  conclusionCount: number
  todoCount: number
  unresolvedCount: number
}

export interface GroupDailyReport {
  overview: string
  mode?: ReportMode
  hero?: ReportHero
  topics: ReportTopic[]
  resources: ReportResource[]
  importantMessages: ReportImportantMessage[]
  quotes: ReportQuote[]
  qa: ReportQuestionAnswer[]
  todos: ReportTodoItem[]
  unresolved: ReportUnresolvedItem[]
  storylines: ReportStoryline[]
  reversals: ReportReversal[]
  participantChains: ReportParticipantChain[]
  analytics: {
    topicHeat: ReportTopicHeat[]
    activeTimeline: string
    topSpeakers: ReportSpeakerRank[]
    voiceLeaderboard: ReportVoiceLeaderboardItem[]
  }
  keywords: string[]
  media: {
    gallery: ReportMediaGalleryItem[]
    /** AI 识别的图片(由 ImageInsightService 提供),渲染时由 main 按 imageHash 取原图 */
    visionGallery?: ReportVisionGalleryItem[]
    voiceHighlights: ReportVoiceHighlight[]
    funBadges: ReportFunBadge[]
  }
  summaryStats?: ReportSummaryStats
  sectionMeta?: Partial<Record<ReportSectionKey, ReportSectionMeta>>
}

export interface GroupReportMetadata {
  groupName: string
  reportDate: string
  dateRange: string
  messageCount: number
  activeUsers: number
  imageCount?: number
  voiceCount?: number
  stickerCount?: number
  mediaMessageCount?: number
  timeSpan: string
  generatedAt: string
  recordNote: string
  footerNote: string
  heroParticipants: string[]
  avatars: Record<string, string | undefined>
  reportMode?: ReportMode
  talker?: string
  timeRange?: string
  warnings?: string[]
}

export interface GroupReportExportRequest {
  report: GroupDailyReport
  metadata: GroupReportMetadata
  /** 模板 ID:'v1' 经典 / 'v2' 当前。缺省或未知值用默认(v2) */
  templateId?: 'v1' | 'v2'
}

export interface GroupReportExportResult {
  success: boolean
  htmlPath?: string
  pngPath?: string
  imageDataUrl?: string
  exportTimings?: {
    html?: {
      startedAt: string
      endedAt: string
      duration: number
    }
    png?: {
      startedAt: string
      endedAt: string
      duration: number
    }
  }
  warnings?: string[]
  error?: string
}
