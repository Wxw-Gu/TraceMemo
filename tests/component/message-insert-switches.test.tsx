import { act, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ToastProvider } from '../../src/renderer/src/components/ui'
import { MessageInsertSwitches } from '../../src/renderer/src/features/automation/MessageInsertSwitches'
import type { MsgInsertSwitchesSnapshot } from '../../src/shared/msg-insert-switch'

/**
 * 自动化页右上角的两个开关 —— 只钉**运行期刷新时机**。
 *
 * 背景：微信运行期间会新建 `message_N.db`，目标会话集合随之变化，而规则补齐此前
 * 只在启动时跑过一次。渲染层如果只在挂载时拉一次，用户看到的就是"计数对不上、
 * 而且不会自己变好"。所以要在窗口重新聚焦时问一次（主进程侧再用分片指纹决定要不要补）。
 */
function makeSnapshot(ready: number, total: number): MsgInsertSwitchesSnapshot {
  return {
    success: true,
    helperAvailable: true,
    switches: {
      recall_notice: {
        name: 'recall_notice',
        mode: 'rules',
        desiredEnabled: true,
        effectiveEnabled: ready === total,
        readyInstallableRooms: ready,
        totalInstallableRooms: total,
        notReadyRooms: [],
        totalShards: 1,
        targetShards: 1
      },
      group_exit_notice: {
        name: 'group_exit_notice',
        mode: 'event',
        desiredEnabled: true,
        effectiveEnabled: true,
        readyInstallableRooms: 1,
        totalInstallableRooms: 1,
        notReadyRooms: [],
        totalShards: 0,
        targetShards: 0
      }
    }
  } as unknown as MsgInsertSwitchesSnapshot
}

function renderSwitches(): void {
  render(
    <ToastProvider>
      <MessageInsertSwitches />
    </ToastProvider>
  )
}

describe('微信消息插入开关 · 运行期刷新', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('挂载只用 GET，不额外触发刷新', async () => {
    const get = vi.fn().mockResolvedValue(makeSnapshot(1, 2))
    const refresh = vi.fn().mockResolvedValue(makeSnapshot(2, 2))
    window.api = {
      getMsgInsertSwitches: get,
      refreshMsgInsertSwitches: refresh
    } as unknown as typeof window.api

    renderSwitches()

    await waitFor(() => expect(get).toHaveBeenCalled())
    expect(refresh).not.toHaveBeenCalled()
  })

  it('窗口重新聚焦时刷新一次，并画出更新后的计数', async () => {
    const get = vi.fn().mockResolvedValue(makeSnapshot(1, 2))
    const refresh = vi.fn().mockResolvedValue(makeSnapshot(2, 2))
    window.api = {
      getMsgInsertSwitches: get,
      refreshMsgInsertSwitches: refresh
    } as unknown as typeof window.api

    renderSwitches()
    await waitFor(() => expect(document.body.textContent).toContain('1 / 2 已启用'))

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(document.body.textContent).toContain('2 / 2 已启用'))
  })

  it('刷新失败时保持已有状态，不打回禁用态', async () => {
    const get = vi.fn().mockResolvedValue(makeSnapshot(1, 2))
    const refresh = vi.fn().mockRejectedValue(new Error('boom'))
    window.api = {
      getMsgInsertSwitches: get,
      refreshMsgInsertSwitches: refresh
    } as unknown as typeof window.api

    renderSwitches()
    await waitFor(() => expect(document.body.textContent).toContain('1 / 2 已启用'))

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })

    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(document.body.textContent).toContain('1 / 2 已启用')
  })
})
