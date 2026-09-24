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

  it('reads the WeChat voice length in milliseconds and keeps fractional seconds', () => {
    // 真机实测（2026-09-20）：voicelength 才是毫秒时长，length 是编码数据长度——别取错。
    // 属性值取自一条真机采样的语音（1.6 秒，微信气泡显示 2"）。
    const parsed = parseMessageContent(
      '<msg><voicemsg endflag="1" cancelflag="0" forwardflag="0" voiceformat="4" voicelength="1600" length="6672" bufid="0" /></msg>',
      34
    )
    expect(parsed).toEqual({ type: 'voice', duration: 1.6 })
    // 误取 length 会得到 6.672 秒（把 2" 的语音显示成 0:07）——这条断言就是防这个回归。
    expect(parsed).not.toEqual({ type: 'voice', duration: 6.672 })

    // 微信四舍五入到整秒，取整必须在显示层做，不能在解析层丢精度。
    expect(parseMessageContent('<msg><voicemsg voicelength="4211" /></msg>', 34)).toEqual({
      type: 'voice',
      duration: 4.211
    })
  })

  it('leaves the voice duration undefined when the payload is missing or unusable', () => {
    expect(parseMessageContent('', 34)).toEqual({ type: 'voice' })
    expect(parseMessageContent('voice fixture', 34)).toEqual({ type: 'voice' })
    expect(parseMessageContent('<msg><voicemsg voiceformat="4" /></msg>', 34)).toEqual({
      type: 'voice'
    })
    expect(parseMessageContent('<msg><voicemsg voicelength="0" /></msg>', 34)).toEqual({
      type: 'voice'
    })
    expect(parseMessageContent('<msg><voicemsg voicelength="abc" /></msg>', 34)).toEqual({
      type: 'voice'
    })
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

  it('renders the templated join-group notice instead of its hidden button label', () => {
    // 微信 4.x 的 sysmsgtemplate：<plain> 为空、正文在 <template> 里用 $名称$ 引用 link，
    // hidden="1" 的 link 是可点击按钮，不应作为正文。
    const parsed = parseMessageContent(
      [
        '<sysmsg type="sysmsgtemplate">',
        '<sysmsgtemplate><content_template type="tmpl_type_profilewithrevokeqrcode">',
        '<plain><![CDATA[]]></plain>',
        '<template><![CDATA["$adder$"通过扫描你分享的二维码加入群聊  $revoke$]]></template>',
        '<link_list>',
        '<link name="adder" type="link_profile"><memberlist><member>',
        '<username><![CDATA[wxid_fixture_member]]></username>',
        '<nickname><![CDATA[成员昵称]]></nickname>',
        '</member></memberlist></link>',
        '<link name="revoke" type="link_revoke_qrcode" hidden="1">',
        '<title><![CDATA[撤销]]></title>',
        '</link>',
        '</link_list>',
        '</content_template></sysmsgtemplate></sysmsg>'
      ].join(''),
      10000
    )

    expect(parsed).toMatchObject({
      type: 'system',
      content: '"成员昵称"通过扫描你分享的二维码加入群聊'
    })
  })

  it('keeps parsing the legacy delchatroommember join-group notice', () => {
    const parsed = parseMessageContent(
      [
        '<sysmsg type="delchatroommember"><delchatroommember>',
        '<plain><![CDATA["成员昵称"通过扫描你分享的二维码加入群聊  ]]></plain>',
        '<text><![CDATA["成员昵称"通过扫描你分享的二维码加入群聊  ]]></text>',
        '<link><scene>qrcode</scene><text><![CDATA[  撤销]]></text>',
        '<memberlist><username><![CDATA[wxid_fixture_member]]></username></memberlist>',
        '</link>',
        '</delchatroommember></sysmsg>'
      ].join(''),
      10000
    )

    expect(parsed).toMatchObject({
      type: 'system',
      content: '"成员昵称"通过扫描你分享的二维码加入群聊'
    })
  })

  it('uses an explicit unknown type for unsupported messages', () => {
    expect(parseMessageContent('opaque fixture payload', 999)).toEqual({
      type: 'unknown',
      raw: 'opaque fixture payload',
      messageType: 999
    })
  })

  it('parses transfer wcpayinfo fields (type 2000)', () => {
    // 2026-09 真机转账采样字段名（含微信原文 transcationid 拼写）
    const xml = [
      '<msg><appmsg appid="" sdkver="">',
      '<title><![CDATA[微信转账]]></title>',
      '<des><![CDATA[收到转账2900.00元。]]></des>',
      '<type>2000</type>',
      '<url><![CDATA[https://support.weixin.qq.com/upgrade]]></url>',
      '<wcpayinfo>',
      '<paysubtype>3</paysubtype>',
      '<feedesc><![CDATA[￥2900.00]]></feedesc>',
      '<transcationid><![CDATA[53010003370089202609134087894875]]></transcationid>',
      '<transferid><![CDATA[1000050001202609130232821248942]]></transferid>',
      '<invalidtime><![CDATA[1789348128]]></invalidtime>',
      '<begintransfertime><![CDATA[1789261728]]></begintransfertime>',
      '<effectivedate><![CDATA[1]]></effectivedate>',
      '<pay_memo><![CDATA[房租]]></pay_memo>',
      '<receiver_username><![CDATA[wxid_receiver]]></receiver_username>',
      '<payer_username><![CDATA[]]></payer_username>',
      '<transfer_status>2</transfer_status>',
      '</wcpayinfo></appmsg></msg>'
    ].join('')
    const parsed = parseMessageContent(xml, 49)
    expect(parsed).toMatchObject({
      type: 'share',
      typeVal: '2000',
      title: '微信转账',
      transfer: {
        paySubtype: '3',
        amountText: '￥2900.00',
        transcationId: '53010003370089202609134087894875',
        transferId: '1000050001202609130232821248942',
        invalidTime: '1789348128',
        beginTransferTime: '1789261728',
        effectiveDate: '1',
        payMemo: '房租',
        receiverUsername: 'wxid_receiver',
        transferStatus: '2',
        transferStatusText: '已收款'
      }
    })
  })

  it('parses red packet wcpayinfo fields (type 2001 / mmpayhb)', () => {
    const xml = [
      '<msg><appmsg appid="" sdkver="">',
      '<title><![CDATA[中秋快乐]]></title>',
      '<des><![CDATA[我给你发了一个红包，赶紧去拆!]]></des>',
      '<type>2001</type>',
      '<wcpayinfo>',
      '<templateid><![CDATA[7a2a165d31da7fce6dd77e05c300028a]]></templateid>',
      '<url><![CDATA[https://wxapp.tenpay.com/mmpayhb/wxhb_personalreceive?msgtype=1&sendid=1000039801202609247176036834007&sign=abc]]></url>',
      '<iconurl><![CDATA[https://wx.gtimg.com/hongbao/1800/hb.png]]></iconurl>',
      '<receivertitle><![CDATA[恭喜发财，大吉大利]]></receivertitle>',
      '<sendertitle><![CDATA[中秋快乐，望重置]]></sendertitle>',
      '<scenetext><![CDATA[微信红包]]></scenetext>',
      '<senderdes><![CDATA[查看红包]]></senderdes>',
      '<receiverdes><![CDATA[领取红包]]></receiverdes>',
      '<nativeurl><![CDATA[wxpay://c2cbizmessagehandler/hongbao/receivehongbao?sendid=1]]></nativeurl>',
      '<hb_type>1</hb_type>',
      '<hb_status>1</hb_status>',
      '<receive_status>2</receive_status>',
      '</wcpayinfo></appmsg></msg>'
    ].join('')
    const parsed = parseMessageContent(xml, 49)
    expect(parsed).toMatchObject({
      type: 'redPacket',
      title: '中秋快乐，望重置',
      pay: {
        templateId: '7a2a165d31da7fce6dd77e05c300028a',
        receiveTitle: '恭喜发财，大吉大利',
        sendTitle: '中秋快乐，望重置',
        sceneText: '微信红包',
        senderDes: '查看红包',
        receiverDes: '领取红包',
        sendId: '1000039801202609247176036834007',
        hbType: '1',
        hbStatus: '1',
        receiveStatus: '2',
        redPacketStatusText: '已领取'
      }
    })
  })
})
