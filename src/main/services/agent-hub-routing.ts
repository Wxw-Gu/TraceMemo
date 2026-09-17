/**
 * Agent Hub 入站文本的**纯路由**：无 LLM、无副作用、可单测。
 * 明确的产物 / 群成员分析 / 会话列表请求各走确定性 Action，其余一律进 Query Agent Runtime。
 *
 * **"总结" 不等于 Report**：只有同时提到"群"与明确产物才触发 Report Action。
 * 查询类问题直接进 Query Agent，不做意图分类 —— 避免"先分类一次 LLM、再查询一次 LLM"。
 */
import type { AskWechatQueryResult } from '../../shared/query-agent'

export interface GroupReportIntent {
  group: string
  range: 'today' | 'yesterday' | '7days'
}

export interface GroupMemberChatIntent {
  group: string
  member: string
  range: 'today' | 'yesterday' | '7days'
  days: number
  goal: string
}

export type InboundRoute =
  | { kind: 'report_action'; intent: GroupReportIntent }
  | { kind: 'group_member_action'; intent: GroupMemberChatIntent }
  | { kind: 'recent_list'; limit: number }
  | { kind: 'knowledge_query' }

/**
 * Report Action 快捷匹配。
 *
 * 必须同时满足：提到"群" + 提到明确的**产物**（图片 / 长图 / 日报 / 报告）。
 * 只提到"总结"不算 —— 那是 Query Agent 的 conversation_overview 场景。
 */
export function matchGroupReportIntent(text: string): GroupReportIntent | null {
  const normalized = text.trim()
  if (!normalized.includes('群') || !/(图片|长图|日报|报告)/.test(normalized)) return null
  const range = /(7天|七天|一周)/.test(normalized)
    ? '7days'
    : /(昨天|昨日)/.test(normalized)
      ? 'yesterday'
      : 'today'
  const group = normalized
    .replace(
      /请|帮我|生成|做一份|做个|今天的|今日的|今天|今日|昨天的|昨日的|昨天|昨日|最近7天的|最近七天的|最近7天|最近七天|近7天的|近七天的|近7天|近七天|消息|聊天记录|聊天|群聊总结|群总结|群日报|群报告|总结|日报|报告|图片|长图/g,
      ''
    )
    .replace(/[，。！？?：:]/g, '')
    .trim()
    .replace(/成$/, '')
    .replace(/群$/, '')
    .trim()
  return group ? { group, range } : null
}

/** 群成员专用分析的快捷匹配（保留为 Action：它有自己的 goal 与输出形态）。 */
export function matchGroupMemberChatIntent(text: string): GroupMemberChatIntent | null {
  const normalized = text.trim().replace(/[，。！？?：:]/g, '')
  const timePattern = '(今天|今日|昨天|昨日|最近\\d{1,2}天|近\\d{1,2}天|最近|近来|这几天)'
  const actionPattern = '(?:说了什么|聊了什么|发言|说过什么|都聊什么|都说什么|干了什么)'
  const patterns = [
    new RegExp(
      `(?:看一下|看看|看下|查一下|总结一下)?(.+?群(?:聊)?)[\\s，,]+(.+?)${timePattern}${actionPattern}`
    ),
    new RegExp(
      `(?:看一下|看看|看下|查一下|总结一下)?(.+?群(?:聊)?)(?:里|中的)(.+?)${timePattern}${actionPattern}`
    )
  ]
  for (const pattern of patterns) {
    const match = normalized.match(pattern)
    if (match?.[1]?.trim() && match[2]?.trim()) {
      const range = /昨天|昨日/.test(match[3] || '')
        ? 'yesterday'
        : /今天|今日/.test(match[3] || '')
          ? 'today'
          : '7days'
      const days = Math.max(1, Math.min(30, Number((match[3] || '').match(/\d{1,2}/)?.[0]) || 7))
      return {
        group: match[1].trim(),
        member: match[2].trim(),
        range,
        days,
        goal: normalized
      }
    }
  }
  return null
}

/**
 * 「列出会话」的**形态标记**：用户在问"有哪些 / 和谁 / 列表 / 最近 N 条"，
 * 而不是在问"聊了什么内容"。
 */
const RECENT_LIST_SHAPE = /(哪些|哪个|都有谁|都跟谁|和谁|跟谁|是谁|列表|名单|\d{1,2}(条|个|位))/
/** 名单类问题必须落到会话 / 联系人这个对象上。 */
const RECENT_LIST_TARGET = /(聊天|会话|联系人|好友|人|群|消息|窗口)/
/** 「和谁 / 跟谁」问法本身就在问会话对象，不要求额外载体词。 */
const RECENT_PEER_QUESTION = /(和谁|跟谁)/
/** 内容探针：问的是消息里的内容 / 是否提到某事物 —— 必须交给 Query Agent。 */
const RECENT_CONTENT_PROBE =
  /(提到|提过|说过|说啥|说什么|说了什么|聊了啥|聊了什么|都聊什么|都说什么|什么话题|聊到|讨论|内容|讲了什么|哪条|哪一句|有没有|是否)/

/**
 * "最近有哪些会话"类请求。
 *
 * 这是**确定性能力**（列出会话），不是消息内容查询 —— Query Agent 无法表达，
 * 因此保留为不经过模型的无 LLM 快捷路径。
 *
 * 判定必须**正向**：只有用户确实在要一份"会话 / 联系人名单"时才算 recent_list。
 * 早先的实现只要求「最近」+「消息|会话|聊天」同时出现，于是
 * 「最近群里聊的消息里有没有提到报价？」这类**内容查询**会被截走，
 * 直接回一串会话名，用户永远得不到答案。
 */
export function matchRecentChatIntent(text: string): number | null {
  const normalized = text.replace(/\s+/g, '')
  if (!normalized.includes('最近')) return null

  // 内容探针优先排除：问"有没有提到 X / 谁提过 X / 聊了什么"是在查消息内容，不是要名单。
  if (RECENT_CONTENT_PROBE.test(normalized)) return null

  /**
   * 只有两种形态算"要最近会话列表"：
   * 1) 「和谁 / 跟谁」问法 —— 它本身就在问会话对象，不需要额外的载体词
   *    （如「最近和谁聊过」）；
   * 2) 名单形态 + 会话载体 —— 如「最近有哪些聊天」「最近 5 个会话」「最近3条消息」。
   *
   * 两种都不满足时交给 Query Agent：形状不像"要名单"的，就是在问内容。
   */
  const listLike =
    RECENT_PEER_QUESTION.test(normalized) ||
    (RECENT_LIST_SHAPE.test(normalized) && RECENT_LIST_TARGET.test(normalized))
  if (!listLike) return null

  const limit = Number(normalized.match(/\d{1,2}/)?.[0] || 5)
  return Math.max(1, Math.min(20, limit))
}

export function resolveInboundRoute(text: string): InboundRoute {
  const report = matchGroupReportIntent(text)
  if (report) return { kind: 'report_action', intent: report }
  const member = matchGroupMemberChatIntent(text)
  if (member) return { kind: 'group_member_action', intent: member }
  const recent = matchRecentChatIntent(text)
  if (recent !== null) return { kind: 'recent_list', limit: recent }
  return { kind: 'knowledge_query' }
}

/** 查询大脑不可用时的统一文案（不暴露 stack / provider raw response / 内部 id）。 */
export const QUERY_AGENT_UNAVAILABLE_TEXT = '当前 AI 查询服务暂时不可用，请稍后再试。'

/**
 * 把 Query Agent 结果映射成**微信文字回复**。
 * 只输出用户可读文本；Tool trace / temporalBasis / Evidence / 诊断字段一律不下发。
 */
export function queryAgentReplyText(result: AskWechatQueryResult): string {
  if (result.status === 'answered') return result.answer
  if (result.status === 'provider_unavailable' || result.status === 'error') return result.message
  // Agent Hub 没有 Legacy runner，不会产生 legacy 结果；真出现时按服务不可用处理，不暴露内部结构。
  return QUERY_AGENT_UNAVAILABLE_TEXT
}
