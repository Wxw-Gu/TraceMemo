import { describe, expect, it } from 'vitest'
import {
  matchGroupReportIntent,
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
