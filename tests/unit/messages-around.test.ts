import { describe, expect, it } from 'vitest'
import { sliceMessagesAroundWindow } from '../../src/main/services/messages-around'

/**
 * 消息跳转的身份匹配。
 *
 * 裸 `localId` 与 `createTime:localId` 都必须支持；后者是 SSE messageRef 的格式。
 */
describe('sliceMessagesAroundWindow', () => {
  const messages = [
    { id: '7', createTime: 1_795_158_000, text: '前一天' },
    { id: '7', createTime: 1_795_158_061, text: '目标' },
    { id: '8', createTime: 1_795_158_062, text: '后一条' }
  ]

  it('复合身份同时匹配 createTime 与 localId，选中正确的那一条', () => {
    const result = sliceMessagesAroundWindow(messages, 'conv', '1795158061:7')
    expect(result.index).toBe(1)
    expect(result.window[result.index]).toMatchObject({ text: '目标' })
  })

  it('只有 localId 时保持旧行为（第一条匹配）', () => {
    const result = sliceMessagesAroundWindow(messages, 'conv', '7')
    expect(result.index).toBe(0)
  })

  it('时间不匹配时不会误选另一条同 localId 的消息', () => {
    const result = sliceMessagesAroundWindow(messages, 'conv', '1795158999:7')
    expect(result.index).toBe(-1)
  })
})
