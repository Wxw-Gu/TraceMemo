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
})
