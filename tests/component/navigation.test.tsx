import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { PrimaryNavigation } from '../../src/renderer/src/components/layout/PrimaryNavigation'
import { PRIMARY_NAV_ITEMS } from '../../src/renderer/src/components/layout/navigation'

describe('PrimaryNavigation', () => {
  it('shows every real top-level page exactly once and emits the selected page', async () => {
    const onPageChange = vi.fn()
    render(<PrimaryNavigation activePage="archive" onPageChange={onPageChange} />)

    const navigation = screen.getByRole('navigation', { name: '一级导航' })
    expect(navigation).toBeInTheDocument()
    for (const item of PRIMARY_NAV_ITEMS) {
      expect(screen.getAllByRole('button', { name: item.label })).toHaveLength(1)
    }

    await userEvent.click(screen.getByRole('button', { name: '设置' }))
    expect(onPageChange).toHaveBeenCalledWith('settings')
  })
})
