import { describe, expect, it } from 'vitest'
import type { Message } from '../../src/shared/types'
import { enrichQuotedMessages } from '../../src/renderer/src/utils/quoted-messages'

const message = (overrides: Partial<Message>): Message => ({
  id: 'fixture',
  from: 'user',
  type: '普通文本',
  datetime: '2026-08-04 12:00:00',
  content: '',
  isSender: false,
  createTime: 1_785_816_000,
  ...overrides
})

describe('quoted message enrichment', () => {
  it('maps an internal quoted sender id to the loaded group member name', () => {
    const quoted = message({
      id: 'quote',
      contentData: {
        type: 'quote',
        content: '回复',
        quotedContent: '[图片]',
        quotedSender: 'wxid_fixture_member',
        quotedImageMd5: 'a'.repeat(32)
      }
    })

    const [result] = enrichQuotedMessages([quoted], [quoted], (senderId) =>
      senderId === 'wxid_fixture_member' ? '测试群成员' : undefined
    )

    expect(result.contentData).toMatchObject({ quotedSender: '测试群成员' })
  })
})
