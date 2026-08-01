import { render, screen, type RenderResult } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { DatabaseConnectionPage } from '../../src/renderer/src/components/DatabaseConnectionPage'

function renderPage(
  overrides: Partial<ComponentProps<typeof DatabaseConnectionPage>> = {}
): RenderResult & { props: ComponentProps<typeof DatabaseConnectionPage> } {
  const props = {
    platform: 'win32',
    mode: 'manual' as const,
    dbKey: '',
    dbRoot: '',
    showDbKey: false,
    isFetching: false,
    status: '',
    statusKind: 'normal' as const,
    showMacKeyFaq: false,
    macKeyFaqUrl: 'https://fixture.invalid/mac',
    onModeChange: vi.fn(),
    onDbKeyChange: vi.fn(),
    onDbRootChange: vi.fn(),
    onToggleDbKey: vi.fn(),
    onAutoGetKey: vi.fn(),
    onManualConnect: vi.fn(),
    onPasteKey: vi.fn(),
    onClearKey: vi.fn(),
    ...overrides
  }
  return { props, ...render(<DatabaseConnectionPage {...props} />) }
}

describe('DatabaseConnectionPage', () => {
  it('keeps connect disabled until a valid 64-character key is supplied', () => {
    const { rerender, props } = renderPage()
    expect(screen.getByRole('button', { name: '连接数据库' })).toBeDisabled()
    rerender(<DatabaseConnectionPage {...props} dbKey={'a'.repeat(64)} />)
    expect(screen.getByRole('button', { name: '连接数据库' })).toBeEnabled()
  })

  it('shows a recoverable error and keeps form actions available', async () => {
    const onManualConnect = vi.fn()
    renderPage({
      dbKey: 'b'.repeat(64),
      status: '数据库密钥无效，请重新输入',
      statusKind: 'error',
      onManualConnect
    })
    expect(screen.getByText('数据库密钥无效，请重新输入')).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: '连接数据库' }))
    expect(onManualConnect).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: '从剪贴板粘贴并安全保存' })).toBeEnabled()
  })
})
