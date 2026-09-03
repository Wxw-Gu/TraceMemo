import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { LogsWorkspace } from '../../src/renderer/src/features/logs/LogsWorkspace'
import type { ActionLogEntry } from '../../src/shared/action-log'

const entries: ActionLogEntry[] = [
  {
    id: 'member-log',
    category: 'wechat_send',
    source: 'member_monitor',
    purpose: 'member_left_notification',
    timestamp: '2026-09-03T08:30:21.000Z',
    recipientType: 'group',
    recipientId: '123456@chatroom',
    recipientName: '测试 q1',
    contentType: 'text',
    contentPreview: 'Shinven 已退出群聊',
    status: 'sent'
  },
  {
    id: 'report-log',
    category: 'wechat_send',
    source: 'scheduled_report',
    purpose: 'scheduled_report',
    timestamp: '2026-09-03T07:00:00.000Z',
    recipientType: 'group',
    recipientId: 'report@chatroom',
    recipientName: '日报群',
    contentType: 'image',
    contentPreview: 'daily-report.png',
    status: 'failed',
    errorCode: 'SEND_CAPABILITY_UNAVAILABLE',
    reason: '个人微信发送能力不可用'
  }
]

describe('LogsWorkspace', () => {
  it('shows audit entries and filters by search, status, and purpose', async () => {
    const user = userEvent.setup()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        listWechatActionLogs: vi.fn().mockResolvedValue(entries)
      } as unknown as typeof window.api
    })
    render(<LogsWorkspace />)

    await waitFor(() => expect(screen.getByText(/Shinven 已退出群聊/)).toBeVisible())
    expect(screen.getByText(/daily-report.png/)).toBeVisible()
    expect(screen.getByText('发送能力不可用')).toBeVisible()

    const search = screen.getByRole('searchbox', { name: '搜索日志' })
    await user.type(search, '123456')
    expect(screen.getByText(/Shinven 已退出群聊/)).toBeVisible()
    expect(screen.queryByText(/daily-report.png/)).not.toBeInTheDocument()
    await user.clear(search)

    await user.click(screen.getByRole('combobox', { name: '筛选日志状态' }))
    await user.click(await screen.findByRole('option', { name: '失败' }))
    expect(screen.queryByText(/Shinven 已退出群聊/)).not.toBeInTheDocument()
    expect(screen.getByText(/daily-report.png/)).toBeVisible()

    await user.click(screen.getByRole('combobox', { name: '筛选日志类型' }))
    await user.click(await screen.findByRole('option', { name: '退群通知' }))
    expect(screen.getByText('没有匹配的日志')).toBeVisible()
  })
})
