import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ConversationSidebar } from '../../src/renderer/src/components/conversation/ConversationSidebar'

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 58,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 58,
        size: 58
      }))
  })
}))

describe('ConversationSidebar', () => {
  it('keeps official accounts in their own collapsible section', async () => {
    render(
      <ConversationSidebar
        contacts={[
          {
            m_nsUsrName: 'gh_fixture',
            m_nsNickName: '测试公众号',
            md5: 'official-md5',
            type: 'user',
            isOfficialAccount: true
          },
          {
            m_nsUsrName: 'wxid_fixture',
            m_nsNickName: '测试联系人',
            md5: 'contact-md5',
            type: 'user'
          }
        ]}
        selectedContact={null}
        onSelectContact={vi.fn()}
        onSearch={vi.fn()}
        onContentFilter={vi.fn()}
        width={320}
        selfInfo={null}
        dbReady
        onOpenSettings={vi.fn()}
        onRefresh={vi.fn(async () => undefined)}
      />
    )

    expect(screen.getByRole('button', { name: '公众号 (1)' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '联系人 (1)' })).toBeInTheDocument()
    expect(screen.queryByText('测试公众号')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '公众号 (1)' }))
    expect(screen.getByText('测试公众号')).toBeInTheDocument()
  })
})
