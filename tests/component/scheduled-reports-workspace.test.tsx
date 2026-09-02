import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ScheduledReportsWorkspace } from '../../src/renderer/src/components/reports/ScheduledReportsWorkspace'
import type { Contact } from '../../src/shared/types'
import type { PersonalWechatSendCapability } from '../../src/shared/personal-wechat'

const group: Contact = {
  md5: 'group-md5',
  m_nsUsrName: 'group@chatroom',
  m_nsNickName: '技术交流',
  type: 'group'
}

const capability = (
  status: PersonalWechatSendCapability['status']
): PersonalWechatSendCapability => ({
  supported: status !== 'unsupported',
  ready: status === 'ready',
  status,
  capabilities: { text: status === 'ready', image: status === 'ready', voice: status === 'ready' },
  senderStatus: {} as PersonalWechatSendCapability['senderStatus'],
  message: ''
})

const task = {
  id: 'task-1',
  name: '技术交流 · 每日日报',
  group: group.md5,
  target: group.m_nsUsrName,
  scheduleTime: '09:00',
  reportRange: 'yesterday' as const,
  enabled: true,
  createdAt: '2026-08-26T00:00:00.000Z',
  updatedAt: '2026-08-26T00:00:00.000Z',
  nextRunAt: '2026-08-28T01:00:00.000Z'
}

describe('ScheduledReportsWorkspace', () => {
  const onNotice = vi.fn()
  const onOpenWechatSettings = vi.fn()
  const onOpenAgentHub = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getPersonalWechatSendCapability: vi.fn(async () => capability('ready')),
        getScheduledReportNotificationSettings: vi.fn(async () => ({ enabled: false })),
        setScheduledReportNotificationEnabled: vi.fn(async (enabled: boolean) => ({
          success: true,
          data: { enabled }
        })),
        listScheduledReports: vi.fn(async () => [task]),
        listScheduledReportExecutions: vi.fn(async () => []),
        createScheduledReport: vi.fn(async () => ({ success: true, data: task })),
        updateScheduledReport: vi.fn(async () => ({ success: true, data: task })),
        deleteScheduledReport: vi.fn(async () => ({ success: true, data: { deletedId: task.id } })),
        setScheduledReportEnabled: vi.fn(async () => ({ success: true, data: task })),
        runScheduledReportNow: vi.fn(async () => ({ success: true, data: { status: 'success' } })),
        testScheduledReportErrorNotification: vi.fn(async () => ({
          success: true,
          data: { status: 'failed', notificationStatus: 'sent' }
        }))
      }
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('loads capability and renders a scheduled report task', async () => {
    render(
      <ScheduledReportsWorkspace
        contacts={[group]}
        onNotice={onNotice}
        onOpenWechatSettings={onOpenWechatSettings}
        onOpenAgentHub={onOpenAgentHub}
      />
    )
    expect(screen.getByText('正在检查微信发送能力…')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('✓ 微信发送能力已就绪')).toBeVisible())
    expect(screen.getByText(task.name)).toBeVisible()
    expect(screen.getByText('每天 09:00')).toBeVisible()
  })

  it('keeps creation available and offers settings when WeChat is unsupported', async () => {
    vi.mocked(window.api.getPersonalWechatSendCapability).mockResolvedValue(
      capability('unsupported')
    )
    render(
      <ScheduledReportsWorkspace
        contacts={[group]}
        onNotice={onNotice}
        onOpenWechatSettings={onOpenWechatSettings}
        onOpenAgentHub={onOpenAgentHub}
      />
    )
    await waitFor(() =>
      expect(screen.getByText('微信消息发送目前仅支持 macOS 和 Windows')).toBeVisible()
    )
    expect(screen.getByRole('button', { name: /新建定时日报/ })).toBeEnabled()
  })

  it('opens the shared dialog and creates a task', async () => {
    vi.mocked(window.api.listScheduledReports).mockResolvedValue([])
    render(
      <ScheduledReportsWorkspace
        contacts={[group]}
        onNotice={onNotice}
        onOpenWechatSettings={onOpenWechatSettings}
        onOpenAgentHub={onOpenAgentHub}
      />
    )
    await waitFor(() => expect(screen.getByText('还没有定时日报')).toBeVisible())
    fireEvent.click(screen.getAllByRole('button', { name: /新建定时日报/ })[0])
    expect(screen.getByRole('dialog')).toBeVisible()
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByPlaceholderText('例如：技术交流 · 每日日报'), {
      target: { value: '测试日报' }
    })
    fireEvent.click(within(dialog).getByRole('button', { name: '创建定时日报' }))
    await waitFor(() =>
      expect(window.api.createScheduledReport).toHaveBeenCalledWith(
        expect.objectContaining({ name: '测试日报', group: group.md5, target: group.m_nsUsrName })
      )
    )
  })

  it('keeps the notification switch off by default and loads the persisted setting', async () => {
    render(
      <ScheduledReportsWorkspace
        contacts={[group]}
        onNotice={onNotice}
        onOpenWechatSettings={onOpenWechatSettings}
        onOpenAgentHub={onOpenAgentHub}
      />
    )

    const notificationSwitch = screen.getByRole('switch', { name: '微信异常通知' })
    await waitFor(() => expect(notificationSwitch).toHaveAttribute('aria-checked', 'false'))
    expect(window.api.getScheduledReportNotificationSettings).toHaveBeenCalledOnce()
  })

  it('restores the switch off and offers Agent Hub when enabling fails', async () => {
    vi.mocked(window.api.setScheduledReportNotificationEnabled).mockResolvedValue({
      success: false,
      data: { enabled: false },
      reason: 'agent_hub_offline',
      error: '需要先连接 Agent Hub 微信机器人，才能接收异常通知。'
    })
    render(
      <ScheduledReportsWorkspace
        contacts={[group]}
        onNotice={onNotice}
        onOpenWechatSettings={onOpenWechatSettings}
        onOpenAgentHub={onOpenAgentHub}
      />
    )

    await waitFor(() => expect(screen.getByText('微信异常通知')).toBeVisible())
    fireEvent.click(screen.getByRole('switch', { name: '微信异常通知' }))
    await waitFor(() =>
      expect(screen.getByText('需要先连接 Agent Hub 微信机器人，才能接收异常通知。')).toBeVisible()
    )
    expect(screen.getByRole('switch', { name: '微信异常通知' })).toHaveAttribute(
      'aria-checked',
      'false'
    )
    fireEvent.click(screen.getByRole('button', { name: '前往 Agent Hub' }))
    expect(onOpenAgentHub).toHaveBeenCalledOnce()
  })

  it('shows the debug notification action only when enabled and sends the test request', async () => {
    vi.stubEnv('VITE_SCHEDULED_REPORT_DEBUG', 'true')
    render(
      <ScheduledReportsWorkspace
        contacts={[group]}
        onNotice={onNotice}
        onOpenWechatSettings={onOpenWechatSettings}
        onOpenAgentHub={onOpenAgentHub}
      />
    )

    await waitFor(() => expect(screen.getByText(task.name)).toBeVisible())
    fireEvent.click(screen.getByRole('button', { name: '测试错误信息发送' }))

    await waitFor(() =>
      expect(window.api.testScheduledReportErrorNotification).toHaveBeenCalledWith(task.id)
    )
    expect(onNotice).toHaveBeenCalledWith(
      '测试错误信息已发送到 Agent Hub 微信通知接收者',
      'success'
    )
  })
})
