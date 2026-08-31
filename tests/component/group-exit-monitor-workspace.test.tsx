import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GroupExitMonitorWorkspace } from '../../src/renderer/src/features/group-exit-monitor/GroupExitMonitorWorkspace'
import type { GroupExitMonitorState } from '../../src/shared/group-exit-monitor'
import type { Contact } from '../../src/shared/types'
import { TooltipProvider } from '../../src/renderer/src/components/ui'

const state: GroupExitMonitorState = {
  events: [
    {
      id: 'event-1',
      contactId: 'group-md5',
      roomId: '研发群@chatroom',
      groupName: '研发群',
      memberWxid: 'wxid_alice',
      memberName: '小艾',
      wechatName: '小艾微信名',
      groupRemark: '小艾群备注',
      contactRemark: '小艾通讯录备注',
      previousCount: 240,
      currentCount: 239,
      delta: -1,
      message: '小艾退出了研发群',
      detectedAt: 1_756_600_000_000
    },
    {
      id: 'event-2',
      contactId: 'group-design-md5',
      roomId: '设计群@chatroom',
      groupName: '设计群',
      memberWxid: 'wxid_bob',
      memberName: '小博',
      wechatName: '小博微信名',
      groupRemark: '',
      previousCount: 80,
      currentCount: 79,
      delta: -1,
      message: '小博退出了设计群',
      detectedAt: 1_756_600_100_000
    }
  ],
  running: true,
  nativeMonitorActive: true,
  monitoredGroupCount: 3,
  monitorSelectionConfigured: true,
  monitoredRoomIds: ['研发群@chatroom', '设计群@chatroom'],
  notificationRoomIds: [],
  lastCheckedAt: 1_756_600_000_000,
  lastReadAt: 0,
  unreadCount: 1
}

const groups: Contact[] = [
  {
    m_nsUsrName: '研发群@chatroom',
    m_nsNickName: '研发群',
    md5: 'group-md5',
    type: 'group'
  },
  {
    m_nsUsrName: '设计群@chatroom',
    m_nsNickName: '设计群',
    md5: 'group-design-md5',
    type: 'group'
  }
]

describe('GroupExitMonitorWorkspace', () => {
  const renderWorkspace = (element: ReactElement): void => {
    render(<TooltipProvider>{element}</TooltipProvider>)
  }

  beforeEach(() => {
    window.api = {
      getGroupExitMonitorState: vi.fn().mockResolvedValue(state),
      onGroupExitMonitorState: vi.fn(() => () => undefined),
      checkGroupExitMonitorNow: vi.fn().mockResolvedValue(state),
      clearGroupExitMonitorEvents: vi.fn().mockResolvedValue({ ...state, events: [] })
    } as typeof window.api
  })

  it('renders a semantic exit notification and member count delta', async () => {
    renderWorkspace(<GroupExitMonitorWorkspace dbReady />)

    await waitFor(() => expect(screen.getByText('小艾退出了研发群')).toBeVisible())
    expect(screen.getByText(/240 人 → 239 人/)).toBeVisible()
    expect(screen.getByText('小艾微信名')).toBeVisible()
    expect(screen.getByText('小艾群备注')).toBeVisible()
    expect(screen.getByText('小艾通讯录备注')).toBeVisible()
    expect(screen.getByText('wxid_alice')).toBeVisible()
    expect(screen.getByText('实时监听已启用')).toBeVisible()
  })

  it('filters to groups that have exit events and clears the history', async () => {
    const user = userEvent.setup()
    renderWorkspace(<GroupExitMonitorWorkspace dbReady />)

    await waitFor(() => expect(screen.getByText('小博退出了设计群')).toBeVisible())
    await user.click(screen.getByRole('combobox', { name: '筛选退群群聊' }))
    await user.click(await screen.findByRole('option', { name: /研发群/ }))
    expect(screen.getByText('小艾退出了研发群')).toBeVisible()
    expect(screen.queryByText('小博退出了设计群')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '清空记录' }))
    await waitFor(() => expect(screen.queryByText('小艾退出了研发群')).not.toBeInTheDocument())
    expect(screen.getByText('暂无退群记录')).toBeVisible()
  })

  it('opens the management view, selects a group, and saves the monitoring scope', async () => {
    const user = userEvent.setup()
    const configuredState: GroupExitMonitorState = {
      ...state,
      events: [],
      monitorSelectionConfigured: true,
      monitoredRoomIds: [],
      monitoredGroupCount: 0,
      unreadCount: 0
    }
    const savedState: GroupExitMonitorState = {
      ...configuredState,
      monitoredRoomIds: ['研发群@chatroom'],
      monitoredGroupCount: 1
    }
    const setGroups = vi.fn().mockResolvedValue(savedState)
    window.api = {
      getGroupExitMonitorState: vi.fn().mockResolvedValue(configuredState),
      onGroupExitMonitorState: vi.fn(() => () => undefined),
      setGroupExitMonitorGroups: setGroups,
      checkGroupExitMonitorNow: vi.fn().mockResolvedValue(savedState),
      clearGroupExitMonitorEvents: vi.fn().mockResolvedValue(savedState)
    } as typeof window.api

    renderWorkspace(<GroupExitMonitorWorkspace dbReady contacts={groups} />)
    await waitFor(() => expect(screen.getByText('还没有设置监控群聊')).toBeVisible())
    await user.click(screen.getByRole('button', { name: '选择群聊' }))
    expect(screen.getByRole('heading', { name: '管理群聊' })).toBeVisible()
    await user.click(screen.getByRole('checkbox', { name: '监控研发群' }))
    await user.click(screen.getByRole('button', { name: '保存监控群聊' }))

    await waitFor(() => expect(setGroups).toHaveBeenCalledWith(['研发群@chatroom'], []))
    expect(screen.getByRole('heading', { name: '退群监控' })).toBeVisible()
    expect(screen.getByText('已监控群聊')).toBeVisible()
  })

  it('filters group rows by selection and persists notification targets separately', async () => {
    const user = userEvent.setup()
    const configuredState: GroupExitMonitorState = {
      ...state,
      events: [],
      monitorSelectionConfigured: true,
      monitoredRoomIds: ['研发群@chatroom'],
      notificationRoomIds: [],
      monitoredGroupCount: 1,
      unreadCount: 0
    }
    const savedState: GroupExitMonitorState = {
      ...configuredState,
      notificationRoomIds: ['研发群@chatroom']
    }
    const setGroups = vi.fn().mockResolvedValue(savedState)
    window.api = {
      getGroupExitMonitorState: vi.fn().mockResolvedValue(configuredState),
      onGroupExitMonitorState: vi.fn(() => () => undefined),
      getPersonalWechatSendCapability: vi.fn().mockResolvedValue({
        supported: true,
        ready: true,
        status: 'ready',
        capabilities: { text: true, image: true, voice: true },
        senderStatus: {} as never,
        message: '个人微信已准备好发送日报'
      }),
      setGroupExitMonitorGroups: setGroups,
      checkGroupExitMonitorNow: vi.fn().mockResolvedValue(savedState),
      clearGroupExitMonitorEvents: vi.fn().mockResolvedValue(savedState)
    } as typeof window.api

    renderWorkspace(<GroupExitMonitorWorkspace dbReady contacts={groups} />)
    await user.click(await screen.findByRole('button', { name: '管理群聊' }))
    await user.click(screen.getByRole('combobox', { name: '筛选群聊状态' }))
    await user.click(await screen.findByRole('option', { name: '未选择' }))
    expect(screen.getByRole('checkbox', { name: '监控设计群' })).toBeVisible()
    expect(screen.queryByRole('checkbox', { name: '监控研发群' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('combobox', { name: '筛选群聊状态' }))
    await user.click(await screen.findByRole('option', { name: '全部' }))
    await user.click(screen.getByRole('checkbox', { name: '是否通知研发群' }))
    await user.click(screen.getByRole('button', { name: '保存监控群聊' }))

    await waitFor(() =>
      expect(setGroups).toHaveBeenCalledWith(['研发群@chatroom'], ['研发群@chatroom'])
    )
  })

  it('selects every group even when a search term is active', async () => {
    const user = userEvent.setup()
    const configuredState: GroupExitMonitorState = {
      ...state,
      events: [],
      monitorSelectionConfigured: true,
      monitoredRoomIds: [],
      notificationRoomIds: [],
      monitoredGroupCount: 0,
      unreadCount: 0
    }
    const setGroups = vi.fn().mockResolvedValue({ ...configuredState, monitoredGroupCount: 2 })
    window.api = {
      getGroupExitMonitorState: vi.fn().mockResolvedValue(configuredState),
      onGroupExitMonitorState: vi.fn(() => () => undefined),
      setGroupExitMonitorGroups: setGroups,
      checkGroupExitMonitorNow: vi.fn().mockResolvedValue(configuredState),
      clearGroupExitMonitorEvents: vi.fn().mockResolvedValue(configuredState)
    } as typeof window.api

    renderWorkspace(<GroupExitMonitorWorkspace dbReady contacts={groups} />)
    await user.click(await screen.findByRole('button', { name: '选择群聊' }))
    await user.type(screen.getByRole('textbox', { name: '搜索群聊' }), '研发')
    await user.click(screen.getByRole('button', { name: '全选' }))
    await user.click(screen.getByRole('button', { name: '保存监控群聊' }))

    await waitFor(() =>
      expect(setGroups).toHaveBeenCalledWith(['研发群@chatroom', '设计群@chatroom'], [])
    )
  })

  it('shows the send capability and explains an unavailable state on hover', async () => {
    const user = userEvent.setup()
    const capability = {
      supported: true,
      ready: false,
      status: 'needs_binding' as const,
      capabilities: { text: false, image: false, voice: false },
      senderStatus: {} as never,
      message: '请先绑定个人微信'
    }
    window.api = {
      getGroupExitMonitorState: vi.fn().mockResolvedValue(state),
      onGroupExitMonitorState: vi.fn(() => () => undefined),
      getPersonalWechatSendCapability: vi.fn().mockResolvedValue(capability),
      setGroupExitMonitorGroups: vi.fn().mockResolvedValue(state),
      checkGroupExitMonitorNow: vi.fn().mockResolvedValue(state),
      clearGroupExitMonitorEvents: vi.fn().mockResolvedValue(state)
    } as typeof window.api

    renderWorkspace(<GroupExitMonitorWorkspace dbReady contacts={groups} />)
    await user.click(await screen.findByRole('button', { name: '管理群聊' }))
    const status = screen.getByText('发送能力未就绪', { exact: true })
    expect(status).toHaveClass('unready')
    await user.hover(status)
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent('请先绑定个人微信'))
  })

  it('shows the notification template from the management page header', async () => {
    const user = userEvent.setup()
    window.api = {
      getGroupExitMonitorState: vi.fn().mockResolvedValue(state),
      onGroupExitMonitorState: vi.fn(() => () => undefined),
      getPersonalWechatSendCapability: vi.fn().mockResolvedValue({
        supported: true,
        ready: false,
        status: 'needs_binding',
        capabilities: { text: false, image: false, voice: false },
        senderStatus: {} as never,
        message: '请先绑定个人微信'
      }),
      setGroupExitMonitorGroups: vi.fn().mockResolvedValue(state),
      checkGroupExitMonitorNow: vi.fn().mockResolvedValue(state),
      clearGroupExitMonitorEvents: vi.fn().mockResolvedValue(state)
    } as typeof window.api

    renderWorkspace(<GroupExitMonitorWorkspace dbReady contacts={groups} />)
    await user.click(await screen.findByRole('button', { name: '管理群聊' }))
    await user.click(screen.getByRole('button', { name: '查看退群监测模板' }))

    expect(screen.getByRole('heading', { name: '退群监测模板' })).toBeVisible()
    const template = screen.getByLabelText('退群监测模板内容')
    expect((template as HTMLTextAreaElement).value).toContain('用户: {user}')
    expect((template as HTMLTextAreaElement).value).toContain('群备注: {groupRemark}')
  })

  it('edits and persists the notification template', async () => {
    const user = userEvent.setup()
    const savedTemplate = '[退群监测]\n用户: {user}\n群: {groupRemark}'
    const setTemplate = vi.fn().mockResolvedValue({ ...state, notificationTemplate: savedTemplate })
    window.api = {
      getGroupExitMonitorState: vi.fn().mockResolvedValue(state),
      onGroupExitMonitorState: vi.fn(() => () => undefined),
      getPersonalWechatSendCapability: vi.fn().mockResolvedValue(null),
      setGroupExitMonitorNotificationTemplate: setTemplate,
      setGroupExitMonitorGroups: vi.fn().mockResolvedValue(state),
      checkGroupExitMonitorNow: vi.fn().mockResolvedValue(state),
      clearGroupExitMonitorEvents: vi.fn().mockResolvedValue(state)
    } as typeof window.api

    renderWorkspace(<GroupExitMonitorWorkspace dbReady contacts={groups} />)
    await user.click(await screen.findByRole('button', { name: '管理群聊' }))
    await user.click(screen.getByRole('button', { name: '查看退群监测模板' }))
    const template = screen.getByLabelText('退群监测模板内容')
    fireEvent.change(template, { target: { value: savedTemplate } })
    await user.click(screen.getByRole('button', { name: '保存模板' }))

    await waitFor(() => expect(setTemplate).toHaveBeenCalledWith(savedTemplate))
    expect(screen.queryByRole('heading', { name: '退群监测模板' })).not.toBeInTheDocument()
  })

  it('leaves every monitoring checkbox off for a new installation', async () => {
    const user = userEvent.setup()
    const newInstallState: GroupExitMonitorState = {
      ...state,
      events: [],
      monitorSelectionConfigured: false,
      monitoredRoomIds: [],
      notificationRoomIds: [],
      monitoredGroupCount: 0,
      unreadCount: 0
    }
    window.api = {
      getGroupExitMonitorState: vi.fn().mockResolvedValue(newInstallState),
      onGroupExitMonitorState: vi.fn(() => () => undefined),
      setGroupExitMonitorGroups: vi.fn().mockResolvedValue(newInstallState),
      checkGroupExitMonitorNow: vi.fn().mockResolvedValue(newInstallState),
      clearGroupExitMonitorEvents: vi.fn().mockResolvedValue(newInstallState)
    } as typeof window.api

    renderWorkspace(<GroupExitMonitorWorkspace dbReady contacts={groups} />)
    await user.click(await screen.findByRole('button', { name: '管理群聊' }))
    expect(screen.getByRole('checkbox', { name: '监控研发群' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: '监控设计群' })).not.toBeChecked()
  })
})
