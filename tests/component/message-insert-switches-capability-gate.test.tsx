import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { MsgInsertSwitchesSnapshot } from '../../src/shared/msg-insert-switch'

vi.mock('../../src/renderer/src/components/ui', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, useToast: () => ({ toast: () => undefined }) }
})

import { MessageInsertSwitches } from '../../src/renderer/src/features/automation/MessageInsertSwitches'

/**
 * 开关的门禁语义：
 *   开启 → 看 capability.canEnable
 *   关闭 → 永远可点（授权失效也不能把用户锁死在开启状态）
 */

function baseStatus(
  desiredEnabled: boolean,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    switch: 'recall_notice',
    scope: 'all_sessions',
    mode: 'rules',
    desiredEnabled,
    effectiveEnabled: desiredEnabled,
    operationOk: true,
    totalInstallableRooms: 0,
    readyInstallableRooms: 0,
    roomsWithoutTable: 0,
    totalShards: 0,
    targetShards: 0,
    configuredShards: 0,
    readyShards: 0,
    notReadyShards: 0,
    failedShards: 0,
    ...overrides
  }
}

function snapshotOf(
  canEnable: boolean,
  desired: { recall: boolean; exit: boolean },
  reasonCode = canEnable ? 'CAPABILITY_READY' : 'LICENSE_REQUIRED',
  message = canEnable ? '授权与组件均已就绪' : '未检测到有效授权'
): MsgInsertSwitchesSnapshot {
  return {
    success: true,
    helperAvailable: true,
    capability: {
      entitlementState: canEnable ? 'valid' : 'invalid',
      nativeComponentState: 'ready',
      databaseReady: true,
      canEnable,
      canDisable: true,
      reasonCode: reasonCode as never,
      message
    },
    switches: {
      recall_notice: baseStatus(desired.recall) as never,
      group_exit_notice: baseStatus(desired.exit, {
        switch: 'group_exit_notice',
        mode: 'event',
        effectiveEnabled: canEnable ? desired.exit : false
      }) as never
    }
  }
}

function installApi(snapshot: MsgInsertSwitchesSnapshot): void {
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    getMsgInsertSwitches: async () => snapshot,
    setMsgInsertSwitch: async () => ({ success: true })
  }
}

describe('MessageInsertSwitches 能力门禁', () => {
  it('没有授权时两个未开启的开关都不可操作，并给出激活引导', async () => {
    installApi(snapshotOf(false, { recall: false, exit: false }))
    render(<MessageInsertSwitches />)

    await waitFor(() => expect(screen.getAllByRole('switch').length).toBe(2))
    const switches = screen.getAllByRole('switch')
    expect(switches[0]).toBeDisabled()
    expect(switches[1]).toBeDisabled()
    expect(screen.getByText(/需要有效授权才能开启/)).toBeTruthy()
  })

  it('已开启的开关在授权失效时仍可点击关闭（不能被锁死）', async () => {
    installApi(snapshotOf(false, { recall: true, exit: true }))
    render(<MessageInsertSwitches />)

    await waitFor(() => expect(screen.getAllByRole('switch').length).toBe(2))
    const switches = screen.getAllByRole('switch')
    expect(switches[0]).not.toBeDisabled()
    expect(switches[1]).not.toBeDisabled()
  })

  it('授权有效时允许开启', async () => {
    installApi(snapshotOf(true, { recall: false, exit: false }))
    render(<MessageInsertSwitches />)

    await waitFor(() => expect(screen.getAllByRole('switch').length).toBe(2))
    const switches = screen.getAllByRole('switch')
    expect(switches[0]).not.toBeDisabled()
    expect(switches[1]).not.toBeDisabled()
  })

  it('缺组件时提示组件缺失，而不是「没授权」', async () => {
    const snapshot = snapshotOf(
      false,
      { recall: false, exit: false },
      'COMPONENT_MISSING',
      '未安装发送能力组件'
    )
    installApi(snapshot)
    render(<MessageInsertSwitches />)

    await waitFor(() => expect(screen.getByText(/发送能力组件/)).toBeTruthy())
  })
})
