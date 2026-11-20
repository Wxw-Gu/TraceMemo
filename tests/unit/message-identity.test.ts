import { describe, expect, it } from 'vitest'
import { sourceMessageId } from '../../src/main/knowledge/message-identity'
import type { FormattedMessage } from '../../src/main/services/chat-service'

const message = (localId: number, createTime: number): FormattedMessage =>
  ({
    id: String(localId),
    localId,
    createTime,
    from: 'fixture',
    type: '普通文本',
    datetime: '',
    content: '脱敏正文',
    isSender: false
  }) as FormattedMessage

describe('sourceMessageId', () => {
  it('同 local_id 不同时间必须生成不同 id', () => {
    // localId 跨分片会重号：只用它会让索引主键互相覆盖。
    expect(sourceMessageId(message(7, 1_700_000_000))).not.toBe(
      sourceMessageId(message(7, 1_700_000_060))
    )
  })

  it('同一条消息重复读取时 id 稳定', () => {
    expect(sourceMessageId(message(7, 1_700_000_000))).toBe(
      sourceMessageId(message(7, 1_700_000_000))
    )
  })

  it('没有 localId 时退回消息自带 id，不拼空时间', () => {
    expect(sourceMessageId({ ...message(0, 0), localId: undefined, id: 'fixture-id' })).toBe(
      'fixture-id'
    )
  })
})
