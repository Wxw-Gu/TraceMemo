export type ReportHeat = '高' | '中' | '低'
export type ReportMode = 'compact' | 'full'

import type { ReportTemplateRequestId } from './report-templates'
import type { ReportTemplateRef } from './report-template-package'

export const selectHeroParticipantNames = (names: string[]): string[] =>
  Array.from(new Set(names.map((name) => name.trim()).filter(Boolean))).slice(0, 4)

/**
 * 群成员快照里可以用来关联报告显示名的全部别名。
 *
 * 报告里的显示名取决于 `memberNameMode`（默认是**群昵称**），而快照的 `nickname`
 * 字段是 `wechatNickname || groupNickname || username`。一个成员同时有微信昵称与群昵称、
 * 且两者不同时，只按 `nickname` 建索引会**全部对不上** —— 头像 enrichment 会静默失效，
 * 用户看到的就是首字 fallback。
 */
export const REPORT_AVATAR_ALIAS_FIELDS = [
  'nickname',
  'groupNickname',
  'wechatNickname',
  'remark',
  'wxid'
] as const

export interface ReportAvatarMember {
  wxid: string
  nickname?: string
  groupNickname?: string
  wechatNickname?: string
  remark?: string
  avatar?: string
}

/**
 * 建立「显示名别名 → 头像 URL」索引：每个成员的所有可用显示名都指向同一头像。
 * 同名先到先得（P2 风险：群里两人同名）。
 */
export const buildReportAvatarAliasIndex = (
  members: readonly ReportAvatarMember[]
): Map<string, string> => {
  const index = new Map<string, string>()
  for (const member of members) {
    if (!member.avatar) continue
    for (const field of REPORT_AVATAR_ALIAS_FIELDS) {
      const name = String(member[field] || '').trim()
      if (name && !index.has(name)) index.set(name, member.avatar)
    }
  }
  return index
}

/**
 * 把别名索引合并进 `metadata.avatars`，返回实际补充的条数。
 * 调用方已经给出的有效头像一律保留，绝不被快照覆盖。
 */
export const mergeReportAvatars = (
  avatars: Record<string, string | undefined>,
  index: ReadonlyMap<string, string>
): number => {
  let filled = 0
  for (const [name, url] of index) {
    if (avatars[name]) continue
    avatars[name] = url
    filled += 1
  }
  return filled
}

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
  /** v1 是默认经典模板，v2 仅保留旧调用兼容；另有五套新版产品模板。 */
  templateId?: ReportTemplateRequestId
  /** 外部模板只允许传 ID + 可选版本，由主进程 registry 解析入口路径。 */
  templateRef?: ReportTemplateRef
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

/**
 * 旧版历史日报没有保存 GroupDailyReport 时，从已生成 HTML 提取的模板占位值。
 * values 中的卡片字段是本地日报已经转义/渲染好的 HTML，只用于本地模板重排版。
 */
export interface GroupReportRenderSnapshot {
  groupName: string
  reportDate: string
  values: Record<string, string>
}

export interface GroupReportRenderSnapshotExportRequest {
  snapshot: GroupReportRenderSnapshot
  templateId?: ReportTemplateRequestId
  templateRef?: ReportTemplateRef
}
