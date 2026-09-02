import { useState } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SkillPreviewDialog } from '../../src/renderer/src/features/api-center/components/SkillPreviewDialog'

const content = `# TraceMemo Reader

## 能力
- 读取本地聊天记录

仅在用户授权后访问。`

function Harness({ onClose = vi.fn() }: { onClose?: () => void }): React.ReactElement {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        预览 Skill
      </button>
      {open && (
        <SkillPreviewDialog
          content={content}
          version="v1.2"
          onClose={() => {
            onClose()
            setOpen(false)
          }}
        />
      )}
    </>
  )
}

describe('SkillPreviewDialog', () => {
  it('renders the line-based preview and switches between rendered and raw content', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole('button', { name: '预览 Skill' }))
    const dialog = screen.getByRole('dialog', { name: 'TraceMemo Reader Skill 预览' })
    expect(dialog).toBeVisible()
    expect(screen.getByText('v1.2')).toBeVisible()
    expect(screen.getByRole('heading', { name: '能力' })).toBeVisible()
    expect(screen.getByText('读取本地聊天记录')).toBeVisible()
    expect(screen.queryByText(content)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '原始文本' }))
    expect(dialog.querySelector('pre')?.textContent).toBe(content)
    await user.click(screen.getByRole('button', { name: '渲染预览' }))
    expect(screen.getByRole('heading', { name: '能力' })).toBeVisible()
  })

  it('closes with Escape or the overlay and restores focus to the opener', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)
    const opener = screen.getByRole('button', { name: '预览 Skill' })

    await user.click(opener)
    await user.keyboard('{Escape}')
    expect(
      screen.queryByRole('dialog', { name: 'TraceMemo Reader Skill 预览' })
    ).not.toBeInTheDocument()
    await waitFor(() => expect(opener).toHaveFocus())

    await user.click(opener)
    const dialog = screen.getByRole('dialog', { name: 'TraceMemo Reader Skill 预览' })
    await user.click(dialog.previousElementSibling as HTMLElement)
    expect(
      screen.queryByRole('dialog', { name: 'TraceMemo Reader Skill 预览' })
    ).not.toBeInTheDocument()
    await waitFor(() => expect(opener).toHaveFocus())
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
