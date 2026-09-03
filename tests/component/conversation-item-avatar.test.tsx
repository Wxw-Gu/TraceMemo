import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ConversationItem } from '../../src/renderer/src/components/conversation/ConversationItem'
import type { Contact } from '../../src/shared/types'

const contact: Contact = {
  m_nsUsrName: 'wxid_fixture',
  m_nsNickName: '联系人',
  md5: 'fixture',
  type: 'user',
  avatar: 'https://old.example/avatar.jpg'
}

describe('ConversationItem avatar recovery', () => {
  it('refreshes only the failed contact and lets a newer prop replace the repaired source', async () => {
    const getContactAvatars = vi
      .fn()
      .mockResolvedValue({ wxid_fixture: 'data:image/png;base64,repaired' })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { getContactAvatars } as unknown as typeof window.api
    })

    const { rerender } = render(
      <ConversationItem contact={contact} active={false} onSelect={vi.fn()} />
    )
    fireEvent.error(screen.getByRole('img', { name: '联系人' }))

    await waitFor(() =>
      expect(screen.getByRole('img', { name: '联系人' })).toHaveAttribute(
        'src',
        'data:image/png;base64,repaired'
      )
    )
    expect(getContactAvatars).toHaveBeenCalledWith(['wxid_fixture'], { refresh: true })

    rerender(
      <ConversationItem
        contact={{ ...contact, avatar: 'https://new.example/avatar.jpg' }}
        active={false}
        onSelect={vi.fn()}
      />
    )
    expect(screen.getByRole('img', { name: '联系人' })).toHaveAttribute(
      'src',
      'https://new.example/avatar.jpg'
    )
  })
})
