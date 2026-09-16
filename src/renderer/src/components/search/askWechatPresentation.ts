import type { AskWechatEvidenceItem, AskWechatStats } from '../../../../shared/query-agent'
import {
  decodeMessageRef,
  type CanonicalMessageIdentity
} from '../../../../shared/local-query-api'
import type { Contact } from '../../../../shared/types'
import { formatEvidenceTimestamp } from './searchFormatters'
import type { EvidenceItem } from './searchTypes'

/**
 * Query Agent 的展示映射。
 *
 * - 证据来自 Runtime 收集的**真实** Tool 结果，不从 answer 文本反解析；
 * - 顶部统计使用真实执行数字（读取条数 / 证据条数 / 模型调用 / 耗时），
 *   不使用"知识库已收录"这类只有部分 Tool 才成立的文案。
 */

const SOURCE_LABELS: Record<string, string> = {
  query_messages: '精确读取',
  search_messages: '关键词检索',
  conversation_overview: '会话概览',
  message_context: '上下文'
}

const SCOPE_LABELS: Record<string, string> = {
  all: '所有聊天记录',
  groups: '群聊专属',
  contact: '单聊专属',
  current: '当前会话'
}

/**
 * 证据卡片的会话归属：群消息必须显示**群名**，而不是把所有群消息都归成"群聊"。
 *
 * `contact.md5` 必须是**真实会话 id**：合成 key（如 `query-agent:<群名>`）选不中任何会话，
 * 「跳转到原聊天」只能停在档案首页。真实 id 只能从 `messageRef` 里还原
 * （展示契约里刻意不含 md5 字段）；`messageRef` 缺失或解析失败时退化成合成 key，
 * 并且调用方必须按"无法定位"处理。
 */
function evidenceContact(item: AskWechatEvidenceItem, anchor: CanonicalMessageIdentity | null): Contact {
  const name = item.conversationName?.trim() || '未命名会话'
  const type = item.conversationType === 'group' ? 'group' : 'user'
  if (anchor) {
    return { md5: anchor.conversationId, m_nsUsrName: anchor.conversationId, m_nsNickName: name, type }
  }
  return { md5: `query-agent:${item.conversationName || 'unknown'}`, m_nsUsrName: '', m_nsNickName: name, type }
}

export function mapAskWechatEvidence(items: AskWechatEvidenceItem[]): EvidenceItem[] {
  return items.map((item, index) => {
    const anchor = decodeMessageRef(item.messageRef)
    return {
      evidenceId: `E${index + 1}`,
      sourceKind: item.messageType as EvidenceItem['sourceKind'],
      // 「靠图片里的文字命中」是来源语义，必须原样带到 UI；
      // 但 authoritative source 仍然是原始图片消息（messageRef 已指向它）。
      ...(item.derivedSource ? { derivedSource: item.derivedSource } : {}),
      ...(item.imageOcrText ? { imageOcrText: item.imageOcrText } : {}),
      contact: evidenceContact(item, anchor),
      messageRef: item.messageRef,
      message: {
        // message 的 id 用**可读的消息 id**（不是 opaque ref）：Archive 的高亮
        // 是按 `message.id === jumpTargetMessageId` 匹配的，两边必须是同一个值。
        // 解析不出身份时退化成 messageRef —— 它至少保证列表 key 唯一。
        id: anchor?.messageId || item.messageRef,
        from: 'user',
        type: '检索消息',
        datetime: formatEvidenceTimestamp(item.timestamp || 0),
        content: item.text || '',
        isSender: item.sender === '我',
        name: item.sender,
        createTime: Math.floor((item.timestamp || 0) / 1000)
      }
    }
  })
}

/**
 * 顶部统计文案。
 * 按实际用到的 Tool 组合描述，例如：
 * - query_messages：`读取 20 条消息 · 使用 20 条证据`
 * - search/overview：`命中 12 条相关消息` / `覆盖 1200 条消息 · 使用 60 条证据`
 */
export function formatAskWechatStats(stats: AskWechatStats): string[] {
  const chips: string[] = []
  const scopeLabel = stats.scope
    ? stats.scope.label || SCOPE_LABELS[stats.scope.kind] || '当前范围'
    : '当前范围'
  chips.push(`${scopeLabel}内查询`)
  const { reads, tools } = stats
  if (tools.includes('query_messages') && reads.messageCount > 0) {
    chips.push(`读取 ${reads.messageCount} 条消息`)
  }
  if (tools.includes('conversation_overview') && reads.overviewSourceCount > 0) {
    chips.push(`覆盖 ${reads.overviewSourceCount} 条消息`)
  }
  if (reads.evidenceCount > 0) {
    chips.push(`使用 ${reads.evidenceCount} 条证据`)
  } else if (reads.matchedCount > 0) {
    chips.push(`命中 ${reads.matchedCount} 条相关消息`)
  }
  chips.push(`${stats.modelCallCount} 次模型调用`)
  chips.push(formatMs(stats.totalMs))
  return chips
}

export function askWechatToolLabels(tools: string[]): string[] {
  return Array.from(new Set(tools)).map((tool) => SOURCE_LABELS[tool] || tool)
}

function formatMs(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 ms'
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`
}
