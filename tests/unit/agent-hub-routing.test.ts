import { describe, expect, it } from 'vitest'
import {
  matchGroupReportIntent,
  matchRecentChatIntent,
  queryAgentReplyText,
  QUERY_AGENT_UNAVAILABLE_TEXT,
  resolveInboundRoute
} from '../../src/main/services/agent-hub-routing'
import type { AskWechatQueryResult } from '../../src/shared/query-agent'

describe('Agent Hub 入站路由 — Query / Action 分流', () => {
  it('A. 「TraceMemo 交流群最近聊了啥」→ Query Agent（不是 report）', () => {
    expect(resolveInboundRoute('TraceMemo 交流群最近聊了啥')).toEqual({ kind: 'knowledge_query' })
  })

  it('B. 「总结一下 TraceMemo 交流群最近聊了什么」→ Query Agent（"总结"不等于 report）', () => {
    expect(resolveInboundRoute('总结一下 TraceMemo 交流群最近聊了什么')).toEqual({
      kind: 'knowledge_query'
    })
  })

  it('B2. 「总结」缺少产物词时，report 快捷匹配不成立', () => {
    expect(matchGroupReportIntent('总结一下这个群最近聊了什么')).toBeNull()
    expect(matchGroupReportIntent('帮我总结一下 TraceMemo 交流群的近期内容')).toBeNull()
  })

  it('C. 「生成 TraceMemo 交流群今天的群聊总结图片」→ Report Action（图片）', () => {
    const route = resolveInboundRoute('生成 TraceMemo 交流群今天的群聊总结图片')
    expect(route.kind).toBe('report_action')
    if (route.kind !== 'report_action') throw new Error('unreachable')
    expect(route.intent.group).toContain('TraceMemo')
    expect(route.intent.range).toBe('today')
  })

  it('D. 「帮我做一份 TraceMemo 交流群今日日报」→ Report Action（日报）', () => {
    const route = resolveInboundRoute('帮我做一份 TraceMemo 交流群今日日报')
    expect(route.kind).toBe('report_action')
    if (route.kind !== 'report_action') throw new Error('unreachable')
    expect(route.intent.group).toContain('TraceMemo')
  })

  it('D2. 群 + 时间但不要产物 → Query Agent', () => {
    expect(resolveInboundRoute('TraceMemo 交流群昨天聊了啥')).toEqual({ kind: 'knowledge_query' })
  })

  it('E. 「BOBO 最近说过什么」→ Query Agent', () => {
    expect(resolveInboundRoute('BOBO 最近说过什么')).toEqual({ kind: 'knowledge_query' })
  })

  it('F. 「我和 BOBO 第一次聊了什么」→ Query Agent', () => {
    expect(resolveInboundRoute('我和 BOBO 第一次聊了什么')).toEqual({ kind: 'knowledge_query' })
  })

  it('G. 群成员分析仍是专用 Action', () => {
    const route = resolveInboundRoute('看看 TraceMemo交流群里 BOBO 最近说了什么')
    expect(route.kind).toBe('group_member_action')
    if (route.kind !== 'group_member_action') throw new Error('unreachable')
    expect(route.intent.member).toBe('BOBO')
    expect(route.intent.group).toContain('TraceMemo')
  })

  it('H. 会话列表是确定性快捷路径（不经过模型）', () => {
    expect(resolveInboundRoute('最近有哪些会话')).toEqual({ kind: 'recent_list', limit: 5 })
    expect(resolveInboundRoute('最近3条消息')).toEqual({ kind: 'recent_list', limit: 3 })
  })
})

/**
 * recent_list 的判定必须**正向**：只有用户确实在要"会话 / 联系人名单"时才算。
 * 早先只要求「最近」+「消息|会话|聊天」同时出现，于是内容查询被截走 —— 用户问
 * "最近…里有没有提到 X"，得到的却是一串会话名。
 */
describe('Agent Hub 入站路由 — recent_list 边界', () => {
  const cases: Array<[string, string, string]> = [
    ['最近有哪些聊天', 'recent_list', '名单形态 + 聊天载体'],
    ['最近有哪些会话', 'recent_list', '名单形态 + 会话载体'],
    ['最近和谁聊过', 'recent_list', '「和谁」问法本身就在问会话对象'],
    ['最近聊过哪些人', 'recent_list', '名单形态 + 人'],
    ['最近 5 个会话', 'recent_list', '数量 + 载体'],
    ['最近群里聊的消息里有没有提到报价', 'knowledge_query', '内容探针：有没有提到'],
    ['最近聊天里谁提过健身', 'knowledge_query', '内容探针：谁提过'],
    ['最近消息里有没有说过报价', 'knowledge_query', '内容探针：有没有说过'],
    ['技术交流群今天主要聊了什么', 'knowledge_query', '没有「最近」，不是名单请求'],
    ['生成技术交流群日报', 'report_action', '明确产物优先'],
    ['微信里最近发生了什么', 'knowledge_query', '不是名单形态'],
    ['总结一下 TraceMemo 交流群最近聊了什么', 'knowledge_query', '总结 ≠ 名单，且是内容探针']
  ]

  for (const [text, expected, why] of cases) {
    it(`「${text}」→ ${expected}（${why}）`, () => {
      expect(resolveInboundRoute(text).kind).toBe(expected)
    })
  }

  it('recent_list 只保留实际存在的会话数量上限语义', () => {
    // 无数字时默认 5；有数字时取该数字，并夹在 1..20。
    expect(matchRecentChatIntent('最近和谁聊过')).toBe(5)
    expect(matchRecentChatIntent('最近12个会话')).toBe(12)
    expect(matchRecentChatIntent('最近99个会话')).toBe(20)
    // 不是名单请求 → 不命中
    expect(matchRecentChatIntent('最近聊天里谁提过健身')).toBeNull()
  })
})

describe('Agent Hub 回复文案映射', () => {
  const diagnostics = {
    entry: 'agent-hub' as const,
    provider: 'P',
    model: 'm',
    modelCallCount: 2,
    toolCallCount: 1,
    tools: ['query_messages'],
    totalMs: 10,
    outcome: 'answered' as const
  }

  it('answered → 直接用 Query Agent 的文本回答', () => {
    expect(
      queryAgentReplyText({
        engine: 'query-agent',
        status: 'answered',
        answer: '最近聊了两件事。',
        diagnostics
      })
    ).toBe('最近聊了两件事。')
  })

  it('provider_unavailable / error → 使用安全文案', () => {
    const unavailable: AskWechatQueryResult = {
      engine: 'query-agent',
      status: 'provider_unavailable',
      message: '当前 AI 查询服务暂时不可用，请稍后再试。',
      diagnostics: { ...diagnostics, outcome: 'provider_failure' }
    }
    expect(queryAgentReplyText(unavailable)).toBe('当前 AI 查询服务暂时不可用，请稍后再试。')

    const error: AskWechatQueryResult = {
      engine: 'query-agent',
      status: 'error',
      message: '本次查询没有完成，请稍后再试或换一种问法。',
      diagnostics: { ...diagnostics, outcome: 'runtime_error' }
    }
    expect(queryAgentReplyText(error)).toBe('本次查询没有完成，请稍后再试或换一种问法。')
  })

  it('legacy 结果不会出现在 Agent Hub 路径上，兜底为服务不可用文案', () => {
    const legacy: AskWechatQueryResult = {
      engine: 'legacy',
      status: 'legacy',
      reason: 'runtime_error',
      result: {} as never
    }
    expect(queryAgentReplyText(legacy)).toBe(QUERY_AGENT_UNAVAILABLE_TEXT)
  })
})
