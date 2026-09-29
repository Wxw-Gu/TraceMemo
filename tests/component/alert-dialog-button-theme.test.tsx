/**
 * 弹窗按钮必须自带主题样式。
 *
 * 这两处曾经把 Radix 的 primitive **原样导出**，渲染出来是浏览器默认的黑白方角
 * 按钮 —— 跟主界面的主题色按钮完全脱节，用户会以为是两个不同的产品。
 *
 * 所以这里锁的是"类名里确实带了按钮变体"，而不是某个具体颜色值。
 * 规范见 `docs/development/ui-guidelines.md`。
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter
} from '../../src/renderer/src/components/ui/alert-dialog'

function renderFooter(children: React.ReactNode): void {
  render(
    <AlertDialog open>
      <AlertDialogContent>
        <AlertDialogFooter>{children}</AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

describe('弹窗按钮的主题样式', () => {
  it('确认按钮走主题色实底', () => {
    renderFooter(<AlertDialogAction>开始索引</AlertDialogAction>)

    const action = screen.getByRole('button', { name: '开始索引' })
    expect(action.className).toContain('bg-primary')
    expect(action.className).toContain('text-primary-foreground')
  })

  it('取消按钮走次要描边，不抢主按钮的主题色', () => {
    renderFooter(<AlertDialogCancel>取消</AlertDialogCancel>)

    const cancel = screen.getByRole('button', { name: '取消' })
    expect(cancel.className).toContain('border')
    expect(cancel.className).not.toContain('bg-primary')
  })

  it('调用方传 className 能覆盖成危险动作', () => {
    renderFooter(
      <AlertDialogAction className="bg-destructive text-destructive-foreground">
        删除
      </AlertDialogAction>
    )

    const action = screen.getByRole('button', { name: '删除' })
    expect(action.className).toContain('bg-destructive')
    // 只断言"独立的 bg-primary 类不存在"—— `hover:bg-primary-hover` 含同样子串，
    // 用裸字符串匹配会误伤。
    expect(action.className).not.toMatch(/(^|\s)bg-primary(\s|$)/)
  })
})
