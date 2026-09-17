import { describe, expect, it } from 'vitest'
import {
  buildAuthorizedHeaders,
  buildBaseInfo,
  buildCommonHeaders,
  buildQrStatusHeaders,
  generateWechatUin,
  sanitizeBotAgent
} from '../../src/main/services/wechat-ilink/headers'
import {
  extractMarkdownImageUrls,
  markdownToPlainText
} from '../../src/main/services/wechat-ilink/markdown'
import {
  extractInboundText,
  normalizeInboundMessage
} from '../../src/main/services/wechat-ilink/messages'

describe('wechat-ilink headers', () => {
  it('X-WECHAT-UIN 是随机 uint32 的 base64，并且每次请求都重新生成', () => {
    const decoded = Buffer.from(generateWechatUin(), 'base64').toString('utf8')
    expect(decoded).toMatch(/^\d+$/)
    expect(Number(decoded)).toBeGreaterThanOrEqual(0)
    expect(Number(decoded)).toBeLessThanOrEqual(0xffffffff)

    const first = buildAuthorizedHeaders('token')['X-WECHAT-UIN']
    const second = buildAuthorizedHeaders('token')['X-WECHAT-UIN']
    expect(first).toBeTruthy()
    // 官方要求每次请求重新生成以防重放：连续两次不应相同。
    expect(second).not.toBe(first)
  })

  it('登录后的业务头包含鉴权字段与固定应用头', () => {
    const headers = buildAuthorizedHeaders('bot-token')
    expect(headers.AuthorizationType).toBe('ilink_bot_token')
    expect(headers.Authorization).toBe('Bearer bot-token')
    expect(headers['iLink-App-Id']).toBe('bot')
    expect(headers['iLink-App-ClientVersion']).toBe('132102')
  })

  it('没有 token 时拒绝构造鉴权头', () => {
    expect(() => buildAuthorizedHeaders('')).toThrow(/bot token/)
  })

  it('登录前后的公共头集合不同：未鉴权请求不携带 Authorization / X-WECHAT-UIN', () => {
    const anonymous = { ...buildCommonHeaders(), ...buildQrStatusHeaders() }
    expect(anonymous.Authorization).toBeUndefined()
    expect(anonymous.AuthorizationType).toBeUndefined()
    expect(anonymous['X-WECHAT-UIN']).toBeUndefined()
    expect(anonymous['iLink-App-Id']).toBe('bot')
  })

  it('base_info 携带当前协议版本与合法 bot_agent', () => {
    const baseInfo = buildBaseInfo()
    expect(baseInfo.channel_version).toBe('2.4.6')
    expect(baseInfo.bot_agent).toMatch(/^[\x21-\x7e]+$/)
  })

  it('bot_agent 清洗非法 token 并在为空时回退', () => {
    expect(sanitizeBotAgent('TraceMemo/2.4.0')).toBe('TraceMemo/2.4.0')
    expect(sanitizeBotAgent('TraceMemo/2.4.0 (mac)')).toBe('TraceMemo/2.4.0 (mac)')
    expect(sanitizeBotAgent('中文非法/1.0')).toBe('OpenClaw')
    expect(sanitizeBotAgent('')).toBe('OpenClaw')
    expect(sanitizeBotAgent(undefined)).toBe('OpenClaw')
    // 混合时丢弃非法 token，保留合法部分。
    expect(sanitizeBotAgent('好坏的 Agent/1.0')).toBe('Agent/1.0')
  })

  it('bot_agent 总长度受 256 字节限制', () => {
    const agent = Array.from({ length: 200 }, (_, index) => `Agent${index}/1.0`).join(' ')
    expect(Buffer.byteLength(sanitizeBotAgent(agent), 'utf8')).toBeLessThanOrEqual(256)
  })
})

describe('wechat-ilink markdown 降级', () => {
  it('把常见 Markdown 降级成微信可读纯文本', () => {
    const input = [
      '# 群聊总结',
      '',
      '**重点**：`code` 与 ~~删除线~~',
      '',
      '- 第一项',
      '- 第二项',
      '',
      '> 引用',
      '',
      '| A | B |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      '链接：[官网](https://example.com)',
      '图片：![图](https://example.com/a.png)',
      '',
      '```',
      'const a = 1',
      '```'
    ].join('\n')

    const output = markdownToPlainText(input)

    expect(output).toContain('群聊总结')
    expect(output).not.toContain('#')
    expect(output).toContain('重点')
    expect(output).not.toContain('**')
    expect(output).toContain('code')
    expect(output).not.toContain('`')
    expect(output).toContain('删除线')
    expect(output).not.toContain('~~')
    expect(output).toContain('• 第一项')
    expect(output).not.toContain('> 引用')
    expect(output).toContain('A  B')
    expect(output).not.toContain('|')
    expect(output).toContain('官网')
    expect(output).not.toContain('https://example.com/a.png')
    expect(output).toContain('const a = 1')
    expect(output).not.toContain('```')
  })

  it('折叠多余空行并去掉首尾空白', () => {
    expect(markdownToPlainText('\n\n\n内容\n\n\n')).toBe('内容')
  })

  it('提取文本中内嵌的 http(s) 图片地址', () => {
    const text = '看图 ![a](https://cdn.example.com/1.png) 和 ![b](/local/2.png)'
    expect(extractMarkdownImageUrls(text)).toEqual(['https://cdn.example.com/1.png'])
  })
})

describe('wechat-ilink 入站消息归一化', () => {
  it('完整透传 context_token 与会话标识', () => {
    const message = normalizeInboundMessage('bot-1', {
      message_id: 12345,
      seq: 3,
      from_user_id: 'user@im.wechat',
      message_type: 1,
      item_list: [{ type: 1, text_item: { text: '你好' } }],
      context_token: 'ctx-token',
      session_id: 'session-1',
      group_id: 'group-1'
    })

    expect(message).toMatchObject({
      accountId: 'bot-1',
      fromUserId: 'user@im.wechat',
      messageId: '12345',
      seq: 3,
      sessionId: 'session-1',
      groupId: 'group-1',
      contextToken: 'ctx-token'
    })
    expect(message?.items).toEqual([{ type: 1, text: '你好' }])
  })

  it('缺少 from_user_id 的消息无法投递', () => {
    expect(normalizeInboundMessage('bot-1', { message_id: 1 })).toBeUndefined()
    expect(normalizeInboundMessage('bot-1', { from_user_id: '   ' })).toBeUndefined()
  })

  it('语音条目保留微信侧转写文本，但不算作文本条目', () => {
    const message = normalizeInboundMessage('bot-1', {
      from_user_id: 'user@im.wechat',
      item_list: [{ type: 3, voice_item: { text: '语音转写内容' } }]
    })

    expect(message?.items).toEqual([{ type: 3, text: '语音转写内容' }])
    // 与旧 webhook 行为一致：只有 type=1 参与文本提取。
    expect(extractInboundText(message?.items)).toBe('')
  })

  it('多条文本条目按空格拼接', () => {
    expect(
      extractInboundText([{ type: 1, text: ' 第一段 ' }, { type: 2 }, { type: 1, text: '第二段' }])
    ).toBe('第一段 第二段')
  })
})
