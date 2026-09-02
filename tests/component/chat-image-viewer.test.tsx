import { useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ChatImageViewer } from '../../src/renderer/src/components/chat/ChatImageViewer'
import { TooltipProvider } from '../../src/renderer/src/components/ui'

const imageUrl =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII='

function Harness({ onClose = vi.fn() }: { onClose?: () => void }): React.ReactElement {
  const [open, setOpen] = useState(false)
  return (
    <TooltipProvider>
      <button type="button" onClick={() => setOpen(true)}>
        查看图片
      </button>
      {open && (
        <ChatImageViewer
          imageUrl={imageUrl}
          onClose={() => {
            onClose()
            setOpen(false)
          }}
        />
      )}
    </TooltipProvider>
  )
}

describe('ChatImageViewer', () => {
  it('zooms, rotates, drags, and resets the image', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: '查看图片' }))
    const image = screen.getByAltText('图片预览')
    const stage = screen.getByLabelText('图片查看区域')

    expect(screen.getByText('100%')).toBeVisible()
    await user.click(screen.getByRole('button', { name: '放大' }))
    expect(screen.getByText('110%')).toBeVisible()
    await user.click(screen.getByRole('button', { name: '右旋转' }))
    expect(image).toHaveStyle({ transform: 'translate(0px, 0px) scale(1.1) rotate(90deg)' })

    fireEvent.mouseDown(stage, { clientX: 10, clientY: 15 })
    fireEvent.mouseMove(stage, { clientX: 35, clientY: 45 })
    fireEvent.mouseUp(stage)
    expect(image).toHaveStyle({ transform: 'translate(25px, 30px) scale(1.1) rotate(90deg)' })

    await user.click(screen.getByRole('button', { name: '重置图片' }))
    expect(screen.getByText('100%')).toBeVisible()
    expect(image).toHaveStyle({ transform: 'translate(0px, 0px) scale(1) rotate(0deg)' })
  })

  it('closes with Escape or the overlay and restores focus', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)
    const opener = screen.getByRole('button', { name: '查看图片' })

    await user.click(opener)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: '图片查看' })).not.toBeInTheDocument()
    await waitFor(() => expect(opener).toHaveFocus())

    await user.click(opener)
    const dialog = screen.getByRole('dialog', { name: '图片查看' })
    await user.click(dialog.previousElementSibling as HTMLElement)
    expect(screen.queryByRole('dialog', { name: '图片查看' })).not.toBeInTheDocument()
    await waitFor(() => expect(opener).toHaveFocus())
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
