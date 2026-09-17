import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  userData: '',
  ask: vi.fn(),
  generateAgentGroupReport: vi.fn(),
  isReady: vi.fn(),
  listRecentChat: vi.fn(),
  listContacts: vi.fn(),
  listMessages: vi.fn(),
  getGroupSnapshot: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => mocks.userData },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('../../src/main/services/ask-wechat-service', () => ({
  AskWechatService: class {
    ask(input: unknown, conversationKey?: string): Promise<unknown> {
      return mocks.ask(input, conversationKey)
    }
  }
}))
vi.mock('../../src/main/services/query-agent-service', () => ({ QueryAgentService: class {} }))
vi.mock('../../src/main/services/agent-group-report-service', () => ({
  generateAgentGroupReport: (input: unknown) => mocks.generateAgentGroupReport(input)
}))
vi.mock('../../src/main/services/ai-provider-service', () => ({
  AIProviderService: class {
    async chat(): Promise<{ success: boolean; data: string }> {
      return { success: true, data: 'AI 总结' }
    }
  }
}))
vi.mock('../../src/main/services/chat-service', () => ({
  isReady: () => mocks.isReady(),
  listRecentChat: (limit: number) => mocks.listRecentChat(limit),
  listContacts: () => mocks.listContacts(),
  listMessages: (...args: unknown[]) => mocks.listMessages(...args),
  getGroupSnapshot: (md5: string) => mocks.getGroupSnapshot(md5),
  resolveMd5: vi.fn()
}))

import {
  AgentHubService,
  type AgentHubWechatConnectorPort
} from '../../src/main/services/agent-hub-service'
import { WechatInboundInbox } from '../../src/main/services/wechat-inbound-inbox'
import { WechatSendGateway } from '../../src/main/services/wechat-send-gateway'
import { WechatSendLogService } from '../../src/main/services/wechat-send-log-service'
import type { AppSettings } from '../../src/main/services/settings-store'
import type { WechatInboundMessage } from '../../src/main/services/wechat-ilink/types'

const ACCOUNT_ID = 'bot-1'
const USER_ID = 'user@im.wechat'

function inbound(overrides: Partial<WechatInboundMessage> = {}): WechatInboundMessage {
  return {
    accountId: ACCOUNT_ID,
    fromUserId: USER_ID,
    messageId: '1001',
    messageType: 1,
    contextToken: 'ctx-inbound',
    items: [{ type: 1, text: '微信里最近发生了什么' }],
    receivedAt: 1_700_000_000_000,
    ...overrides
  }
}

function createFakeConnector(
  contextTokens: Map<string, string>,
  typingEvents: string[],
  typingShouldFail: () => boolean
): AgentHubWechatConnectorPort {
  return {
    setHost: () => undefined,
    listAccounts: () => [{ accountId: ACCOUNT_ID, wechatUserId: 'user_42' }],
    startLogin: () => undefined,
    cancelLogin: () => undefined,
    submitVerifyCode: () => undefined,
    isLoginInProgress: () => false,
    start: async () => undefined,
    stop: async () => undefined,
    getPhase: () => 'polling',
    getActiveAccountId: () => ACCOUNT_ID,
    resolveContextToken: (_accountId, toUserId) => contextTokens.get(toUserId),
    beginTyping: async () => {
      if (typingShouldFail()) throw new Error('typing 不可用')
      typingEvents.push('typing-on')
      return {
        stop: async () => {
          typingEvents.push('typing-off')
        }
      }
    },
    sendText: async () => undefined,
    sendMediaPath: async () => undefined,
    sendMediaUrl: async () => undefined
  }
}

describe('Agent Hub 入站 → 出站闭环', () => {
  const roots: string[] = []
  let service: AgentHubService
  let inbox: WechatInboundInbox
  let gateway: WechatSendGateway
  let sent: unknown[]
  let ilinkShouldFail: boolean
  let contextTokens: Map<string, string>
  let userDataRoot: string
  /** 与发送交织在一起的事件序列，用来断言 typing 的生命周期边界。 */
  let typingEvents: string[]
  let typingShouldFail: boolean
  /** 还要失败几次发送；0 表示不再失败。用于确定性地构造"先失败后成功"。 */
  let ilinkFailuresRemaining: number

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'tracememo-agent-hub-'))
    roots.push(root)
    userDataRoot = root
    mocks.userData = root
    mocks.ask
      .mockReset()
      .mockResolvedValue({ status: 'answered', answer: '这是 Query Agent 的回答' })
    mocks.generateAgentGroupReport.mockReset()
    mocks.isReady.mockReset().mockReturnValue(true)
    mocks.listRecentChat.mockReset().mockReturnValue([])
    mocks.listContacts.mockReset().mockReturnValue([])
    mocks.listMessages.mockReset().mockReturnValue([])
    mocks.getGroupSnapshot.mockReset().mockReturnValue(null)

    sent = []
    ilinkShouldFail = false
    typingEvents = []
    typingShouldFail = false
    ilinkFailuresRemaining = 0
    contextTokens = new Map()

    inbox = new WechatInboundInbox({
      filePath: () => join(root, 'agent-hub', 'inbound-inbox.json')
    })
    gateway = new WechatSendGateway({
      now: () => 1_700_000_000_000,
      createRequestId: (() => {
        let sequence = 0
        return () => `req-${(sequence += 1)}`
      })(),
      log: new WechatSendLogService({ getUserDataPath: () => root }),
      sendIlink: async (request) => {
        // 先把这次发送记进事件序列，失败与否都算一次尝试。
        sent.push(request)
        typingEvents.push(`send:${String((request as { type: string }).type)}`)
        if (ilinkFailuresRemaining > 0) {
          ilinkFailuresRemaining -= 1
          throw new Error('iLink 发送失败')
        }
        if (ilinkShouldFail) throw new Error('iLink 发送失败')
      }
    })

    service = new AgentHubService({ inbox, inboundRetryDelayMs: 5 })
    service.setSendGateway(gateway)
    service.setWechatConnector(
      createFakeConnector(contextTokens, typingEvents, () => typingShouldFail)
    )
    service.setQueryAgentService({} as never)
  })

  afterEach(() => {
    service.stop()
    while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
  })

  it('入站 context_token 一路带到出站发送，不丢失', async () => {
    await service.start({} as AppSettings)
    await service.handleInboundMessages([inbound()])

    await vi.waitFor(() => expect(sent).toHaveLength(1))

    expect(sent[0]).toMatchObject({
      to: USER_ID,
      type: 'text',
      msg: '这是 Query Agent 的回答',
      context_token: 'ctx-inbound',
      transport: 'ilink'
    })
    expect(mocks.ask).toHaveBeenCalledWith(
      expect.objectContaining({ text: '微信里最近发生了什么' }),
      `${ACCOUNT_ID}::${USER_ID}`
    )
  })

  it('处理成功后收件箱清空，重复 message_id 不会二次回复', async () => {
    await service.start({} as AppSettings)
    await service.handleInboundMessages([inbound()])
    await vi.waitFor(() => expect(sent).toHaveLength(1))

    await service.handleInboundMessages([inbound()])
    await vi.waitFor(() => expect(inbox.size()).toBe(0))
    expect(sent).toHaveLength(1)
  })

  it('发送失败时消息保留在收件箱，恢复后自动补发', async () => {
    await service.start({} as AppSettings)
    // 用"前 1 次发送必定失败"代替布尔标志，避免测试与后台处理抢时序。
    ilinkFailuresRemaining = 1
    await service.handleInboundMessages([inbound({ messageId: '2002' })])

    // 失败后条目必须仍留在收件箱，不能被静默丢弃。
    const key = `${ACCOUNT_ID}::2002`
    await vi.waitFor(() => expect(inbox.contains(key)).toBe(true))

    await vi.waitFor(() => expect(inbox.contains(key)).toBe(false))
    expect(
      sent.filter((item) => (item as { type: string }).type === 'text').length
    ).toBeGreaterThanOrEqual(2)
  })

  it('群日报请求先回执确认语，再触发 Report Action', async () => {
    mocks.generateAgentGroupReport.mockResolvedValue({
      success: true,
      pngPath: '/tmp/report.png',
      groupName: '产品交流群',
      messageCount: 12
    })
    await service.start({} as AppSettings)
    await service.handleInboundMessages([
      inbound({ messageId: '3003', items: [{ type: 1, text: '生成产品交流群今天的群聊总结图片' }] })
    ])

    await vi.waitFor(() => expect(mocks.generateAgentGroupReport).toHaveBeenCalled())
    await vi.waitFor(() =>
      expect(sent.some((item) => (item as { type: string }).type === 'image')).toBe(true)
    )

    expect(sent[0]).toMatchObject({ type: 'text', context_token: 'ctx-inbound' })
    expect(String((sent[0] as { msg: string }).msg)).toContain('正在生成群聊总结')
    expect(mocks.generateAgentGroupReport).toHaveBeenCalledWith(
      expect.objectContaining({ range: 'today' })
    )
    // 群日报图片仍走同一条发送通道，并保留会话上下文。
    expect(sent.find((item) => (item as { type: string }).type === 'image')).toMatchObject({
      msg: '/tmp/report.png',
      context_token: 'ctx-inbound'
    })
  })

  it('会话列表请求走确定性能力，不调用 Query Agent', async () => {
    mocks.listRecentChat.mockReturnValue([
      { m_nsNickName: '张三', m_nsUsrName: 'wxid_a', type: 'contact' }
    ])
    await service.start({} as AppSettings)
    await service.handleInboundMessages([
      inbound({ messageId: '4004', items: [{ type: 1, text: '最近 5 个会话' }] })
    ])

    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(String((sent[0] as { msg: string }).msg)).toContain('张三')
    expect(mocks.ask).not.toHaveBeenCalled()
  })

  it('主动通知在没有入站 token 时回退到会话最近一次有效 token', async () => {
    contextTokens.set(USER_ID, 'ctx-cached')
    await service.start({} as AppSettings)

    const result = await service.sendNotification({ to: USER_ID, text: '定时日报已生成' })

    expect(result).toMatchObject({ success: true, status: 'sent' })
    expect(sent[0]).toMatchObject({ context_token: 'ctx-cached', msg: '定时日报已生成' })
  })

  it('登录失效时把 STALE_TOKEN 映射成 token_expired', async () => {
    await service.start({} as AppSettings)
    gateway.configureIlinkSender(async () => {
      const { ILinkError } = await import('../../src/main/services/wechat-ilink/errors')
      throw new ILinkError({ kind: 'stale_token', message: '登录凭证已失效', ret: -14 })
    })

    const result = await service.sendNotification({ to: USER_ID, text: '测试' })
    expect(result).toMatchObject({ success: false, status: 'token_expired' })
  })

  it('未注入 iLink 通道时映射成 connector_offline', async () => {
    await service.start({} as AppSettings)
    const bare = new WechatSendGateway({
      log: new WechatSendLogService({ getUserDataPath: () => mocks.userData })
    })
    service.setSendGateway(bare)

    const result = await service.sendNotification({ to: USER_ID, text: '测试' })
    expect(result).toMatchObject({ success: false, status: 'connector_offline' })
  })

  it('对话记录保存完整收发内容，且不落 context_token', async () => {
    await service.start({} as AppSettings)
    await service.handleInboundMessages([inbound()])
    // 出站记录发生在发送返回之后，所以等对话记录本身而不是等 sent。
    await vi.waitFor(() => expect(service.getConversation(USER_ID)?.messages).toHaveLength(2))

    const conversation = service.getConversation(USER_ID)
    expect(conversation?.messages.map((message) => [message.direction, message.text])).toEqual([
      ['in', '微信里最近发生了什么'],
      ['out', '这是 Query Agent 的回答']
    ])
    expect(service.listConversations()).toHaveLength(1)

    const raw = readFileSync(join(userDataRoot, 'agent-hub', 'conversations.json'), 'utf8')
    // 会话上下文令牌属于运行时凭据，绝不能跟着对话记录落盘。
    expect(raw).not.toContain('ctx-inbound')
    expect(raw).not.toContain('context_token')
  })

  it('发送失败也会记进对话记录，并带上错误码', async () => {
    await service.start({} as AppSettings)
    ilinkShouldFail = true
    await service.handleInboundMessages([inbound({ messageId: '5005' })])

    await vi.waitFor(() => {
      const messages = service.getConversation(USER_ID)?.messages ?? []
      expect(messages.some((message) => message.status === 'failed')).toBe(true)
    })

    const failed = service
      .getConversation(USER_ID)
      ?.messages.find((message) => message.status === 'failed')
    expect(failed).toMatchObject({ direction: 'out', errorCode: 'SEND_FAILED' })
  })

  it('群日报图片在对话记录里记为图片消息', async () => {
    mocks.generateAgentGroupReport.mockResolvedValue({
      success: true,
      pngPath: '/tmp/report.png',
      groupName: '产品交流群',
      messageCount: 12
    })
    await service.start({} as AppSettings)
    await service.handleInboundMessages([
      inbound({ messageId: '6006', items: [{ type: 1, text: '生成产品交流群今天的群聊总结图片' }] })
    ])

    await vi.waitFor(() => {
      const kinds = service.getConversation(USER_ID)?.messages.map((message) => message.kind) ?? []
      expect(kinds).toContain('image')
    })

    const image = service
      .getConversation(USER_ID)
      ?.messages.find((message) => message.kind === 'image')
    // 媒体只记录文件名，不记录完整本地路径。
    expect(image?.text).toBe('report.png')
  })

  it('普通查询：typing ON → AI → 回复 → typing OFF，且不额外发"收到"', async () => {
    await service.start({} as AppSettings)
    await service.handleInboundMessages([inbound({ messageId: '8101' })])

    await vi.waitFor(() => expect(typingEvents).toContain('typing-off'))
    expect(typingEvents).toEqual(['typing-on', 'send:text', 'typing-off'])
    // 普通查询只发最终回答，没有"收到，正在查询"这类确认语。
    expect(sent).toHaveLength(1)
    expect(String((sent[0] as { msg: string }).msg)).toBe('这是 Query Agent 的回答')
  })

  it('群日报：确认语 → typing ON → 生成 → 文字+图片 → typing OFF', async () => {
    mocks.generateAgentGroupReport.mockResolvedValue({
      success: true,
      pngPath: '/tmp/report.png',
      groupName: '产品交流群',
      messageCount: 12
    })
    await service.start({} as AppSettings)
    await service.handleInboundMessages([
      inbound({ messageId: '8102', items: [{ type: 1, text: '生成产品交流群今天的群聊总结图片' }] })
    ])

    await vi.waitFor(() =>
      expect(typingEvents.filter((event) => event === 'typing-off')).toHaveLength(1)
    )
    expect(typingEvents[0]).toBe('send:text')
    expect(typingEvents).toContain('typing-on')
    expect(typingEvents).toContain('send:image')
    // typing 必须在图片发完之后才收掉。
    expect(typingEvents.indexOf('typing-off')).toBeGreaterThan(typingEvents.indexOf('send:image'))
  })

  it('Query Agent 抛异常时仍然收掉 typing', async () => {
    mocks.ask.mockRejectedValueOnce(new Error('provider 挂了'))
    await service.start({} as AppSettings)
    await service.handleInboundMessages([inbound({ messageId: '8103' })])

    await vi.waitFor(() => expect(typingEvents).toContain('typing-off'))
    expect(typingEvents[0]).toBe('typing-on')
    expect(typingEvents.indexOf('typing-off')).toBeGreaterThan(typingEvents.indexOf('send:text'))
  })

  it('最终消息发送失败时仍然收掉 typing', async () => {
    await service.start({} as AppSettings)
    ilinkShouldFail = true
    await service.handleInboundMessages([inbound({ messageId: '8104' })])

    await vi.waitFor(() => expect(typingEvents).toContain('typing-off'))
    expect(typingEvents[0]).toBe('typing-on')
    expect(typingEvents[typingEvents.length - 1]).toBe('typing-off')
  })

  it('typing 不可用时业务照常执行并回复', async () => {
    typingShouldFail = true
    await service.start({} as AppSettings)
    await service.handleInboundMessages([inbound({ messageId: '8105' })])

    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(String((sent[0] as { msg: string }).msg)).toBe('这是 Query Agent 的回答')
    expect(typingEvents).toEqual(['send:text'])
  })

  it('recent_list 这类快速确定性回复不触发 typing', async () => {
    mocks.listRecentChat.mockReturnValue([
      { m_nsNickName: '张三', m_nsUsrName: 'wxid_a', type: 'contact' }
    ])
    await service.start({} as AppSettings)
    await service.handleInboundMessages([
      inbound({ messageId: '8106', items: [{ type: 1, text: '最近 5 个会话' }] })
    ])

    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(typingEvents).toEqual(['send:text'])
  })

  it('成员分析：确认语之后才 typing ON，结果发完才 OFF', async () => {
    mocks.listContacts.mockReturnValue([
      { type: 'group', m_nsNickName: '产品交流群', m_nsUsrName: 'room@chatroom', md5: 'md5-room' }
    ])
    mocks.getGroupSnapshot.mockReturnValue({
      members: [
        {
          wxid: 'wxid_zhang',
          groupNickname: '张三',
          wechatNickname: '张三',
          remark: '',
          nickname: '张三'
        }
      ]
    })
    mocks.listMessages.mockReturnValue([
      {
        datetime: '2026-09-17 10:00',
        content: '今天聊了新版本',
        type: '普通文本',
        senderId: 'wxid_zhang',
        name: '张三'
      }
    ])
    await service.start({} as AppSettings)
    await service.handleInboundMessages([
      inbound({
        messageId: '8107',
        items: [{ type: 1, text: '看看产品交流群里张三今天说了什么' }]
      })
    ])

    await vi.waitFor(() => expect(typingEvents).toContain('typing-off'))
    // 确认语在前，typing 在后。
    expect(typingEvents[0]).toBe('send:text')
    expect(typingEvents.indexOf('typing-on')).toBeGreaterThan(0)
    expect(typingEvents[typingEvents.length - 1]).toBe('typing-off')
  })

  it('清空对话记录后不再保留任何会话', async () => {
    await service.start({} as AppSettings)
    await service.handleInboundMessages([inbound()])
    await vi.waitFor(() => expect(service.listConversations()).toHaveLength(1))

    service.clearConversations()

    expect(service.listConversations()).toEqual([])
    expect(service.getConversation(USER_ID)).toBeNull()
  })
})
