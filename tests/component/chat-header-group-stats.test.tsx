import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatHeader } from '../../src/renderer/src/components/chat/ChatHeader'
import { TooltipProvider } from '../../src/renderer/src/components/ui'
import { type GroupMemberStatsResult } from '../../src/shared/group-stats'
import type { Contact } from '../../src/shared/types'

const groupContact: Contact = {
  m_nsUsrName: '研发群@chatroom',
  m_nsNickName: '研发群',
  md5: 'g'.repeat(32),
  type: 'group'
}

const userContact: Contact = {
  m_nsUsrName: 'wxid_friend',
  m_nsNickName: '好友',
  md5: 'u'.repeat(32),
  type: 'user'
}

/** 时区无关：用本地字段构造，别写死 UTC 偏移。 */
const at = (year: number, month: number, day: number): number =>
  new Date(year, month - 1, day).getTime()

const statsResult = (): GroupMemberStatsResult => ({
  conversationId: groupContact.md5,
  startTime: at(2026, 6, 15),
  endTime: at(2026, 9, 4),
  freshness: 'fresh',
  complete: true,
  memberCount: 2,
  activeMemberCount: 1,
  silentMemberCount: 1,
  activeMembers: [
    {
      senderId: 'wxid_a',
      displayName: '张三',
      groupNickname: '老张',
      messageCount: 12,
      lastMessageTime: at(2026, 9, 1)
    }
  ],
  silentMembers: [{ senderId: 'wxid_b', displayName: '李四', groupNickname: '' }],
  unattributedMessages: 0,
  excludedSystemMessages: 0,
  firstMessageTime: at(2026, 6, 15),
  limitations: []
})

beforeEach(() => {
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    getGroupMemberStats: vi.fn().mockResolvedValue(statsResult()),
    getPersonalWechatSenderStatus: vi.fn().mockResolvedValue({ canSendText: false })
  }
})

function renderHeader(contact: Contact, isGroupChat: boolean): void {
  render(
    <TooltipProvider>
      <ChatHeader
        contact={contact}
        isGroupChat={isGroupChat}
        loadedCount={10}
        filteredCount={10}
        contentFilter=""
        isAiLoading={false}
        onContentFilterChange={vi.fn()}
        onTestSend={vi.fn()}
        onOpenAiSettings={vi.fn()}
      />
    </TooltipProvider>
  )
}

describe('ChatHeader · 群发言统计入口', () => {
  it('群聊把「群发言统计」做成直接按钮，不再藏在「更多功能」下拉里', () => {
    renderHeader(groupContact, true)

    // 旧入口连同「刷新数据」一起下线，不能再回来。
    expect(screen.queryByRole('button', { name: '更多功能' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: '刷新数据' })).toBeNull()

    // 是普通按钮，不是菜单触发器 —— 点了就该开面板，不该弹下拉。
    expect(screen.getByRole('button', { name: '群发言统计' })).not.toHaveAttribute('aria-haspopup')
  })

  it('点击入口直接打开群发言统计面板', async () => {
    const user = userEvent.setup()
    renderHeader(groupContact, true)

    await user.click(screen.getByRole('button', { name: '群发言统计' }))

    expect(await screen.findByRole('dialog', { name: '群发言统计 · 研发群' })).toBeInTheDocument()
  })

  it('非群聊不显示「群发言统计」入口', () => {
    renderHeader(userContact, false)

    expect(screen.queryByRole('button', { name: '群发言统计' })).toBeNull()
  })
})
