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
    isConnecting: false,
    guideStep: 1 as const,
    environment: {
      platform: 'win32',
      osVersion: 'Windows fixture',
      appVersion: 'v2.1.6',
      wechatVersion: '4.1.9.57',
      dataStructureVersion: '微信 4.x（WCDB）',
      dataDirectoryDetected: true,
      diagnosticSummary: 'TraceMemo: v2.1.6',
      autoDetectSupported: true,
      wechatRunning: true,
      accountIdentified: false,
      dbConnected: false,
      encryptionAvailable: true
    },
    accounts: [
      {
        id: 'account-a',
        accountRoot: 'C:\\fixture\\account-a',
        directoryName: 'account-a',
        nickname: '脱敏账号 A',
        wxid: 'wxid_fixture_a',
        hasSavedDbKey: true,
        loginStatus: 'unknown' as const,
        selectedByInput: true
      }
    ],
    selectedAccountId: 'account-a',
    status: '',
    statusKind: 'normal' as const,
    showMacKeyFaq: false,
    macKeyFaqUrl: 'https://fixture.invalid/mac',
    onModeChange: vi.fn(),
    onDbKeyChange: vi.fn(),
    onDbRootChange: vi.fn(),
    onSelectAccount: vi.fn(),
    onSelectDbRoot: vi.fn(),
    onToggleDbKey: vi.fn(),
    onAutoGetKey: vi.fn(),
    onRefreshEnvironment: vi.fn(),
    onGuideNext: vi.fn(),
    onGuideBack: vi.fn(),
    onGuideCancel: vi.fn(),
    onValidateConnection: vi.fn(),
    onCopyDiagnostics: vi.fn(),
    onManualConnect: vi.fn(),
    onPasteKey: vi.fn(),
    onClearKey: vi.fn(),
    ...overrides
  }
  return { props, ...render(<DatabaseConnectionPage {...props} />) }
}

describe('DatabaseConnectionPage', () => {
  it('renders a discovered nickname and avatar before connection', () => {
    const { container } = renderPage({
      mode: 'automatic',
      accounts: [
        {
          id: 'account-a',
          accountRoot: 'C:\\fixture\\account-a',
          directoryName: 'account-a',
          nickname: '首次识别账号',
          wxid: 'fixture_account',
          avatar: 'https://wx.qlogo.cn/fixture/avatar',
          hasSavedDbKey: false,
          loginStatus: 'unknown',
          selectedByInput: true
        }
      ]
    })

    expect(screen.getByText('首次识别账号')).toBeVisible()
    expect(screen.getByText('fixture_account')).toBeVisible()
    expect(container.querySelector('.database-account-avatar img')).toHaveAttribute(
      'src',
      'https://wx.qlogo.cn/fixture/avatar'
    )
  })

  it('shows a directory-derived wxid without pretending profile data is available', () => {
    renderPage({
      mode: 'automatic',
      accounts: [
        {
          id: 'account-b',
          accountRoot: 'C:\\fixture\\wxid_fixture_b_ab12',
          directoryName: 'wxid_fixture_b_ab12',
          wxid: 'wxid_fixture',
          hasSavedDbKey: false,
          loginStatus: 'other',
          selectedByInput: false
        }
      ],
      selectedAccountId: ''
    })

    expect(screen.getByText('微信账号 wxid_fixture')).toBeVisible()
    expect(screen.getByText('昵称和头像需连接此账号后读取')).toBeVisible()
  })

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

  it('restores directory editing and selection after a failed connection', async () => {
    const onDbRootChange = vi.fn()
    const onSelectDbRoot = vi.fn()
    renderPage({
      dbKey: 'b'.repeat(64),
      dbRoot: 'Z:\\missing-wechat-data',
      status: '微信数据目录不存在，请重新选择目录',
      statusKind: 'error',
      onDbRootChange,
      onSelectDbRoot
    })

    await userEvent.clear(screen.getByLabelText('微信数据目录'))
    await userEvent.type(screen.getByLabelText('微信数据目录'), 'C:\\fixture-account')
    await userEvent.click(screen.getByRole('button', { name: '选择目录' }))

    expect(onDbRootChange).toHaveBeenCalled()
    expect(onSelectDbRoot).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: '连接数据库' })).toBeEnabled()
  })

  it('supports forward, back, cancel and safe diagnostic actions in onboarding', async () => {
    const onGuideNext = vi.fn()
    const onCopyDiagnostics = vi.fn()
    const { rerender, props } = renderPage({
      mode: 'automatic',
      guideStep: 1,
      onGuideNext,
      onCopyDiagnostics
    })

    expect(screen.getByText('4.1.9.57')).toBeVisible()
    expect(screen.getByText('微信 4.x（WCDB）')).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: '复制脱敏诊断摘要' }))
    await userEvent.click(screen.getByRole('button', { name: '检查完成，继续' }))
    expect(onCopyDiagnostics).toHaveBeenCalledOnce()
    expect(onGuideNext).toHaveBeenCalledOnce()

    rerender(<DatabaseConnectionPage {...props} mode="automatic" guideStep={2} />)
    expect(screen.getByRole('button', { name: '我已准备好' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '返回上一步' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '取消并重新检查' })).toBeEnabled()
  })
  it('provides the official Visual C++ runtime download on Windows', () => {
    renderPage({
      status: '当前 Windows 缺少 Microsoft Visual C++ 运行库',
      statusKind: 'error'
    })

    expect(screen.getByRole('link', { name: '下载运行库' })).toHaveAttribute(
      'href',
      'https://aka.ms/vc14/vc_redist.x64.exe'
    )
  })

})
