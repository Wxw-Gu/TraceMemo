import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { AccountOverview } from '../../src/renderer/src/features/settings/account-database/AccountOverview'
import { TooltipProvider } from '../../src/renderer/src/components/ui'

describe('account database controls', () => {
  it('keeps overview actions and disabled state connected', async () => {
    const user = userEvent.setup()
    const onCheck = vi.fn()
    const onOpenDirectory = vi.fn()
    const onCopyDirectory = vi.fn()
    const onSwitchAccount = vi.fn()
    render(
      <TooltipProvider>
        <AccountOverview
          selfInfo={{
            wxid: 'wxid_fixture',
            nickname: '测试账号',
            accountRoot: '/fixture/account'
          }}
          connectionStatus="success"
          lastCheckedLabel="刚刚"
          isChecking={false}
          onCheck={onCheck}
          onOpenDirectory={onOpenDirectory}
          onCopyDirectory={onCopyDirectory}
          onSwitchAccount={onSwitchAccount}
        />
      </TooltipProvider>
    )

    await user.click(screen.getByRole('button', { name: '重新检测' }))
    await user.click(screen.getByRole('button', { name: '打开账号目录' }))
    await user.click(screen.getByRole('button', { name: '切换账号' }))
    await user.click(screen.getByRole('button', { name: '复制账号目录' }))

    expect(onCheck).toHaveBeenCalledOnce()
    expect(onOpenDirectory).toHaveBeenCalledOnce()
    expect(onSwitchAccount).toHaveBeenCalledOnce()
    expect(onCopyDirectory).toHaveBeenCalledOnce()
  })

  it('disables directory actions when no account root is available', () => {
    render(
      <TooltipProvider>
        <AccountOverview
          selfInfo={null}
          connectionStatus="unavailable"
          lastCheckedLabel="尚未检测"
          isChecking
          onCheck={vi.fn()}
          onOpenDirectory={vi.fn()}
          onCopyDirectory={vi.fn()}
          onSwitchAccount={vi.fn()}
        />
      </TooltipProvider>
    )

    expect(screen.getByRole('button', { name: '正在检测...' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '打开账号目录' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '复制账号目录' })).toBeDisabled()
  })
})
