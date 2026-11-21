import { describe, expect, it } from 'vitest'
import { selectMessageLocation, type Wcdb4MessageCursor } from '../../src/main/wcdb4-client'

/**
 * 跨分片 localId 重复时的定位回归。
 *
 * 真实事故：同一会话的 `local_id=31455` 在多个 message_N.db 中命中，
 * 只带 localId 的 messageRef 被判 `ambiguous_message`；带 create_time 的
 * 复合身份必须能唯一选中。
 */
describe('selectMessageLocation', () => {
  const hits: Wcdb4MessageCursor[] = [
    { createTime: 1_795_158_061, localId: 31_455 },
    { createTime: 1_795_158_099, localId: 31_455 }
  ]

  it('同 localId 跨分片命中时，create_time 唯一选中', () => {
    expect(selectMessageLocation(hits, 1_795_158_099)).toEqual({
      status: 'found',
      location: { createTime: 1_795_158_099, localId: 31_455 }
    })
  })

  it('只给 localId（wantedTime=null）时必须报 ambiguous', () => {
    expect(selectMessageLocation(hits, null)).toEqual({ status: 'ambiguous' })
  })

  it('create_time 不匹配时是 not_found，而不是随便挑一条', () => {
    expect(selectMessageLocation(hits, 1_795_158_000)).toEqual({ status: 'not_found' })
  })

  it('单分片唯一命中时仍然可以只靠 localId 定位', () => {
    expect(selectMessageLocation([hits[0]], null)).toEqual({
      status: 'found',
      location: hits[0]
    })
  })
})
