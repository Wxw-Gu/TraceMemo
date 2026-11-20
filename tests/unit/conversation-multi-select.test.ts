import { describe, expect, it } from 'vitest'
import {
  filterConversationOptions,
  formatConversationCount,
  sortConversationOptions,
  summarizeSelection,
  type ConversationSelectOption
} from '../../src/renderer/src/components/search/ConversationMultiSelect'
import { buildSearchCacheKey } from '../../src/renderer/src/components/search/searchUtils'

const option = (
  conversationId: string,
  name: string,
  messageCount: number | null,
  extra: Partial<ConversationSelectOption> = {}
): ConversationSelectOption => ({
  conversationId,
  name,
  type: 'group',
  messageCount,
  approximate: false,
  countMeasured: messageCount !== null,
  lastActiveAt: null,
  keywords: '',
  ...extra
})

const OPTIONS: ConversationSelectOption[] = [
  option('c-family', '家庭群', 38_201, { type: 'user', lastActiveAt: 3 }),
  option('c-work', '工作项目群', 187_526, { lastActiveAt: 2 }),
  option('c-product', '产品交流群', 96_812, { keywords: '产品 老张 wxid_fixture_member' }),
  option('c-test', '测试群', 13_405),
  option('c-chat', '闲聊群', 1_248, { lastActiveAt: 9 }),
  option('c-unknown', '刚建的群', null)
]

describe('conversation option sorting', () => {
  it('默认按消息数从多到少，未知数量排在最后', () => {
    const sorted = sortConversationOptions(OPTIONS, 'messages-desc')
    expect(sorted.map((item) => item.conversationId)).toEqual([
      'c-work',
      'c-product',
      'c-family',
      'c-test',
      'c-chat',
      'c-unknown'
    ])
  })

  it('升序时未知数量仍在最后，不会被当成 0 排到最前', () => {
    const sorted = sortConversationOptions(OPTIONS, 'messages-asc')
    expect(sorted.map((item) => item.conversationId)).toEqual([
      'c-chat',
      'c-test',
      'c-family',
      'c-product',
      'c-work',
      'c-unknown'
    ])
  })

  it('最近活跃与名称排序都稳定', () => {
    expect(sortConversationOptions(OPTIONS, 'recent')[0].conversationId).toBe('c-chat')
    const byName = sortConversationOptions(OPTIONS, 'name').map((item) => item.name)
    expect(byName).toEqual([...byName].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')))
  })

  it('同数量时按名称做二级排序，结果与输入顺序无关', () => {
    const same = [option('b', '乙群', 10), option('a', '甲群', 10)]
    const forward = sortConversationOptions(same, 'messages-desc').map((item) => item.name)
    const reversed = sortConversationOptions([...same].reverse(), 'messages-desc').map(
      (item) => item.name
    )
    expect(forward).toEqual(reversed)
  })
})

describe('conversation option filtering', () => {
  it('能用中文群名、备注或 wxid 搜到会话', () => {
    expect(filterConversationOptions(OPTIONS, { query: '产品' })).toHaveLength(1)
    expect(filterConversationOptions(OPTIONS, { query: '老张' })[0].conversationId).toBe(
      'c-product'
    )
    expect(filterConversationOptions(OPTIONS, { query: 'wxid_fixture_member' })[0].conversationId).toBe(
      'c-product'
    )
  })

  it('按类型和「仅已选」过滤，且搜索不会改变选择集合', () => {
    expect(
      filterConversationOptions(OPTIONS, { typeFilter: 'user' }).map((item) => item.conversationId)
    ).toEqual(['c-family'])
    expect(
      filterConversationOptions(OPTIONS, {
        onlySelected: true,
        selectedIds: ['c-work', 'c-chat']
      }).map((item) => item.conversationId)
    ).toEqual(['c-work', 'c-chat'])
  })

  it('统计中与统计失败显示不同文案，且都不会变成 0', () => {
    expect(formatConversationCount(null, false, false)).toBe('统计中')
    expect(formatConversationCount(null, false, true)).toBe('未知')
    expect(formatConversationCount(0, false, true)).toBe('0')
    expect(formatConversationCount(12_345, true, true)).toBe('≥ 12,345')
  })

  it('未知数量不计入合计，但会被单独计数', () => {
    const summary = summarizeSelection(OPTIONS, ['c-work', 'c-unknown'])
    expect(summary.conversations).toBe(2)
    expect(summary.messages).toBe(187_526)
    expect(summary.unknownCount).toBe(1)
  })
})

describe('search cache key carries scope identity', () => {
  it('不同会话集合生成不同缓存键，避免命中别的范围', () => {
    const base = buildSearchCacheKey('selected', '', 'all', '最近聊了什么', undefined, undefined, 'a,b')
    const other = buildSearchCacheKey('selected', '', 'all', '最近聊了什么', undefined, undefined, 'a,c')
    expect(base).not.toBe(other)
    // 集合相同但顺序不同 → 同一个键（范围身份与顺序无关）。
    const reordered = buildSearchCacheKey(
      'selected',
      '',
      'all',
      '最近聊了什么',
      undefined,
      undefined,
      'b,a'
    )
    expect(reordered).toBe(base)
  })

  it('没有选择集合时保持旧格式，不影响既有缓存', () => {
    const legacy = buildSearchCacheKey('global', '', '30d', 'hello')
    expect(JSON.parse(legacy)).toEqual(['global', '', '30d', 'hello'])
  })
})
