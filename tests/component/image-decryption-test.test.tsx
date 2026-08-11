import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImageTestSection } from '../../src/renderer/src/features/settings/image-decryption/ImageTestSection'
import { initialImageDecryptionState } from '../../src/renderer/src/features/settings/image-decryption/imageDecryptionReducer'
import type { ImageBatchTestState } from '../../src/renderer/src/features/settings/image-decryption/types'

const emptyBatchTest: ImageBatchTestState = {
  running: false,
  stopRequested: false,
  elapsedMs: 0,
  items: []
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ImageTestSection', () => {
  it('keeps the file step successful when decryption fails and copies diagnostics', async () => {
    const onCopyLog = vi.fn()
    render(
      <ImageTestSection
        state={{
          ...initialImageDecryptionState,
          phase: 'test-failed',
          selectedUserMd5: 'conversation-md5',
          contacts: [
            {
              md5: 'conversation-md5',
              m_nsUsrName: 'fixture-user',
              m_nsNickName: '测试会话',
              type: 'user'
            }
          ],
          testResult: {
            success: false,
            code: 'DECRYPT_FAILED',
            error: '图片密钥与当前账号不匹配',
            fileFound: true,
            decrypted: false,
            readable: false,
            diagnosticLog: 'TraceMemo 图片解析测试日志（已脱敏）'
          }
        }}
        batchTest={emptyBatchTest}
        disabled={false}
        canSave={false}
        onSelect={vi.fn()}
        onTest={vi.fn()}
        onBatchTest={vi.fn()}
        onStopBatchTest={vi.fn()}
        onCopyLog={onCopyLog}
        onSave={vi.fn()}
      />
    )

    expect(screen.getByText('找到图片文件').closest('li')).toHaveClass('image-step-ok')
    expect(screen.getByText('解密成功').closest('li')).toHaveClass('image-step-fail')
    expect(screen.getByText('图片可以读取').closest('li')).toHaveClass('image-step-skipped')
    expect(screen.getByText('仅当前会话的单次测试日志')).toHaveAttribute(
      'title',
      expect.stringContaining('不包含批量测试结果')
    )

    await userEvent.click(screen.getByRole('button', { name: '复制日志' }))
    expect(onCopyLog).toHaveBeenCalledOnce()
  })

  it('disables log copying before a test result exists', () => {
    render(
      <ImageTestSection
        state={initialImageDecryptionState}
        batchTest={emptyBatchTest}
        disabled={false}
        canSave={false}
        onSelect={vi.fn()}
        onTest={vi.fn()}
        onBatchTest={vi.fn()}
        onStopBatchTest={vi.fn()}
        onCopyLog={vi.fn()}
        onSave={vi.fn()}
      />
    )

    expect(screen.getByRole('button', { name: '复制日志' })).toBeDisabled()
  })

  it('filters groups and contacts before starting a batch test', async () => {
    const onBatchTest = vi.fn()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(
      <ImageTestSection
        state={{
          ...initialImageDecryptionState,
          contacts: [
            {
              md5: 'group-md5',
              m_nsUsrName: 'group@chatroom',
              m_nsNickName: '测试群聊',
              type: 'group'
            },
            {
              md5: 'user-md5',
              m_nsUsrName: 'wxid_friend',
              m_nsNickName: '测试联系人',
              type: 'user'
            }
          ]
        }}
        batchTest={emptyBatchTest}
        disabled={false}
        canSave={false}
        onSelect={vi.fn()}
        onTest={vi.fn()}
        onBatchTest={onBatchTest}
        onStopBatchTest={vi.fn()}
        onCopyLog={vi.fn()}
        onSave={vi.fn()}
      />
    )

    await userEvent.click(screen.getByRole('button', { name: '群聊 1' }))
    expect(screen.getByRole('option', { name: '测试群聊' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: '测试联系人' })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '测试筛选结果（1）' }))
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('测试 1 个会话'))
    expect(onBatchTest).toHaveBeenCalledWith([
      expect.objectContaining({ md5: 'group-md5', type: 'group' })
    ])
  })

  it('shows per-conversation batch result and elapsed time', () => {
    render(
      <ImageTestSection
        state={initialImageDecryptionState}
        batchTest={{
          running: false,
          stopRequested: false,
          elapsedMs: 1320,
          items: [
            {
              contact: {
                md5: 'success-md5',
                m_nsUsrName: 'success@chatroom',
                m_nsNickName: '成功群聊',
                type: 'group'
              },
              status: 'success',
              elapsedMs: 120
            },
            {
              contact: {
                md5: 'no-image-md5',
                m_nsUsrName: 'wxid_no_image',
                m_nsNickName: '没有图片的联系人',
                type: 'user'
              },
              status: 'no-image',
              elapsedMs: 88,
              error: '最近 300 条消息中没有图片'
            }
          ]
        }}
        disabled={false}
        canSave={false}
        onSelect={vi.fn()}
        onTest={vi.fn()}
        onBatchTest={vi.fn()}
        onStopBatchTest={vi.fn()}
        onCopyLog={vi.fn()}
        onSave={vi.fn()}
      />
    )

    expect(screen.getByText('成功群聊')).toBeInTheDocument()
    expect(screen.getByText('没有图片的联系人')).toBeInTheDocument()
    expect(screen.getByText('成功 1')).toBeInTheDocument()
    expect(screen.getByText('无图片 1')).toBeInTheDocument()
    expect(screen.getByText(/2\/2 · 已耗时 1\.3 秒/)).toBeInTheDocument()
  })
})
