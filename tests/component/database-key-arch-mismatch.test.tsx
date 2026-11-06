import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DatabaseKeyAutoDetect } from '../../src/renderer/src/features/settings/database-key/DatabaseKeyAutoDetect'
import type { DatabaseKeyState } from '../../src/renderer/src/features/settings/database-key/types'
import type { DatabaseKeyEnvironment } from '../../src/shared/database-key'
import type { MacKeyFlow } from '../../src/shared/macos-arch'

function environment(macKeyFlow: MacKeyFlow, hardwareArchitecture: 'arm64' | 'x64'): DatabaseKeyEnvironment {
  return {
    platform: 'darwin',
    architecture: macKeyFlow === 'intel' ? 'x64' : 'x64',
    hardwareArchitecture,
    underARM64Translation: macKeyFlow === 'arch-mismatch',
    macKeyFlow,
    archAnomalies: [],
    osVersion: 'macOS 15.7.7 (x64)',
    appVersion: 'v2.5.3',
    wechatVersion: '4.1.13',
    dataStructureVersion: 'v4',
    dataDirectoryDetected: true,
    diagnosticSummary: 'fixture',
    autoDetectSupported: true,
    wechatRunning: true,
    accountIdentified: true,
    dbConnected: false,
    encryptionAvailable: true
  }
}

function state(macKeyFlow: MacKeyFlow): DatabaseKeyState {
  return {
    status: 'idle',
    saved: false,
    encryptionAvailable: true,
    autoPhase: 0,
    environment: environment(macKeyFlow, macKeyFlow === 'intel' ? 'x64' : 'arm64')
  }
}

describe('DatabaseKeyAutoDetect arch mismatch', () => {
  it('explains the mismatch and disables auto detection', () => {
    render(
      <DatabaseKeyAutoDetect
        state={state('arch-mismatch')}
        disabled={false}
        onDetect={vi.fn()}
        onRefresh={vi.fn()}
      />
    )

    expect(
      screen.getByText('当前电脑使用 Apple 芯片，但你正在运行 Intel 版 TraceMemo。')
    ).toBeTruthy()
    expect(screen.getByText('已保存的微信数据库密钥无需重新获取。')).toBeTruthy()
    expect(screen.getByText('架构不匹配')).toBeTruthy()
    expect(screen.queryByText('Intel Mac 自动获取')).toBeNull()
    expect((screen.getByRole('button', { name: '自动获取密钥' }) as HTMLButtonElement).disabled).toBe(
      true
    )
  })

  it('keeps the Apple Silicon copy when the flow matches the hardware', () => {
    render(
      <DatabaseKeyAutoDetect
        state={state('apple-silicon')}
        disabled={false}
        onDetect={vi.fn()}
        onRefresh={vi.fn()}
      />
    )

    expect(screen.getByText('macOS 自动获取')).toBeTruthy()
    expect(screen.queryByText('当前电脑使用 Apple 芯片，但你正在运行 Intel 版 TraceMemo。')).toBeNull()
    expect((screen.getByRole('button', { name: '自动获取密钥' }) as HTMLButtonElement).disabled).toBe(
      false
    )
  })

  it('still labels a genuine Intel Mac as Intel', () => {
    render(
      <DatabaseKeyAutoDetect
        state={state('intel')}
        disabled={false}
        onDetect={vi.fn()}
        onRefresh={vi.fn()}
      />
    )

    expect(screen.getByText('Intel Mac 自动获取')).toBeTruthy()
    expect(screen.queryByText('架构不匹配')).toBeNull()
  })
})
