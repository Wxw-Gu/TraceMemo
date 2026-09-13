import { render, screen, waitFor, within } from '@testing-library/react'
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
    triggerType: 'automation',
    timestamp: '2026-09-03T08:30:21.000Z',
    recipientType: 'group',
    recipientId: '123456@chatroom',
    recipientName: '测试 q1',
    contentType: 'text',
    contentPreview: 'Shinven 已退出群聊',
    status: 'sent',
    executionId: 'execution-member-1',
    idempotencyKey: 'member_left_notification:member-log'
  },
  {
    id: 'report-log',
    category: 'wechat_send',
    source: 'scheduled_report',
    purpose: 'scheduled_report',
    triggerType: 'automation',
    timestamp: '2026-09-03T07:00:00.000Z',
    recipientType: 'group',
    recipientId: 'report@chatroom',
    recipientName: '日报群',
    contentType: 'image',
    contentPreview: 'daily-report.png',
    status: 'failed',
    errorCode: 'SEND_CAPABILITY_UNAVAILABLE',
    reason: '个人微信发送能力不可用',
    executionId: 'execution-report-1',
    idempotencyKey: 'scheduled_report:report-log'
  },
  {
    id: 'blocked-log',
    category: 'wechat_send',
    source: 'user_tts',
    purpose: 'tts_voice',
    triggerType: 'user',
    timestamp: '2026-09-03T06:00:00.000Z',
    recipientType: 'contact',
    recipientId: 'wxid_long_recipient_1234567890@chatroom.example',
    recipientName: '文件传输助手',
    contentType: 'voice',
    contentPreview: 'voice_xxx.silk 中文正文可以自然换行',
    status: 'blocked',
    executionId: 'execution-blocked-1234567890',
    idempotencyKey:
      'member_left_notification:49023470180@chatroom:2026-09-03T06:00:00.000Z:very-long-tail'
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
    expect(screen.getByText(/自动化 · 退群监控/)).toBeVisible()
    expect(screen.getByText('被阻止')).toBeVisible()
    expect(screen.queryByText('执行 ID：execution-member-1')).not.toBeInTheDocument()

    const details = screen.getAllByText('查看详情')[0]
    await user.click(details)
    expect(screen.getByText('execution-member-1')).toBeVisible()
    expect(screen.getByText('member_left_notification:member-log')).toBeVisible()
    expect(screen.getByText('member_left_notification:member-log')).toHaveClass(
      'whitespace-nowrap',
      'font-mono'
    )

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

    await user.click(screen.getByRole('combobox', { name: '筛选日志类型' }))
    await user.click(await screen.findByRole('option', { name: '全部类型' }))
    await user.click(screen.getByRole('combobox', { name: '筛选日志状态' }))
    await user.click(await screen.findByRole('option', { name: '全部状态' }))
    const startDate = document.querySelector<HTMLInputElement>('input[aria-label="开始日期"]')
    const endDate = document.querySelector<HTMLInputElement>('input[aria-label="结束日期"]')
    expect(startDate).not.toBeNull()
    expect(endDate).not.toBeNull()
    await user.clear(startDate!)
    await user.type(startDate!, '2026-09-03')
    await user.clear(endDate!)
    await user.type(endDate!, '2026-09-03')
    expect(screen.getByText(/Shinven 已退出群聊/)).toBeVisible()
    expect(screen.getByText(/daily-report.png/)).toBeVisible()

    await user.clear(startDate!)
    await user.type(startDate!, '2026-09-04')
    expect(screen.getByText('没有匹配的日志')).toBeVisible()
  })

  it('keeps long identifiers on one line and exposes complete values in details', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { listWechatActionLogs: vi.fn().mockResolvedValue(entries) } as unknown as typeof window.api
    })
    render(<LogsWorkspace />)

    const blockedCard = (await screen.findByText('被阻止')).closest('article')
    expect(blockedCard).not.toBeNull()
    const card = within(blockedCard!)
    const recipient = card.getByTitle('wxid_long_recipient_1234567890@chatroom.example')
    expect(recipient).toHaveClass('truncate', 'whitespace-nowrap')
    const key = card.getByTitle(
      'member_left_notification:49023470180@chatroom:2026-09-03T06:00:00.000Z:very-long-tail'
    )
    expect(key).toHaveClass('truncate', 'whitespace-nowrap', 'font-mono')
    expect(card.getByText('语音 · voice_xxx.silk 中文正文可以自然换行')).toHaveClass(
      'whitespace-normal',
      'break-words'
    )

    await userEvent.click(card.getByText('查看详情'))
    expect(card.getByText('wxid_long_recipient_1234567890@chatroom.example')).toBeVisible()
    expect(
      card.getByText('member_left_notification:49023470180@chatroom:2026-09-03T06:00:00.000Z:very-long-tail')
    ).toBeVisible()
  })
})
