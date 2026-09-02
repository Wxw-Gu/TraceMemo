import type { KnowledgeRuntimeStatus } from '../../../../shared/knowledge'
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

export const knowledgeStateLabel = (status: KnowledgeRuntimeStatus | null): string => {
  if (!status) return '读取中'
  return {
    unavailable: '未建立',
    building: '建立中',
    syncing: '增量同步',
    ready: '已同步',
    error: '异常'
  }[status.state]
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
