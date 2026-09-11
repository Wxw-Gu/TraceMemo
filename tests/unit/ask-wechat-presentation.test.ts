import { describe, expect, it } from 'vitest'
import {
  askWechatToolLabels,
  formatAskWechatStats,
  mapAskWechatEvidence
} from '../../src/renderer/src/components/search/askWechatPresentation'
import type { AskWechatStats } from '../../src/shared/query-agent'

const stats = (patch: Partial<AskWechatStats> = {}): AskWechatStats => ({
  tools: ['query_messages'],
  reads: { messageCount: 0, matchedCount: 0, overviewSourceCount: 0, evidenceCount: 0 },
  scope: { kind: 'all', label: '所有聊天记录' },
  modelCallCount: 2,
  toolCallCount: 1,
  totalMs: 3343,
  ...patch
})

describe('mapAskWechatEvidence', () => {
  it('群消息证据保留群名与成员，且不泄露 md5', () => {
    const [item] = mapAskWechatEvidence([
      {
        messageRef: 'ref-1',
        conversationName: 'TraceMemo 交流群',
        conversationType: 'group',
        sender: '张三',
        timestamp: 1_787_650_302_000,
        messageType: 'text',
        text: '最近重新开始健身了',
        source: 'search_messages'
      }
    ])
    expect(item.evidenceId).toBe('E1')
    expect(item.contact.m_nsNickName).toBe('TraceMemo 交流群')
    expect(item.contact.type).toBe('group')
    expect(item.message.name).toBe('张三')
    expect(item.message.content).toBe('最近重新开始健身了')
    expect(item.message.createTime).toBe(1_787_650_302)
    expect(item.contact.md5).not.toMatch(/^[0-9a-f]{32}$/)
  })

  it('缺少群名时给出可读回退，而不是把群消息归成"群聊"', () => {
    const [item] = mapAskWechatEvidence([{ messageRef: 'ref-2', source: 'conversation_overview' }])
    expect(item.contact.m_nsNickName).toBe('未命名会话')
  })
})

describe('formatAskWechatStats', () => {
  it('query_messages：读取条数 + 证据条数 + 模型调用 + 耗时', () => {
    const chips = formatAskWechatStats(
      stats({
        tools: ['query_messages'],
        reads: { messageCount: 20, matchedCount: 0, overviewSourceCount: 0, evidenceCount: 20 }
      })
    )
    expect(chips).toContain('所有聊天记录内查询')
    expect(chips).toContain('读取 20 条消息')
    expect(chips).toContain('使用 20 条证据')
    expect(chips).toContain('2 次模型调用')
    expect(chips).toContain('3.3 s')
  })

  it('overview：覆盖源消息 + 代表证据；search 无证据时说明命中为 0 的事实', () => {
    const overview = formatAskWechatStats(
      stats({
        tools: ['conversation_overview'],
        scope: { kind: 'current', label: '当前会话：TraceMemo 交流群' },
        reads: { messageCount: 0, matchedCount: 0, overviewSourceCount: 1200, evidenceCount: 60 }
      })
    )
    expect(overview).toContain('当前会话：TraceMemo 交流群内查询')
    expect(overview).toContain('覆盖 1200 条消息')
    expect(overview).toContain('使用 60 条证据')

    const search = formatAskWechatStats(
      stats({
        tools: ['search_messages'],
        scope: { kind: 'groups', label: '群聊专属' },
        reads: { messageCount: 0, matchedCount: 12, overviewSourceCount: 0, evidenceCount: 0 }
      })
    )
    expect(search).toContain('命中 12 条相关消息')
    expect(search.some((chip) => chip.includes('知识库已收录'))).toBe(false)
  })
})

describe('askWechatToolLabels', () => {
  it('把 Tool 名映射成中文能力标签并去重', () => {
    expect(askWechatToolLabels(['query_messages', 'search_messages', 'search_messages'])).toEqual([
      '精确读取',
      '关键词检索'
    ])
  })
})
