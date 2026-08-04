import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ExportWorkspace } from '../../src/renderer/src/components/export/ExportWorkspace'
import { ExportTaskCenter } from '../../src/renderer/src/components/export/ExportTaskCenter'
import type { ExportTaskRecord } from '../../src/shared/export'
import type { Contact, Message } from '../../src/shared/types'

const contacts: Contact[] = Array.from({ length: 6 }, (_, index) => ({
  md5: `contact-${index + 1}`,
  m_nsUsrName: `wxid_contact_${index + 1}`,
  m_nsNickName: `聊天 ${String.fromCharCode(65 + index)}`,
  type: index === 2 ? 'group' : 'user'
}))

const previewMessage = (contact: Contact): Message => ({
  id: `preview-${contact.md5}`,
  from: 'user',
  type: '普通文本',
  datetime: '',
  content: `${contact.m_nsNickName} 的预览`,
  isSender: false,
  createTime: contacts.indexOf(contact) + 1
})

describe('ExportWorkspace multi-chat selection', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        onExportProgress: vi.fn(() => vi.fn()),
        getGroupSnapshot: vi.fn(async () => ({ members: [] })),
        cancelExport: vi.fn(async () => ({ success: true })),
        revealExport: vi.fn(async () => ({ success: true }))
      }
    })
  })

  const renderWorkspace = (
    onStartExport = vi.fn(async () => ({ success: false }))
  ): { loadPreviewMessages: ReturnType<typeof vi.fn> } => {
    const loadPreviewMessages = vi.fn(async (contact: Contact) => [previewMessage(contact)])
    render(
      <ExportWorkspace
        contacts={contacts}
        initialContact={contacts[0]}
        selfInfo={{ wxid: 'self', nickname: '本人', accountRoot: '/fixture' }}
        dbReady
        loadPreviewMessages={loadPreviewMessages}
        onOpenSettings={vi.fn()}
        exportTasks={[]}
        onStartExport={onStartExport}
        onCancelExport={vi.fn(async () => undefined)}
      />
    )
    return { loadPreviewMessages }
  }

  it('defaults to one chat, forces HTML after adding another, merges the preview, and resets locally', async () => {
    const onStartExport = vi.fn(async () => ({ success: false }))
    const { loadPreviewMessages } = renderWorkspace(onStartExport)

    expect(screen.getAllByText('聊天 A')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'CSV' })).toBeEnabled()
    expect(await screen.findByText('聊天 A 的预览')).toBeVisible()

    await userEvent.click(screen.getByRole('button', { name: '+ 添加聊天' }))
    await userEvent.click(screen.getByRole('button', { name: /聊天 B/ }))

    expect(screen.getByText('已选 2 / 5 个')).toBeVisible()
    expect(screen.getByRole('button', { name: 'CSV' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'JSON' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Markdown' })).toBeDisabled()
    expect(screen.getByRole('button', { name: /HTML/ })).toHaveClass('active')
    expect(await screen.findByText('聊天 B 的预览')).toBeVisible()
    expect(screen.getByText('2 个聊天 · 合并预览')).toBeVisible()

    await userEvent.click(screen.getByRole('button', { name: '开始导出' }))
    await waitFor(() => expect(onStartExport).toHaveBeenCalledOnce())
    expect(onStartExport.mock.calls[0][0]).toMatchObject({
      format: 'html',
      outputName: '聊天 A等2个聊天_合并档案',
      targets: [
        { userMd5: 'contact-1', name: '聊天 A' },
        { userMd5: 'contact-2', name: '聊天 B' }
      ]
    })

    await userEvent.click(screen.getByRole('button', { name: '恢复默认' }))
    expect(screen.queryByText('已选 2 / 5 个')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'CSV' })).toBeEnabled()
    expect(screen.getAllByText('聊天 A').length).toBeGreaterThanOrEqual(2)
    expect(loadPreviewMessages).toHaveBeenCalledWith(contacts[0])
    expect(contacts[0].md5).toBe('contact-1')
  })

  it('does not allow removing the last chat and disables unselected chats at five', async () => {
    renderWorkspace()
    await userEvent.click(screen.getByRole('button', { name: '+ 添加聊天' }))

    await userEvent.click(screen.getByRole('button', { name: /聊天 A/ }))
    expect(screen.getByText('已选 1 / 5 个')).toBeVisible()

    for (const name of ['聊天 B', '聊天 C', '聊天 D', '聊天 E']) {
      await userEvent.click(screen.getByRole('button', { name: new RegExp(name) }))
    }
    expect(screen.getByText('已选 5 / 5 个')).toBeVisible()
    expect(screen.getByRole('button', { name: /聊天 F/ })).toBeDisabled()

    await userEvent.click(screen.getByRole('button', { name: /聊天 B/ }))
    expect(screen.getByText('已选 4 / 5 个')).toBeVisible()
    expect(screen.getByRole('button', { name: /聊天 F/ })).toBeEnabled()
  })
})

describe('ExportTaskCenter details', () => {
  it('shows the exported message count for success and the reason for failure', () => {
    const tasks: ExportTaskRecord[] = [
      {
        jobId: 'success',
        targetIds: ['contact-1'],
        targetNames: ['聊天 A'],
        targetLabel: '聊天 A',
        format: 'html',
        status: 'completed',
        progress: {
          jobId: 'success',
          phase: 'completed',
          processed: 125,
          total: 125,
          percent: 100
        },
        createdAt: 1
      },
      {
        jobId: 'failure',
        targetIds: ['contact-1', 'contact-2'],
        targetNames: ['聊天 A', '聊天 B'],
        targetLabel: '聊天 A 等 2 个聊天',
        format: 'html',
        status: 'failed',
        progress: {
          jobId: 'failure',
          phase: 'failed',
          processed: 0,
          percent: 0,
          error: '视频文件没有写入权限'
        },
        createdAt: 2
      }
    ]

    render(
      <ExportTaskCenter open taskCount={0} tasks={tasks} onToggle={vi.fn()} onCancel={vi.fn()} />
    )

    expect(screen.getByText('HTML · 已完成')).toBeVisible()
    expect(screen.getByText('成功导出 125 条消息')).toBeVisible()
    expect(screen.getByText('HTML · 导出失败')).toBeVisible()
    expect(screen.getByText('失败原因：视频文件没有写入权限')).toBeVisible()
  })
})
