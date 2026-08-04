import { describe, expect, it } from 'vitest'
import { parseMessageContent } from '../../src/main/message-parser'

describe('message parser', () => {
  it('parses image, voice and sticker messages without confusing their types', () => {
    expect(parseMessageContent('<img md5="0123456789abcdef0123456789abcdef" />', 3)).toMatchObject({
      type: 'image',
      md5: '0123456789abcdef0123456789abcdef'
    })
    expect(parseMessageContent('voice fixture', 34)).toEqual({ type: 'voice' })
    expect(
      parseMessageContent(
        '<emoji md5="abcdefabcdefabcdefabcdefabcdefab" cdnurl="https://fixture.invalid/a" />',
        47
      )
    ).toMatchObject({ type: 'sticker', md5: 'abcdefabcdefabcdefabcdefabcdefab' })
  })

  it('parses merged forwards and preserves nested visible text', () => {
    const parsed = parseMessageContent(
      '<appmsg><type>19</type><title>转发多条内容</title><recorditem><dataitem datatype="1"><sourcename>测试成员</sourcename><datadesc>脱敏内容</datadesc></dataitem></recorditem></appmsg>',
      49
    )
    expect(parsed.type).toBe('forwardBundle')
    if (parsed.type === 'forwardBundle') {
      expect(parsed.title).toBe('转发多条内容')
      expect(parsed.items.map((item) => item.text).join(' ')).toContain('脱敏内容')
    }
  })

  it('uses the quoted group member id instead of the chatroom id', () => {
    const parsed = parseMessageContent(
      '<appmsg><type>57</type><title>回复内容</title><refermsg><type>1</type><fromusr>123456789@chatroom</fromusr><chatusr>wxid_fixture_member</chatusr><content>被引用内容</content></refermsg></appmsg>',
      49
    )

    expect(parsed).toMatchObject({
      type: 'quote',
      quotedSender: 'wxid_fixture_member',
      quotedContent: '被引用内容'
    })
  })

  it('uses an explicit unknown type for unsupported messages', () => {
    expect(parseMessageContent('opaque fixture payload', 999)).toEqual({
      type: 'unknown',
      raw: 'opaque fixture payload',
      messageType: 999
    })
  })
})
