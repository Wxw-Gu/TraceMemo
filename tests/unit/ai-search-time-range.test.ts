import { describe, expect, it } from 'vitest'
import {
  buildLocalAiSearchPlan,
  includesExplicitAiSearchAlias,
  inferAiSearchTimeRange
} from '../../src/shared/ai-search'

const NOW = new Date('2026-08-05T12:00:00+08:00')

describe('AI search natural-language time ranges', () => {
  it('tightens an all-history selection when the user says 最近', () => {
    expect(inferAiSearchTimeRange('我和张三最近聊了什么？', 'all', NOW)).toMatchObject({
      label: '近 30 天',
      source: 'query',
      startTime: Math.floor(NOW.getTime() / 1000) - 30 * 86400
    })
  })

  it('recognizes explicit recent days and the current year', () => {
    expect(inferAiSearchTimeRange('我和张三最近三天聊了什么？', 'all', NOW)).toMatchObject({
      label: '近 3 天',
      source: 'query'
    })
    expect(inferAiSearchTimeRange('我和张三今年聊了什么？', 'all', NOW)).toMatchObject({
      label: '今年',
      startTime: Math.floor(new Date(2026, 0, 1).getTime() / 1000)
    })
  })

  it('keeps an explicit user retry override above the word 最近 in the original question', () => {
    expect(
      inferAiSearchTimeRange('我和张三最近聊了什么？', 'all', NOW, {
        label: '全部历史',
        reason: '用户主动扩大到全部历史',
        source: 'user_retry'
      })
    ).toMatchObject({
      label: '全部历史',
      source: 'user_retry'
    })
  })

  it('keeps an explicit UI range above the generic word 最近', () => {
    expect(
      inferAiSearchTimeRange('我和张三最近聊了什么？', '7d', NOW, {
        startTime: Math.floor(NOW.getTime() / 1000) - 7 * 86400,
        endTime: undefined,
        label: '近 7 天',
        reason: '用户在界面选择的时间范围',
        source: 'user_selected'
      })
    ).toMatchObject({
      label: '近 7 天',
      source: 'user_selected',
      startTime: Math.floor(NOW.getTime() / 1000) - 7 * 86400
    })
  })

  it('classifies a direct person recap as conversation_recall rather than a topic FTS query', () => {
    expect(buildLocalAiSearchPlan('我和张三最近聊了什么？')).toMatchObject({
      intent: 'conversation_recall',
      contactQuery: '张三'
    })
  })

  it('keeps identity and message topic separate for a contact topic search', () => {
    expect(buildLocalAiSearchPlan('我和张三最近聊过健身吗？')).toMatchObject({
      intent: 'conversation_topic_search',
      contactQuery: '张三',
      topicQuery: '健身',
      keywords: ['健身']
    })
  })

  it('classifies global topics and bare conversation names without turning names into FTS terms', () => {
    expect(buildLocalAiSearchPlan('最近谁聊过 MCP？')).toMatchObject({
      intent: 'global_topic_search',
      topicQuery: 'MCP',
      keywords: ['MCP']
    })
    expect(buildLocalAiSearchPlan('技术交流群')).toMatchObject({
      intent: 'conversation_name_search',
      contactQuery: '技术交流群',
      topicQuery: undefined
    })
    expect(buildLocalAiSearchPlan('技术交流群最近说了什么')).toMatchObject({
      intent: 'conversation_name_search',
      contactQuery: '技术交流群',
      topicQuery: undefined
    })
    expect(buildLocalAiSearchPlan('技术交流群最近聊了啥')).toMatchObject({
      intent: 'conversation_name_search',
      contactQuery: '技术交流群',
      topicQuery: undefined
    })
  })

  it('matches an explicitly mentioned nickname when the user omits punctuation', () => {
    expect(includesExplicitAiSearchAlias('我和中田健身弘毅最近聊了什么？', '中田健身-弘毅')).toBe(
      true
    )
  })
})
