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
        getVoiceModelStatus: vi.fn().mockRejectedValue(new Error('fixture model unavailable')),
        getGroupSnapshot: vi.fn(async () => ({ members: [] })),
        cancelExport: vi.fn(async () => ({ success: true })),
        revealExport: vi.fn(async () => ({ success: true }))
      }
    })
  })

  const renderWorkspace = (
    onStartExport = vi.fn(async () => ({ success: false })),
    exportTasks: ExportTaskRecord[] = []
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
        exportTasks={exportTasks}
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

  it('exports every chat into its own format folder without loading every preview', async () => {
    const onStartExport = vi.fn(async () => ({ success: false }))
    const { loadPreviewMessages } = renderWorkspace(onStartExport)
    await screen.findByText('聊天 A 的预览')

    await userEvent.click(screen.getByRole('button', { name: /全部导出/ }))

    expect(screen.getByText(/全部群聊 1 个和全部联系人 5 个/)).toBeVisible()
    expect(screen.getByRole('button', { name: 'CSV' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'CSV' })).toHaveClass('active')
    expect(screen.getByRole('button', { name: 'JSON' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Markdown' })).toBeEnabled()
    expect(loadPreviewMessages).toHaveBeenCalledTimes(1)

    await userEvent.click(screen.getByRole('button', { name: '开始导出' }))
    await waitFor(() => expect(onStartExport).toHaveBeenCalledOnce())
    expect(onStartExport.mock.calls[0][0]).toMatchObject({
      scope: 'all',
      allContactTypes: ['group', 'user'],
      format: 'csv',
      outputName: '全部聊天记录'
    })
    expect(onStartExport.mock.calls[0][0].targets).toHaveLength(contacts.length)
    expect(window.api.getGroupSnapshot).not.toHaveBeenCalled()
  })

  it('allows all export to include only groups and replaces the single-chat avatars', async () => {
    const onStartExport = vi.fn(async () => ({ success: false }))
    renderWorkspace(onStartExport)
    await userEvent.click(screen.getByRole('button', { name: /全部导出/ }))

    expect(document.querySelector('.export-all-chat-avatar.group')).toHaveTextContent('群')
    expect(document.querySelector('.export-all-chat-avatar.user')).toHaveTextContent('联')
    await userEvent.click(screen.getByRole('checkbox', { name: '导出全部联系人' }))
    expect(document.querySelector('.export-all-chat-avatar.user')).not.toBeInTheDocument()
    expect(screen.getAllByText(/全部群聊 1 个/)).toHaveLength(2)
    expect(screen.getByRole('button', { name: /聊天 A/ })).toHaveAttribute('aria-pressed', 'false')

    await userEvent.click(screen.getByRole('button', { name: '开始导出' }))
    await waitFor(() => expect(onStartExport).toHaveBeenCalledOnce())
    expect(onStartExport.mock.calls[0][0]).toMatchObject({
      scope: 'all',
      allContactTypes: ['group'],
      startTime: undefined,
      endTime: undefined
    })
    expect(onStartExport.mock.calls[0][0].targets).toEqual([
      expect.objectContaining({ userMd5: 'contact-3', type: 'group' })
    ])
  })

  it('restores a running all-export task after returning to the page', async () => {
    const runningTask: ExportTaskRecord = {
      jobId: 'background-all',
      scope: 'all',
      allContactTypes: ['group'],
      targetIds: [],
      targetNames: [],
      targetLabel: '全部 1 个聊天',
      format: 'html',
      status: 'running',
      progress: {
        jobId: 'background-all',
        phase: 'media',
        processed: 4,
        total: 10,
        percent: 48,
        currentTargetIndex: 1,
        currentTargetCount: 1,
        currentTargetName: '聊天 C',
        currentTargetType: 'group'
      },
      createdAt: Date.now()
    }
    const { loadPreviewMessages } = renderWorkspace(undefined, [runningTask])

    expect(await screen.findByText('第 1/1 个：聊天 C')).toBeVisible()
    expect(screen.getByRole('checkbox', { name: '导出全部群聊' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: '导出全部联系人' })).not.toBeChecked()
    expect(document.querySelector('.export-all-chat-avatar.group')).toHaveTextContent('群')
    expect(document.querySelector('.export-all-chat-avatar.user')).not.toBeInTheDocument()
    expect(loadPreviewMessages).not.toHaveBeenCalled()
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
