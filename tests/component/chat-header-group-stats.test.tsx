import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatHeader } from '../../src/renderer/src/components/chat/ChatHeader'
import { TooltipProvider } from '../../src/renderer/src/components/ui'
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

beforeEach(() => {
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    getGroupMemberStats: vi.fn(),
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

async function openMoreMenu(): Promise<void> {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: '更多功能' }))
  await waitFor(() => expect(screen.getByText('刷新数据')).toBeTruthy())
}

describe('ChatHeader · 群发言统计入口', () => {
  it('群聊显示「群发言统计」入口', async () => {
    renderHeader(groupContact, true)
    await openMoreMenu()
    expect(screen.getByText('群发言统计')).toBeTruthy()
  })

  it('非群聊不显示「群发言统计」入口', async () => {
    renderHeader(userContact, false)
    await openMoreMenu()
    expect(screen.queryByText('群发言统计')).toBeNull()
  })
})
