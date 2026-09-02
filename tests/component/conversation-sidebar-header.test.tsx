import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ConversationSidebarHeader } from '../../src/renderer/src/components/conversation/ConversationSidebarHeader'
import { TooltipProvider } from '../../src/renderer/src/components/ui'

function renderHeader(
  overrides: Partial<React.ComponentProps<typeof ConversationSidebarHeader>> = {}
): void {
  render(
    <TooltipProvider>
      <ConversationSidebarHeader
        totalCount={1306}
        searchValue=""
        onSearchChange={vi.fn()}
        refreshing={false}
        onRefresh={vi.fn()}
        {...overrides}
      />
    </TooltipProvider>
  )
}

describe('ConversationSidebarHeader', () => {
  it('refreshes the conversation list from the archive header', async () => {
    const onRefresh = vi.fn()
    renderHeader({ onRefresh })

    expect(screen.getByText('1306 个会话')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '刷新会话列表' }))
    expect(onRefresh).toHaveBeenCalledOnce()
  })

  it('disables the refresh button while contacts are loading', () => {
    renderHeader({ totalCount: 12, searchValue: '测试', refreshing: true })

    expect(screen.getByRole('button', { name: '正在刷新会话列表' })).toBeDisabled()
    expect(screen.getByDisplayValue('测试')).toBeInTheDocument()
  })

  it('keeps the controlled conversation search callback and search semantics', async () => {
    const onSearchChange = vi.fn()
    renderHeader({ onSearchChange })

    const search = screen.getByRole('searchbox', { name: '搜索会话' })
    await userEvent.type(search, '产品')

    expect(onSearchChange).toHaveBeenCalled()
    expect(onSearchChange.mock.calls[0]).toEqual(['产'])
  })
})
