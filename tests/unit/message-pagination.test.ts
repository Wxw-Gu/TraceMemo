import { describe, expect, it } from 'vitest'
import type { Message } from '../../src/shared/types'
import { mergeMessagePages } from '../../src/renderer/src/utils/message-pages'

const makeMessage = (id: string, createTime: number): Message => ({
  id,
  from: 'user',
  type: '文本',
  datetime: new Date(createTime * 1000).toISOString(),
  content: id,
  isSender: false,
  createTime
})

describe('message pagination', () => {
  it('sorts older pages and removes overlapping records', () => {
    const merged = mergeMessagePages(
      [makeMessage('oldest', 1), makeMessage('overlap', 2)],
      [makeMessage('overlap', 2), makeMessage('latest', 3)]
    )
    expect(merged.map((message) => message.id)).toEqual(['oldest', 'overlap', 'latest'])
  })

  it('keeps cross-year pages continuous through the earliest fixture record', () => {
    const page2025 = [makeMessage('2025', 1_735_689_600), makeMessage('2026', 1_767_225_600)]
    const page2017 = [makeMessage('2017', 1_483_228_800), makeMessage('2025', 1_735_689_600)]

    const merged = mergeMessagePages(page2017, page2025)

    expect(merged.map((message) => message.id)).toEqual(['2017', '2025', '2026'])
    expect(new Set(merged.map((message) => message.id)).size).toBe(merged.length)
  })
})
