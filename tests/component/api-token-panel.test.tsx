import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ApiRuntimePanel } from '../../src/renderer/src/features/api-center/components/ApiRuntimePanel'

const token = 'fixture_token_visible_only_after_user_action'

function renderPanel(revealedToken = ''): {
  reveal: ReturnType<typeof vi.fn>
  copy: ReturnType<typeof vi.fn>
  rotate: ReturnType<typeof vi.fn>
} {
  const reveal = vi.fn(async () => undefined)
  const copy = vi.fn(async () => undefined)
  const rotate = vi.fn(async () => undefined)
  render(
    <ApiRuntimePanel
      service={{ running: true, host: '127.0.0.1', port: 6131 }}
      tokenStatus={{ available: true, hasToken: true, maskedToken: '••••••••••••••••' }}
      revealedToken={revealedToken}
      dbReady
      response={null}
      history={[]}
      onControl={vi.fn()}
      onOpenSettings={vi.fn()}
      onCopy={vi.fn(async () => undefined)}
      onRevealToken={reveal}
      onHideToken={vi.fn()}
      onCopyToken={copy}
      onRotateToken={rotate}
    />
  )
  return { reveal, copy, rotate }
}

describe('API Token panel', () => {
  it('masks the token by default and exposes only explicit actions', async () => {
    const actions = renderPanel()
    expect(screen.getByText('••••••••••••••••')).toBeInTheDocument()
    expect(screen.queryByText(token)).not.toBeInTheDocument()
    expect(screen.getByText('Token 已生成')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '显示 Token' }))
    expect(actions.reveal).toHaveBeenCalledOnce()
    await userEvent.click(screen.getByRole('button', { name: '复制 Token' }))
    expect(actions.copy).toHaveBeenCalledOnce()
    await userEvent.click(screen.getByRole('button', { name: '重新生成 Token' }))
    expect(actions.rotate).toHaveBeenCalledOnce()
  })

  it('shows the full token only when reveal state is explicitly present', () => {
    renderPanel(token)
    expect(screen.getByText(token)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '隐藏 Token' })).toBeInTheDocument()
  })

  it('shows a safe-storage error and disables token actions when unavailable', () => {
    render(
      <ApiRuntimePanel
        service={{ running: false, host: '127.0.0.1', port: 6131 }}
        tokenStatus={{
          available: false,
          hasToken: false,
          maskedToken: '••••••••••••••••',
          error: '系统安全存储不可用，本地 API 已安全停用。请检查系统钥匙串或凭据服务后重试。'
        }}
        revealedToken=""
        dbReady
        response={null}
        history={[]}
        onControl={vi.fn()}
        onOpenSettings={vi.fn()}
        onCopy={vi.fn(async () => undefined)}
        onRevealToken={vi.fn(async () => undefined)}
        onHideToken={vi.fn()}
        onCopyToken={vi.fn(async () => undefined)}
        onRotateToken={vi.fn(async () => undefined)}
      />
    )
    expect(screen.getByText(/系统安全存储不可用/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '显示 Token' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '复制 Token' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '重新生成 Token' })).toBeDisabled()
  })
})
