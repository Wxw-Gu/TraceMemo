import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ConversationSidebarHeader } from '../../src/renderer/src/components/conversation/ConversationSidebarHeader'

describe('ConversationSidebarHeader', () => {
  it('refreshes the conversation list from the archive header', async () => {
    const onRefresh = vi.fn()
    render(
      <ConversationSidebarHeader
        totalCount={1306}
        searchValue=""
        onSearchChange={vi.fn()}
        refreshing={false}
        onRefresh={onRefresh}
      />
    )

    expect(screen.getByText('1306 个会话')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '刷新会话列表' }))
    expect(onRefresh).toHaveBeenCalledOnce()
  })

  it('disables the refresh button while contacts are loading', () => {
    render(
      <ConversationSidebarHeader
        totalCount={12}
        searchValue="测试"
        onSearchChange={vi.fn()}
        refreshing
        onRefresh={vi.fn()}
      />
    )

    expect(screen.getByRole('button', { name: '正在刷新会话列表' })).toBeDisabled()
    expect(screen.getByDisplayValue('测试')).toBeInTheDocument()
  })
})
