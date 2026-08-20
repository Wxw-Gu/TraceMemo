import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { DatabaseKeyAutoDetect } from '../../src/renderer/src/features/settings/database-key/DatabaseKeyAutoDetect'
import { DatabaseKeyDiagnostics } from '../../src/renderer/src/features/settings/database-key/DatabaseKeyDiagnostics'
import { DatabaseKeyDangerZone } from '../../src/renderer/src/features/settings/database-key/DatabaseKeyDangerZone'
import { DatabaseKeyEditor } from '../../src/renderer/src/features/settings/database-key/DatabaseKeyEditor'
import { DatabaseKeyStatus } from '../../src/renderer/src/features/settings/database-key/DatabaseKeyStatus'
import type { DatabaseKeyState } from '../../src/renderer/src/features/settings/database-key/types'
import { TooltipProvider } from '../../src/renderer/src/components/ui'

const state: DatabaseKeyState = {
  status: 'saved',
  saved: true,
  encryptionAvailable: true,
  autoPhase: 0,
  environment: {
    platform: 'win32',
    osVersion: 'Windows 11',
    appVersion: '2.2.2',
    wechatVersion: '4.1.0',
    dataStructureVersion: 'WCDB',
    dataDirectoryDetected: true,
    diagnosticSummary: 'fixture',
    autoDetectSupported: true,
    wechatRunning: true,
    accountIdentified: true,
    dbConnected: true,
    encryptionAvailable: true
  }
}

describe('database key controls', () => {
  it('keeps auto-detect and refresh callbacks separate', async () => {
    const user = userEvent.setup()
    const onDetect = vi.fn()
    const onRefresh = vi.fn()
    render(
      <DatabaseKeyAutoDetect
        state={{ ...state, status: 'auto-detect-error', error: '没有找到候选密钥' }}
        disabled={false}
        onDetect={onDetect}
        onRefresh={onRefresh}
      />
    )

    await user.click(screen.getByRole('button', { name: '自动获取密钥' }))
    await user.click(screen.getByRole('button', { name: '刷新前置状态' }))
    expect(onDetect).toHaveBeenCalledOnce()
    expect(onRefresh).toHaveBeenCalledOnce()
  })

  it('keeps status validation and diagnostics copy actions available', async () => {
    const user = userEvent.setup()
    const onValidate = vi.fn()
    const onCopy = vi.fn()
    const { rerender } = render(
      <DatabaseKeyStatus
        state={state}
        dbReady
        selfInfo={{ wxid: 'wxid_fixture', nickname: '测试账号', accountRoot: 'fixture-account' }}
        disabled={false}
        onValidate={onValidate}
      />
    )

    await user.click(screen.getByRole('button', { name: '重新验证' }))
    expect(onValidate).toHaveBeenCalledOnce()

    rerender(
      <DatabaseKeyDiagnostics
        state={state}
        input={'a'.repeat(64)}
        wxid="wxid_fixture"
        accountRoot="fixture-account"
        onCopy={onCopy}
      />
    )
    await user.click(screen.getByText('查看密钥诊断'))
    await user.click(screen.getByRole('button', { name: '复制诊断信息' }))
    expect(onCopy).toHaveBeenCalledOnce()
  })

  it('uses shared button variants for editor actions without legacy visual classes', async () => {
    const user = userEvent.setup()
    const onValidate = vi.fn()
    const onSave = vi.fn()
    render(
      <TooltipProvider>
        <DatabaseKeyEditor
          value={'a'.repeat(64)}
          disabled={false}
          canSave
          onChange={vi.fn()}
          onPaste={vi.fn()}
          onValidate={onValidate}
          onSave={onSave}
        />
      </TooltipProvider>
    )

    const validate = screen.getByRole('button', { name: '验证密钥' })
    const save = screen.getByRole('button', { name: '保存密钥' })
    expect(validate).not.toHaveClass('database-key-secondary')
    expect(save).not.toHaveClass('database-key-primary')
    await user.click(validate)
    await user.click(save)
    expect(onValidate).toHaveBeenCalledOnce()
    expect(onSave).toHaveBeenCalledOnce()
  })

  it('restores focus to the actual destructive dialog trigger', async () => {
    const user = userEvent.setup()
    render(
      <DatabaseKeyDangerZone
        disabled={false}
        onClear={vi.fn()}
        onReplace={vi.fn()}
        onReturnToLogin={vi.fn()}
      />
    )

    const clearKey = screen.getByRole('button', { name: '清除密钥' })
    await user.click(clearKey)
    expect(screen.getByRole('alertdialog', { name: '确认清除数据库密钥？' })).toBeVisible()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(clearKey).toHaveFocus()
  })
})
