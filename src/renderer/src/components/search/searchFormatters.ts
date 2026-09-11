import type { KnowledgeRuntimeStatus } from '../../../../shared/knowledge'
import { isKnowledgeFresh } from '../../../../shared/knowledge'
import type { Contact } from '../../../../shared/types'
import type { SearchTrace } from './searchTypes'

export const formatBytes = (bytes: number): string => {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`
}

export const formatDuration = (milliseconds: number): string =>
  milliseconds >= 1000 ? `${(milliseconds / 1000).toFixed(1)}s` : `${milliseconds}ms`

export const formatMeasuredDuration = (milliseconds: number | undefined): string =>
  milliseconds === undefined ? '未测量' : formatDuration(milliseconds)

export const formatEvidenceTimestamp = (timestamp: number): string =>
  new Date(timestamp).toLocaleString('zh-CN', { hour12: false })

/** 只显示到日期，用于「索引更新至 8/26」这类如实口径。 */
export const formatIndexDate = (timestamp: number): string =>
  new Date(timestamp).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })

/**
 * 知识库状态文案。
 *
 * 两个**互相独立**的维度：
 * 1. 新鲜度：索引覆盖到源数据的哪个时刻 → `indexLatestAt` / `sourceLatestAt`
 * 2. 这一遍 pass 的进度 → `pass.phase` / `pass.cancellable`
 *
 * 约束：
 * - 只要索引还能查，文案必须是「可用 · …」；
 * - **绝不**在没有 pending gap 之前说「已同步」；
 * - 「正在追新」与「正在补齐历史」必须分开（前者只补新消息，后者在建库）。
 */
export const knowledgeStateLabel = (status: KnowledgeRuntimeStatus | null): string => {
  if (!status) return '读取中'
  const phase = status.pass?.phase
  const usable = status.indexedMessageCount > 0 || status.indexedChunkCount > 0
  if (status.state === 'error' || phase === 'error') return usable ? '可用 · 更新失败' : '更新失败'
  if (status.state === 'cancelled' || phase === 'cancelled')
    return usable ? '可用 · 同步已取消' : '同步已取消'
  // 一个分片都没有：这不是"落后"，是"还没建立"，不该带"可用"前缀。
  // `unavailable` 必须在这里被吃掉：派生库不可查询时，残留的历史计数不能让它
  // 冒充「可用 · 已追至最新」（那是两句真话拼成的假话）。
  if (status.state === 'unavailable' || !usable) {
    return status.state === 'building' ? '正在建立' : '未建立'
  }
  if (status.state === 'building') return '可用 · 正在补齐历史'
  if (status.state === 'syncing') {
    // 已经有分片还在跑：`full`（首次建库）与 `backfill`（补历史缺口）都不算"追新"，
    // 只有 `catchup`（读 delta 追最新）才是用户最关心、也最快的那个阶段。
    return phase === 'full' || phase === 'backfill' ? '可用 · 正在补齐历史' : '可用 · 正在追新'
  }
  if (isKnowledgeFresh(status) === true) return '可用 · 已追至最新'
  // ready 但落后、且当前没有 pass 在跑 = 有内容还没追到，但需要用户触发同步。
  return '可用 · 待追新'
}

/** 索引落后于源数据时为 true，用于卡片描述与详情行。 */
export const knowledgeIsStale = (status: KnowledgeRuntimeStatus | null): boolean =>
  Boolean(status) && status!.state === 'ready' && isKnowledgeFresh(status!) === false

/**
 * 「已处理」这类计数必须带分母或者换成诚实语义：只有分母未知的绝对值会把"这一遍扫描"
 * 说成"总量"。这里优先给分母；没有分母时退回**明确标注为单轮**的语义。
 */
export const formatKnowledgeProcessed = (status: KnowledgeRuntimeStatus): string => {
  if (status.pass) {
    const { indexedMessages, scannedMessages } = status.pass
    return `本轮新增索引 ${indexedMessages.toLocaleString()} 条 · 本轮已扫描 ${scannedMessages.toLocaleString()} 条`
  }
  if (status.totalMessages) {
    const percent = Math.min(
      100,
      Math.round((status.processedMessages / status.totalMessages) * 100)
    )
    return `${percent}%（${status.processedMessages.toLocaleString()} / ${status.totalMessages.toLocaleString()}）`
  }
  return `本轮已处理 ${status.processedMessages.toLocaleString()} 条`
}

export const contactLabel = (contact: Contact | null | undefined): string =>
  contact?.m_nsNickName ||
  contact?.remark ||
  contact?.wechatNickname ||
  contact?.m_nsUsrName ||
  '未选择会话'

export const formatSearchTraceOverview = (
  trace: SearchTrace
): {
  totalDuration: string
  knowledgeDuration: string
  aiDuration: string
  contextEvidence: string
} => ({
  totalDuration: formatDuration(trace.timings.totalMs),
  knowledgeDuration: formatDuration(trace.timings.knowledgeSearchMs),
  aiDuration: formatDuration(trace.timings.aiGenerationMs),
  contextEvidence: `${trace.contextEvidence} 条`
})
