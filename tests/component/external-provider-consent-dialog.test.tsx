import { useState } from 'react'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  ExternalProviderConsentDialog,
  type ExternalProviderConsent
} from '../../src/renderer/src/components/search/ExternalProviderConsentDialog'

const consent: ExternalProviderConsent = {
  providerName: 'Remote Provider',
  recipient: 'remote@example.test'
}

describe('ExternalProviderConsentDialog', () => {
  it('renders provider details and confirms the controlled action', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()

    render(
      <ExternalProviderConsentDialog consent={consent} onConfirm={onConfirm} onCancel={vi.fn()} />
    )

    expect(screen.getByRole('dialog', { name: '确认发送本次搜索资料' })).toBeVisible()
    expect(screen.getByText('Remote Provider')).toBeVisible()
    expect(screen.getByRole('dialog')).toHaveTextContent('remote@example.test')

    await user.click(screen.getByRole('button', { name: '继续并发送' }))
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('treats the cancel button, Escape, and outside interaction as cancellation', async () => {
    const user = userEvent.setup()
    const onCancel = vi.fn()
    const { rerender } = render(
      <ExternalProviderConsentDialog consent={consent} onConfirm={vi.fn()} onCancel={onCancel} />
    )

    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(onCancel).toHaveBeenCalledOnce()

    rerender(
      <ExternalProviderConsentDialog consent={consent} onConfirm={vi.fn()} onCancel={onCancel} />
    )
    await user.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledTimes(2)

    rerender(
      <ExternalProviderConsentDialog consent={consent} onConfirm={vi.fn()} onCancel={onCancel} />
    )
    const overlay = screen.getByRole('dialog').previousElementSibling as HTMLElement
    await user.click(overlay)
    expect(onCancel).toHaveBeenCalledTimes(3)
  })

  it('restores focus to the opener after the dialog is cancelled', async () => {
    const user = userEvent.setup()

    function Harness(): React.ReactElement {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            打开授权确认
          </button>
          <ExternalProviderConsentDialog
            consent={open ? consent : null}
            onConfirm={() => setOpen(false)}
            onCancel={() => setOpen(false)}
          />
        </>
      )
    }

    render(<Harness />)
    const opener = screen.getByRole('button', { name: '打开授权确认' })
    await user.click(opener)
    expect(screen.getByRole('dialog', { name: '确认发送本次搜索资料' })).toBeVisible()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: '确认发送本次搜索资料' })).not.toBeInTheDocument()
    expect(opener).toHaveFocus()
  })
})
