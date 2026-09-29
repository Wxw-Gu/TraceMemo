import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GroupMemberStatsDialog } from '../../src/renderer/src/components/group-stats/GroupMemberStatsDialog'
import {
  GROUP_STATS_LIMITATION,
  GROUP_STATS_STALE_LIMITATION,
  type GroupMemberStatsResult
} from '../../src/shared/group-stats'
import type { Contact } from '../../src/shared/types'

const contact: Contact = {
  m_nsUsrName: '研发群@chatroom',
  m_nsNickName: '研发群',
  remark: '公司研发大群',
  md5: 'g'.repeat(32),
  type: 'group'
}

const at = (year: number, month: number, day: number): number =>
  new Date(year, month - 1, day).getTime()

const baseResult = (
  overrides: Partial<GroupMemberStatsResult> = {}
): GroupMemberStatsResult => ({
  conversationId: contact.md5,
  startTime: at(2026, 6, 15),
  endTime: at(2026, 9, 4),
  freshness: 'fresh',
  complete: true,
  memberCount: 5,
  activeMemberCount: 3,
  silentMemberCount: 2,
  activeMembers: [
    {
      senderId: 'wxid_a',
      displayName: '张三',
      groupNickname: '老张',
      messageCount: 328,
      lastMessageTime: at(2026, 9, 1)
    },
    {
      senderId: 'wxid_b',
      displayName: '李四',
      groupNickname: '',
      messageCount: 217,
      lastMessageTime: at(2026, 9, 2)
    },
    {
      senderId: 'wxid_c',
      displayName: '王五',
      groupNickname: '',
      messageCount: 196,
      lastMessageTime: at(2026, 9, 3)
    }
  ],
  silentMembers: [
    { senderId: 'wxid_d', displayName: '轩轩', groupNickname: '轩轩子' },
    { senderId: 'wxid_e', displayName: '十二', groupNickname: '' }
  ],
  unattributedMessages: 0,
  excludedSystemMessages: 0,
  firstMessageTime: at(2026, 6, 15),
  limitations: [GROUP_STATS_LIMITATION],
  ...overrides
})

const getGroupMemberStats = vi.fn()
const getPersonalWechatSenderStatus = vi.fn()
const sendPersonalWechatMessage = vi.fn()

beforeEach(() => {
  getGroupMemberStats.mockReset().mockResolvedValue(baseResult())
  getPersonalWechatSenderStatus.mockReset().mockResolvedValue({ canSendText: false })
  sendPersonalWechatMessage.mockReset().mockResolvedValue({ ok: true })
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) }
  })
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    getGroupMemberStats,
    getPersonalWechatSenderStatus,
    sendPersonalWechatMessage
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

const renderDialog = () =>
  render(<GroupMemberStatsDialog open onOpenChange={vi.fn()} contact={contact} />)

/**
 * Radix Tabs 只挂载 active 的内容，未发言名单要先切过去才存在。
 *
 * ⚠️ 必须先等 tab 出现：数据没加载完时整个结果区（含 Tabs）都还没渲染，
 * 直接 `getByRole('tab')` 会因为「DOM 里还没有 tab」而失败。
 */
const switchToSilentTab = async (): Promise<void> => {
  const user = userEvent.setup()
  const tab = await screen.findByRole('tab', { name: /未发言统计/ })
  await user.click(tab)
  await waitFor(() => expect(screen.getByText(/轩轩/)).toBeTruthy())
}

describe('GroupMemberStatsDialog', () => {
  it('展示群备注与三个概览数字', async () => {
    renderDialog()

    await waitFor(() => expect(screen.getByText(/张三/)).toBeTruthy())
    expect(screen.getByText('群备注：公司研发大群')).toBeTruthy()
    expect(screen.getByText('当前群成员')).toBeTruthy()
    expect(screen.getByText('发过言')).toBeTruthy()
    expect(screen.getByText('没发言')).toBeTruthy()
    expect(screen.getByText(/共 3 人/)).toBeTruthy()
  })

  it('默认展示「发言排行」tab，且不渲染未发言名单', async () => {
    renderDialog()

    await waitFor(() => expect(screen.getByText(/张三/)).toBeTruthy())
    expect(screen.getByText(/李四/)).toBeTruthy()
    // 未发言的人此时不应出现在 DOM 里，避免两个名单互相干扰
    expect(screen.queryByText(/轩轩/)).toBeNull()
  })

  it('切到「未发言统计」tab 后才展示未发言名单', async () => {
    renderDialog()
    await waitFor(() => expect(screen.getByText(/张三/)).toBeTruthy())

    await switchToSilentTab()

    expect(screen.getByText(/十二/)).toBeTruthy()
    expect(screen.getByText(/共 2 人/)).toBeTruthy()
    // 切过去之后也不应再看到发言榜的人
    expect(screen.queryByText(/张三/)).toBeNull()
  })

  it('canSendText = false 时只提供复制，不出现发送按钮', async () => {
    renderDialog()
    await switchToSilentTab()

    expect(screen.queryByRole('button', { name: '发送到当前群' })).toBeNull()
    expect(screen.getAllByRole('button', { name: '复制' }).length).toBeGreaterThan(0)
  })

  it('canSendText = true 时出现发送按钮', async () => {
    getPersonalWechatSenderStatus.mockResolvedValue({ canSendText: true })
    renderDialog()
    await switchToSilentTab()

    expect(screen.getByRole('button', { name: '发送到当前群' })).toBeTruthy()
  })

  it('复制走 formatter 生成的完整文本', async () => {
    renderDialog()
    await switchToSilentTab()

    const user = userEvent.setup()
    // userEvent.setup() 会安装它自己的 clipboard stub，覆盖 beforeEach 里的定义，
    // 所以必须在 setup 之后再 spy，否则断言的是一个永远不会被调用的替身。
    const clipboardSpy = vi.spyOn(navigator.clipboard, 'writeText')
    await user.click(screen.getByRole('button', { name: '复制' }))

    await waitFor(() => expect(clipboardSpy).toHaveBeenCalled())
    const text = clipboardSpy.mock.calls[0][0] as string
    expect(text).toContain('未发言统计')
    expect(text).toContain('1. 轩轩')
    expect(text).toContain('2. 十二')
  })

  it('索引未追平时显示 warning 且不宣称完整', async () => {
    getGroupMemberStats.mockResolvedValue(
      baseResult({
        freshness: 'stale',
        complete: false,
        limitations: [GROUP_STATS_LIMITATION, GROUP_STATS_STALE_LIMITATION]
      })
    )
    renderDialog()

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('本地索引尚未完全同步')
  })

  it('索引未追平时提供「去建立索引」的去处', async () => {
    getGroupMemberStats.mockResolvedValue(
      baseResult({
        freshness: 'stale',
        complete: false,
        limitations: [GROUP_STATS_LIMITATION, GROUP_STATS_STALE_LIMITATION]
      })
    )
    const onOpenLocalIndexSettings = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <GroupMemberStatsDialog
        open
        onOpenChange={onOpenChange}
        contact={contact}
        onOpenLocalIndexSettings={onOpenLocalIndexSettings}
      />
    )

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '去建立索引' }))

    // 必须先关面板再跳，否则设置页会被这个 Dialog 挡在后面。
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onOpenLocalIndexSettings).toHaveBeenCalled()
  })

  it('没有提供跳转回调时不显示「去建立索引」', async () => {
    getGroupMemberStats.mockResolvedValue(
      baseResult({ freshness: 'stale', complete: false })
    )
    renderDialog()

    await screen.findByRole('alert')
    expect(screen.queryByRole('button', { name: '去建立索引' })).toBeNull()
  })

  it('发送失败时展示错误而不是静默失败', async () => {
    getPersonalWechatSenderStatus.mockResolvedValue({ canSendText: true })
    sendPersonalWechatMessage.mockRejectedValue(new Error('hook 未就绪'))
    renderDialog()
    await switchToSilentTab()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '发送到当前群' }))

    await waitFor(() => expect(screen.getByText('hook 未就绪')).toBeTruthy())
  })
})
