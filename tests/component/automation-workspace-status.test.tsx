import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ToastProvider } from '../../src/renderer/src/components/ui'
import { AutomationWorkspace } from '../../src/renderer/src/features/automation/AutomationWorkspace'

/**
 * 首页状态卡只讲用户能理解的状态。
 *
 * 以前这里挂着一句「当前仅能捕获最近活跃的会话」，还用 Tooltip 解释了
 * 「微信底层只会上报有表发生了变化」——那是开发报告的内容，不该出现在普通用户界面。
 * 真实边界改挂在「规则编辑页 → 所有群聊」那个具体上下文里。
 */
describe('Automation 首页状态卡', () => {
  function renderWorkspace(): void {
    render(
      <ToastProvider>
        <AutomationWorkspace dbReady={false} />
      </ToastProvider>
    )
  }

  it('仍然如实展示「消息监听」与发送能力两项', () => {
    renderWorkspace()

    expect(screen.getByText('消息监听')).toBeInTheDocument()
    expect(screen.getByText('发送能力')).toBeInTheDocument()
  })

  it('不再出现「最近活跃的会话」这类实现说明', () => {
    renderWorkspace()

    expect(screen.queryByText(/最近活跃的会话/)).toBeNull()
    expect(screen.queryByText(/有表发生了变化/)).toBeNull()
  })

  it('首页不出现底层实现词', () => {
    renderWorkspace()

    expect(document.body.textContent).not.toMatch(
      /WCDB|SessionTable|表变化|native event|回读机制|coalesce/
    )
  })
})
