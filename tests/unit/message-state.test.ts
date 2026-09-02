// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '../../src/shared/types'
import {
  buildMessageGroups,
  formatMessageTime
} from '../../src/renderer/src/components/chat/messageGrouping'
import {
  buildSearchCacheKey,
  parseSearchCacheKey,
  readSearchCache,
  writeSearchCache
} from '../../src/renderer/src/components/search/searchUtils'

const message = (id: string, createTime: number, from = 'user'): Message => ({
  id,
  from,
  type: '文本',
  datetime: new Date(createTime * 1000).toISOString(),
  content: id,
  isSender: from === 'assistant',
  senderId: from,
  createTime
})

describe('message grouping and dates', () => {
  it('groups adjacent messages but keeps system and distant messages separate', () => {
    const groups = buildMessageGroups([
      message('one', 1000),
      message('two', 1060),
      { ...message('system', 1070, 'system'), type: '系统消息' },
      message('three', 2000)
    ])
    expect(groups.map((group) => group.messages.map((item) => item.id))).toEqual([
      ['one', 'two'],
      ['system'],
      ['three']
    ])
  })

  it('formats today and yesterday deterministically', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-01T12:00:00+08:00'))
    expect(
      formatMessageTime(
        message('today', Math.floor(Date.parse('2026-08-01T10:00:00+08:00') / 1000))
      )
    ).toContain('今天')
    expect(
      formatMessageTime(
        message('yesterday', Math.floor(Date.parse('2026-07-31T10:00:00+08:00') / 1000))
      )
    ).toContain('昨天')
    vi.useRealTimers()
  })
})

describe('search cache', () => {
  beforeEach(() => {
    const values = new Map<string, string>()
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        clear: () => values.clear(),
        getItem: (key: string) => values.get(key) ?? null,
        removeItem: (key: string) => values.delete(key),
        setItem: (key: string, value: string) => values.set(key, String(value))
      }
    })
  })

  it('normalizes the key and survives invalid persisted state', () => {
    const key = buildSearchCacheKey('global', '', '7d', '  Windows 性能  ')
    expect(parseSearchCacheKey(key)).toMatchObject({ query: 'windows 性能', range: '7d' })
    localStorage.setItem('wxe_ai_search_cache_v1', '{broken')
    expect(readSearchCache(key)).toBeNull()
  })

  it('writes and reads an isolated cache record', () => {
    const key = buildSearchCacheKey('conversation', 'fixture-contact', 'today', '图片')
    const record = {
      version: 3 as const,
      key,
      query: '图片',
      answer: '固定假回答',
      evidence: [],
      createdAt: 1
    }
    writeSearchCache(record)
    expect(readSearchCache(key)).toMatchObject({ answer: '固定假回答' })
  })
})
