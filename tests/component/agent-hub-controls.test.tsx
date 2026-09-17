import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHubWorkspace } from '../../src/renderer/src/features/agent-hub/AgentHubWorkspace'
import type { AgentHubStatus } from '../../src/shared/agent-hub'
import type {
  AgentHubConversation,
  AgentHubConversationSummary
} from '../../src/shared/agent-hub-conversation'

const SELF_USER_ID = 'fixture-self-openid@im.wechat'

const onlineStatus: AgentHubStatus = {
  hub: 'online',
  connector: 'online',
  updatedAt: 1,
  dataApi: 'online',
  databaseReady: true,
  accountId: 'fixture-bot-account',
  wechatUserId: SELF_USER_ID
}

const conversationSummary: AgentHubConversationSummary = {
  userId: SELF_USER_ID,
  accountId: 'fixture-bot-account',
  firstAt: 1_700_000_000_000,
  lastAt: 1_700_000_060_000,
  messageCount: 2,
  lastPreview: '这是机器人的回答',
  lastDirection: 'out'
}

const conversation: AgentHubConversation = {
  userId: SELF_USER_ID,
  accountId: 'fixture-bot-account',
  firstAt: 1_700_000_000_000,
  lastAt: 1_700_000_060_000,
  messages: [
    {
      id: 'm1',
      direction: 'in',
      kind: 'text',
      text: '微信里最近发生了什么',
      createdAt: 1_700_000_000_000,
      messageId: '7506247944749661000'
    },
    {
      id: 'm2',
      direction: 'out',
      kind: 'text',
      text: '这是机器人的回答',
      createdAt: 1_700_000_060_000,
      status: 'sent'
    }
  ]
}

describe('Agent Hub controls', () => {
  beforeEach(() => {
    window.api = {
      getAgentHubStatus: vi.fn().mockResolvedValue(onlineStatus),
      getAgentHubLogs: vi.fn().mockResolvedValue([
        { id: 1, timestamp: 1, source: 'system', level: 'info', message: '系统就绪' },
        {
          id: 2,
          timestamp: 2,
          source: 'wechat-connector',
          level: 'warn',
          message: '等待连接'
        }
      ]),
      onAgentHubStatus: vi.fn(() => () => undefined),
      onAgentHubLog: vi.fn(() => () => undefined),
      copyText: vi.fn().mockResolvedValue(undefined),
      clearAgentHubLogs: vi.fn().mockResolvedValue({ success: true }),
      startAgentHubLogin: vi.fn().mockResolvedValue({ status: onlineStatus }),
      cancelAgentHubLogin: vi.fn().mockResolvedValue({ status: onlineStatus }),
      disconnectAgentHub: vi.fn().mockResolvedValue({
        status: { ...onlineStatus, connector: 'disconnected' }
      }),
      getAgentHubConversations: vi.fn().mockResolvedValue([]),
      getAgentHubConversation: vi.fn().mockResolvedValue(null),
      clearAgentHubConversations: vi.fn().mockResolvedValue({ success: true }),
      onAgentHubConversation: vi.fn(() => () => undefined),
      onAgentHubConversationsCleared: vi.fn(() => () => undefined)
    } as unknown as typeof window.api
  })

  it('filters, copies, and clears logs through shared controls', async () => {
    const user = userEvent.setup()
    render(<AgentHubWorkspace />)
    await screen.findByText('系统就绪')

    await user.click(screen.getByRole('combobox', { name: '筛选日志来源' }))
    await user.click(screen.getByRole('option', { name: '系统' }))
    expect(screen.getByText('系统就绪')).toBeInTheDocument()
    expect(screen.queryByText('等待连接')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '复制日志' }))
    expect(window.api.copyText).toHaveBeenCalledWith(expect.stringContaining('系统就绪'))
    expect(window.api.copyText).toHaveBeenCalledWith(expect.not.stringContaining('等待连接'))

    await user.click(screen.getByRole('button', { name: '清空' }))
    expect(window.api.clearAgentHubLogs).toHaveBeenCalledOnce()
    expect(screen.getByText(/暂无运行日志/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '复制日志' })).toBeDisabled()
  })

  it('keeps the enabled capability examples visible', async () => {
    render(<AgentHubWorkspace />)
    await screen.findByText('系统就绪')

    expect(screen.getByText('已启用能力')).toBeInTheDocument()
    expect(screen.getByText('微信数据助手')).toBeInTheDocument()
    expect(screen.getByText('支持自然语言，可以这样问')).toBeInTheDocument()
    expect(screen.getByText('“最近 5 条消息是谁？”')).toBeInTheDocument()
    expect(screen.getByText('“帮我看看最近跟xx聊了些什么”')).toBeInTheDocument()
    expect(screen.getByText('“生成产品交流群今天的群聊总结图片”')).toBeInTheDocument()
    expect(
      document.querySelectorAll(
        '.agent-hub-capability-card li:not(.agent-hub-capability-status) > i'
      )
    ).toHaveLength(4)
  })

  it('keeps reconnect and destructive disconnect actions separate', async () => {
    const user = userEvent.setup()
    render(<AgentHubWorkspace />)
    await screen.findByText('微信机器人已连接')

    await user.click(screen.getByRole('button', { name: '重新扫码登录' }))
    expect(window.api.startAgentHubLogin).toHaveBeenCalledOnce()

    const disconnect = screen.getByRole('button', { name: '断开连接' })
    expect(disconnect).toHaveClass('bg-destructive')
    await user.click(disconnect)
    await act(async () => {
      await Promise.resolve()
    })
    expect(window.api.disconnectAgentHub).toHaveBeenCalledOnce()
  })

  it('把收发记录渲染成仿微信对话，左侧用软件内账号的身份', async () => {
    window.api.getAgentHubConversations = vi.fn().mockResolvedValue([conversationSummary])
    window.api.getAgentHubConversation = vi.fn().mockResolvedValue(conversation)

    render(<AgentHubWorkspace selfInfo={{ wxid: 'wxid_me', nickname: '测试用户' }} />)

    expect(await screen.findByText('对话记录')).toBeInTheDocument()
    // 会话标识与扫码登录账号一致时，左侧展示软件内账号的昵称。
    expect(await screen.findByText('测试用户')).toBeInTheDocument()
    expect(screen.getByText('1 个会话 · 2 条')).toBeInTheDocument()
    // 消息线程是第二次拉取，必须 await，否则在并行跑测试时会抢跑。
    expect(await screen.findByText('微信里最近发生了什么')).toBeInTheDocument()
    expect(screen.getByText('这是机器人的回答')).toBeInTheDocument()
    expect(screen.getByText('已发送')).toBeInTheDocument()
  })

  it('对方不是本机账号时退化为占位身份，并渲染机器人头像', async () => {
    window.api.getAgentHubConversations = vi
      .fn()
      .mockResolvedValue([{ ...conversationSummary, userId: 'other-user-openid@im.wechat' }])
    window.api.getAgentHubConversation = vi.fn().mockResolvedValue({
      ...conversation,
      userId: 'other-user-openid@im.wechat'
    })

    render(<AgentHubWorkspace selfInfo={{ wxid: 'wxid_me', nickname: '测试用户' }} />)

    expect(await screen.findByText(/微信用户 othe…enid/)).toBeInTheDocument()
    await screen.findByText('微信里最近发生了什么')
    // 右侧气泡是机器人：用固定矢量头像，不依赖真实头像资源。
    expect(document.querySelectorAll('.agent-hub-bot-avatar').length).toBeGreaterThan(0)
  })

  it('清空对话记录需要二次确认，且不影响运行日志', async () => {
    const user = userEvent.setup()
    window.api.getAgentHubConversations = vi.fn().mockResolvedValue([conversationSummary])
    window.api.getAgentHubConversation = vi.fn().mockResolvedValue(conversation)

    render(<AgentHubWorkspace selfInfo={null} />)
    await screen.findByText('对话记录')

    await user.click(screen.getByRole('button', { name: '清空记录' }))
    expect(window.api.clearAgentHubConversations).not.toHaveBeenCalled()

    await user.click(await screen.findByRole('button', { name: '确认清空' }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(window.api.clearAgentHubConversations).toHaveBeenCalledOnce()
    expect(screen.getByText(/还没有收发记录/)).toBeInTheDocument()
  })
})
