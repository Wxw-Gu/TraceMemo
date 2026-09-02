import type { ReactElement } from 'react'
import { render, screen, type RenderResult } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ChatHeader } from '../../src/renderer/src/components/chat/ChatHeader'
import { ChatStatusBar } from '../../src/renderer/src/components/chat/ChatStatusBar'
import { ExportMenu } from '../../src/renderer/src/components/chat/ExportMenu'
import { TooltipProvider } from '../../src/renderer/src/components/ui'
import type { Contact } from '../../src/shared/types'

const contact: Contact = {
  md5: 'group-md5',
  m_nsUsrName: 'group@chatroom',
  m_nsNickName: '测试群',
  type: 'group'
}

function renderWithTooltip(element: ReactElement): RenderResult {
  return render(<TooltipProvider>{element}</TooltipProvider>)
}

describe('chat menus', () => {
  it('runs the selected export range and closes the menu', async () => {
    const user = userEvent.setup()
    const onExport = vi.fn()
    renderWithTooltip(<ExportMenu disabled={false} onExport={onExport} />)

    const trigger = screen.getByRole('button', { name: '导出' })
    await user.click(trigger)
    await user.click(screen.getByRole('menuitem', { name: '导出近 7 天' }))

    expect(onExport).toHaveBeenCalledWith(7)
    expect(screen.queryByRole('menuitem', { name: '导出近 7 天' })).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('closes the chat More menu with Escape and invokes refresh data once', async () => {
    const user = userEvent.setup()
    const onRefreshData = vi.fn()
    renderWithTooltip(
      <ChatHeader
        contact={contact}
        isGroupChat
        loadedCount={3}
        filteredCount={3}
        contentFilter=""
        isAiLoading={false}
        onContentFilterChange={vi.fn()}
        onRefresh={vi.fn()}
        onRefreshData={onRefreshData}
        onTestSend={vi.fn()}
        onOpenAiSettings={vi.fn()}
      />
    )

    const trigger = screen.getByRole('button', { name: '更多' })
    await user.click(trigger)
    expect(screen.getByRole('menuitem', { name: '刷新数据' })).toBeVisible()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menuitem', { name: '刷新数据' })).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()

    await user.click(trigger)
    await user.click(screen.getByRole('menuitem', { name: '刷新数据' }))
    expect(onRefreshData).toHaveBeenCalledOnce()
  })

  it('keeps header search and actions wired to their existing callbacks', async () => {
    const user = userEvent.setup()
    const onContentFilterChange = vi.fn()
    const onRefresh = vi.fn()
    const onOpenAiSettings = vi.fn()
    renderWithTooltip(
      <ChatHeader
        contact={contact}
        isGroupChat
        loadedCount={8}
        filteredCount={2}
        contentFilter=""
        isAiLoading={false}
        onContentFilterChange={onContentFilterChange}
        onRefresh={onRefresh}
        onRefreshData={vi.fn()}
        onTestSend={vi.fn()}
        onOpenAiSettings={onOpenAiSettings}
      />
    )

    await user.click(screen.getByRole('button', { name: '搜索当前聊天' }))
    const searchInput = screen.getByRole('textbox', { name: '搜索当前聊天内容' })
    expect(searchInput).toHaveFocus()
    await user.type(searchInput, '测试')
    expect(onContentFilterChange).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: '关闭搜索' }))
    expect(onContentFilterChange).toHaveBeenLastCalledWith('')
    expect(screen.queryByRole('textbox', { name: '搜索当前聊天内容' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '刷新聊天记录' }))
    await user.click(screen.getByRole('button', { name: '生成 AI 日报' }))
    expect(onRefresh).toHaveBeenCalledOnce()
    expect(onOpenAiSettings).toHaveBeenCalledOnce()
  })

  it('preserves status switch, reload, and jump callbacks', async () => {
    const user = userEvent.setup()
    const onShowAvatarChange = vi.fn()
    const onReloadAvatars = vi.fn()
    const onJumpToLatest = vi.fn()
    renderWithTooltip(
      <ChatStatusBar
        count={5}
        showAvatar={false}
        isAtLatest={false}
        isReloadingAvatars={false}
        onShowAvatarChange={onShowAvatarChange}
        onReloadAvatars={onReloadAvatars}
        onJumpToLatest={onJumpToLatest}
      />
    )

    await user.click(screen.getByRole('switch', { name: '显示头像' }))
    await user.click(screen.getByRole('button', { name: '重新加载头像' }))
    await user.click(screen.getByRole('button', { name: '跳转到最新消息' }))

    expect(onShowAvatarChange).toHaveBeenCalledWith(true)
    expect(onReloadAvatars).toHaveBeenCalledOnce()
    expect(onJumpToLatest).toHaveBeenCalledOnce()
  })

  it('keeps loading and latest status actions disabled', () => {
    renderWithTooltip(
      <ChatStatusBar
        count={5}
        showAvatar
        isAtLatest
        isReloadingAvatars
        onShowAvatarChange={vi.fn()}
        onReloadAvatars={vi.fn()}
        onJumpToLatest={vi.fn()}
      />
    )

    expect(screen.getByRole('button', { name: '加载中' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '已是最新消息' })).toBeDisabled()
  })
})
