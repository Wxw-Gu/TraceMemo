import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHubWorkspace } from '../../src/renderer/src/features/agent-hub/AgentHubWorkspace'
import type { AgentHubStatus } from '../../src/shared/agent-hub'

const onlineStatus: AgentHubStatus = {
  hub: 'online',
  connector: 'online',
  updatedAt: 1,
  dataApi: 'online',
  databaseReady: true,
  accountId: 'fixture-agent'
}

describe('Agent Hub controls', () => {
  beforeEach(() => {
    window.api = {
      getAgentHubStatus: vi.fn().mockResolvedValue(onlineStatus),
      getAgentHubLogs: vi.fn().mockResolvedValue([
        { id: 1, timestamp: 1, source: 'system', level: 'info', message: '系统就绪' },
        {
          id: 2,
          timestamp: 2,
          source: 'wechat-connector',
          level: 'warn',
          message: '等待连接'
        }
      ]),
      onAgentHubStatus: vi.fn(() => () => undefined),
      onAgentHubLog: vi.fn(() => () => undefined),
      copyText: vi.fn().mockResolvedValue(undefined),
      clearAgentHubLogs: vi.fn().mockResolvedValue({ success: true }),
      startAgentHubLogin: vi.fn().mockResolvedValue({ status: onlineStatus }),
      cancelAgentHubLogin: vi.fn().mockResolvedValue({ status: onlineStatus }),
      disconnectAgentHub: vi.fn().mockResolvedValue({
        status: { ...onlineStatus, connector: 'disconnected' }
      })
    } as typeof window.api
  })

  it('filters, copies, and clears logs through shared controls', async () => {
    const user = userEvent.setup()
    render(<AgentHubWorkspace />)
    await screen.findByText('系统就绪')

    await user.click(screen.getByRole('combobox', { name: '筛选日志来源' }))
    await user.click(screen.getByRole('option', { name: '系统', exact: true }))
    expect(screen.getByText('系统就绪')).toBeInTheDocument()
    expect(screen.queryByText('等待连接')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '复制日志' }))
    expect(window.api.copyText).toHaveBeenCalledWith(expect.stringContaining('系统就绪'))
    expect(window.api.copyText).toHaveBeenCalledWith(expect.not.stringContaining('等待连接'))

    await user.click(screen.getByRole('button', { name: '清空' }))
    expect(window.api.clearAgentHubLogs).toHaveBeenCalledOnce()
    expect(screen.getByText(/暂无运行日志/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '复制日志' })).toBeDisabled()
  })

  it('keeps reconnect and destructive disconnect actions separate', async () => {
    const user = userEvent.setup()
    render(<AgentHubWorkspace />)
    await screen.findByText('微信机器人已连接')

    await user.click(screen.getByRole('button', { name: '重新扫码登录' }))
    expect(window.api.startAgentHubLogin).toHaveBeenCalledOnce()

    const disconnect = screen.getByRole('button', { name: '断开连接' })
    expect(disconnect).toHaveClass('bg-destructive')
    await user.click(disconnect)
    await act(async () => {
      await Promise.resolve()
    })
    expect(window.api.disconnectAgentHub).toHaveBeenCalledOnce()
  })
})
