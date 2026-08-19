import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ChatHeader } from '../../src/renderer/src/components/chat/ChatHeader'
import { ExportMenu } from '../../src/renderer/src/components/chat/ExportMenu'
import type { Contact } from '../../src/shared/types'

const contact: Contact = {
  md5: 'group-md5',
  m_nsUsrName: 'group@chatroom',
  m_nsNickName: '测试群',
  type: 'group'
}

describe('chat menus', () => {
  it('runs the selected export range and closes the menu', async () => {
    const user = userEvent.setup()
    const onExport = vi.fn()
    render(<ExportMenu disabled={false} onExport={onExport} />)

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
    render(
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
})
