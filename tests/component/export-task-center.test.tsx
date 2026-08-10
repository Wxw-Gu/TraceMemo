import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ExportTaskCenter } from '../../src/renderer/src/components/export/ExportTaskCenter'

describe('export task center', () => {
  const writeText = vi.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    writeText.mockClear()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    })
  })

  it('shows the failure reason and copies a diagnostic log', async () => {
    render(
      <ExportTaskCenter
        open
        taskCount={0}
        tasks={[
          {
            jobId: 'failed-export',
            targetIds: ['fixture'],
            targetNames: ['脱敏会话'],
            targetLabel: '脱敏会话',
            format: 'html',
            status: 'failed',
            progress: {
              jobId: 'failed-export',
              phase: 'failed',
              processed: 0,
              percent: 15,
              error: 'EPERM: operation not permitted, copyfile'
            },
            createdAt: new Date('2026-08-04T15:00:00.000Z').getTime()
          }
        ]}
        onToggle={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    expect(
      screen.getByText('失败原因：EPERM: operation not permitted, copyfile')
    ).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '复制日志' }))

    expect(writeText).toHaveBeenCalledOnce()
    expect(writeText.mock.calls[0][0]).toContain('会话：脱敏会话')
    expect(writeText.mock.calls[0][0]).toContain('EPERM: operation not permitted, copyfile')
    expect(screen.getByRole('button', { name: '已复制' })).toBeInTheDocument()
  })

  it('shows the current conversation for a background all-export task', () => {
    render(
      <ExportTaskCenter
        open
        taskCount={1}
        tasks={[
          {
            jobId: 'all-export',
            scope: 'all',
            allContactTypes: ['group', 'user'],
            targetIds: [],
            targetNames: [],
            targetLabel: '全部 20 个聊天',
            format: 'html',
            status: 'running',
            progress: {
              jobId: 'all-export',
              phase: 'media',
              processed: 3,
              total: 8,
              percent: 42,
              currentTargetIndex: 9,
              currentTargetCount: 20,
              currentTargetName: '项目群',
              currentTargetType: 'group'
            },
            createdAt: Date.now()
          }
        ]}
        onToggle={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    expect(screen.getByText('第 9/20 个：项目群')).toBeVisible()
    expect(screen.getByText('42%')).toBeVisible()
  })
})
