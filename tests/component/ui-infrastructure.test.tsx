import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ToastProvider,
  TooltipProvider,
  useToast
} from '../../src/renderer/src/components/ui'

function ToastDemo(): React.ReactElement {
  const { toast } = useToast()
  return (
    <Button onClick={() => toast({ title: '已保存', description: '设置已更新' })}>显示通知</Button>
  )
}

describe('TraceMemo UI infrastructure', () => {
  it('restores focus after a dialog is closed with Escape', async () => {
    const user = userEvent.setup()
    render(
      <Dialog>
        <DialogTrigger asChild>
          <Button>打开对话框</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogTitle>测试对话框</DialogTitle>
          <Input aria-label="测试输入" />
        </DialogContent>
      </Dialog>
    )

    const trigger = screen.getByRole('button', { name: '打开对话框' })
    await user.click(trigger)
    expect(screen.getByRole('dialog', { name: '测试对话框' })).toBeVisible()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: '测试对话框' })).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('closes a popover when the user clicks outside', async () => {
    const user = userEvent.setup()
    render(
      <Popover>
        <PopoverTrigger asChild>
          <Button>打开菜单</Button>
        </PopoverTrigger>
        <PopoverContent>
          <p>菜单内容</p>
        </PopoverContent>
      </Popover>
    )

    await user.click(screen.getByRole('button', { name: '打开菜单' }))
    expect(screen.getByText('菜单内容')).toBeVisible()
    await user.click(document.body)
    expect(screen.queryByText('菜单内容')).not.toBeInTheDocument()
  })

  it('renders toast notifications through the shared provider', async () => {
    const user = userEvent.setup()
    render(
      <TooltipProvider>
        <ToastProvider>
          <ToastDemo />
        </ToastProvider>
      </TooltipProvider>
    )

    await user.click(screen.getByRole('button', { name: '显示通知' }))
    expect(screen.getByText('已保存')).toBeVisible()
    expect(screen.getByText('设置已更新')).toBeVisible()

    const close = screen.getByRole('button', { name: '关闭通知' })
    expect(close).toHaveClass('h-7', 'w-7', 'border-0', 'bg-transparent')
    await user.click(close)
    expect(screen.queryByText('已保存')).not.toBeInTheDocument()
  })
})
