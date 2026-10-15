import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { AccountSummary } from '../../src/renderer/src/components/account/AccountSummary'
import { AccountOverview } from '../../src/renderer/src/features/settings/account-database/AccountOverview'
import { ConnectionHealthSection } from '../../src/renderer/src/features/settings/account-database/ConnectionHealthSection'
import type { ConnectionDiagnostic } from '../../src/renderer/src/features/settings/account-database/types'
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

  it('renders connection states with SVG glyphs and keeps checking accessible', () => {
    const diagnostics: ConnectionDiagnostic[] = [
      { id: 'db-key', label: '数据库密钥', status: 'success', result: '已用于当前连接' },
      { id: 'contacts', label: '联系人索引', status: 'warning', result: '索引待更新' },
      { id: 'messages', label: '消息数据库', status: 'error', result: '读取失败' },
      { id: 'identity', label: '账号身份', status: 'idle', result: '尚未检测' },
      { id: 'image-key', label: '图片解密密钥', status: 'unavailable', result: '未配置' }
    ]
    const { container, rerender } = render(<ConnectionHealthSection diagnostics={diagnostics} />)

    const icons = container.querySelectorAll('.settings-diagnostic-icon:not(.checking)')
    expect(icons).toHaveLength(diagnostics.length)
    icons.forEach((icon) => {
      expect(icon).toHaveAttribute('aria-hidden', 'true')
      expect(icon.querySelector('svg')).toHaveAttribute('viewBox', '0 0 24 24')
    })
    expect(container.textContent).not.toMatch(/[✓!×—]/)

    rerender(
      <ConnectionHealthSection
        diagnostics={[{ id: 'db-key', label: '数据库密钥', status: 'checking', result: '检测中' }]}
      />
    )
    expect(screen.getByLabelText('检测中')).toHaveClass('checking')
    expect(container.querySelector('.checking svg')).toBeNull()
  })

  it('keeps the account settings button clickable with a centered-viewBox SVG', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(
      <AccountSummary
        selfInfo={{
          wxid: 'wxid_fixture',
          nickname: '测试账号',
          accountRoot: '/fixture/account'
        }}
        dbReady
        onClick={onClick}
      />
    )

    const button = screen.getByRole('button', { name: '设置' })
    expect(button.querySelector('svg')).toHaveAttribute('viewBox', '0 0 24 24')
    expect(button.querySelector('svg circle')).toHaveAttribute('cx', '12')
    expect(button.querySelector('svg circle')).toHaveAttribute('cy', '12')
    await user.click(button)
    expect(onClick).toHaveBeenCalledOnce()
  })
})
