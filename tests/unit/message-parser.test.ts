import { describe, expect, it } from 'vitest'
import { parseMessageContent } from '../../src/main/message-parser'

describe('message parser', () => {
  it('parses image, voice and sticker messages without confusing their types', () => {
    expect(parseMessageContent('<img md5="0123456789abcdef0123456789abcdef" />', 3)).toMatchObject({
      type: 'image',
      md5: '0123456789abcdef0123456789abcdef'
    })
    expect(parseMessageContent('voice fixture', 34)).toEqual({ type: 'voice' })
    expect(parseMessageContent('', 34)).toEqual({ type: 'voice' })
    expect(
      parseMessageContent(
        '<emoji md5="abcdefabcdefabcdefabcdefabcdefab" cdnurl="https://fixture.invalid/a" />',
        47
      )
    ).toMatchObject({ type: 'sticker', md5: 'abcdefabcdefabcdefabcdefabcdefab' })
  })

  it('keeps video metadata when WeChat omits every MD5 field', () => {
    const parsed = parseMessageContent(
      '<msg><videomsg length="6402169" playlength="30" cdnthumbwidth="224" cdnthumbheight="398" aeskey="25201cc658042689d1ad6747cea2b240" rawmd5="" /></msg>',
      43
    )

    expect(parsed).toEqual({
      type: 'video',
      md5: undefined,
      newMd5: undefined,
      rawMd5: undefined,
      byteLength: 6402169,
      duration: 30,
      width: 224,
      height: 398
    })
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

  it.each([
    ['6', '测试附件.pdf'],
    ['74', '发送中的附件.zip']
  ])(
    'keeps file app message type %s when attachment metadata contains record tags',
    (typeVal, title) => {
      const parsed = parseMessageContent(
        `<appmsg><type>${typeVal}</type><title>${title}</title><des>1 MB</des><appattach><recorditem>legacy metadata</recorditem><dataitem datatype="8"><datatitle>${title}</datatitle></dataitem></appattach></appmsg>`,
        49
      )

      expect(parsed).toMatchObject({
        type: 'share',
        title,
        typeVal
      })
    }
  )

  it('decodes XML entities in file titles used for attachment lookup', () => {
    const parsed = parseMessageContent(
      '<appmsg><type>6</type><title>Check-in Voucher （Samabe Bali Suites &amp; Villas）.pdf</title></appmsg>',
      49
    )

    expect(parsed).toMatchObject({
      type: 'share',
      title: 'Check-in Voucher （Samabe Bali Suites & Villas）.pdf',
      typeVal: '6'
    })
  })

  it('does not classify empty incidental record metadata as a merged forward', () => {
    const parsed = parseMessageContent(
      '<appmsg><type>5</type><title>普通分享</title><recorditem>legacy metadata</recorditem></appmsg>',
      49
    )

    expect(parsed).toMatchObject({ type: 'share', title: '普通分享', typeVal: '5' })
  })

  it('preserves every article in a public-account multi-article message', () => {
    const parsed = parseMessageContent(
      `<appmsg><type>5</type><appname>长江日报</appname><mmreader><category count="3"><item><title><![CDATA[女子吃酒席时意外发现]]></title><url><![CDATA[https://mp.weixin.qq.com/a]]></url><cover><![CDATA[https://img.test/a.jpg]]></cover></item><item><title>霍尔木兹海峡开放临时协议</title><digest>国际油价短期走势</digest><url>https://mp.weixin.qq.com/b</url></item><item><title>东野圭吾新作</title><url>https://mp.weixin.qq.com/c</url></item></category></mmreader></appmsg>`,
      49
    )

    expect(parsed).toMatchObject({ type: 'share', appname: '长江日报' })
    if (parsed.type === 'share') {
      expect(parsed.articles).toHaveLength(3)
      expect(parsed.articles?.map((article) => article.title)).toEqual([
        '女子吃酒席时意外发现',
        '霍尔木兹海峡开放临时协议',
        '东野圭吾新作'
      ])
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
