import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ExportPreviewPanel } from '../../src/renderer/src/components/export/ExportPreviewPanel'

const baseProps = {
  status: 'running' as const,
  previewItems: [],
  previewMediaCount: 0,
  previewBytes: 0,
  selfInfo: null,
  selectedCount: 1,
  allExport: false,
  jobId: 'fixture-job',
  onCancel: vi.fn(),
  onReveal: vi.fn()
}

describe('export progress panel', () => {
  it('shows an indeterminate bar while the first message scan is still at zero', () => {
    render(
      <ExportPreviewPanel
        {...baseProps}
        progress={{
          jobId: 'fixture-job',
          phase: 'reading',
          processed: 0,
          percent: 0
        }}
        includeVoiceTranscripts={false}
        zip={false}
      />
    )

    const progressbar = screen.getByRole('progressbar', { name: '导出进度' })
    expect(progressbar).toHaveClass('indeterminate')
    expect(progressbar).not.toHaveAttribute('aria-valuenow')
    expect(progressbar).toHaveAttribute('aria-valuetext', '正在读取消息')
  })

  it('adds voice transcription and ZIP stages only for an export that uses them', () => {
    render(
      <ExportPreviewPanel
        {...baseProps}
        progress={{
          jobId: 'fixture-job',
          phase: 'transcribing',
          processed: 3,
          total: 8,
          percent: 31
        }}
        includeVoiceTranscripts
        zip
      />
    )

    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      '准备导出',
      '分批读取聊天记录',
      '解析消息内容',
      '语音转文字',
      '处理媒体资源',
      '生成档案',
      '压缩 ZIP'
    ])
    expect(screen.getByText('语音转文字')).toHaveClass('current')
    expect(screen.getByText('解析消息内容')).toHaveClass('done')
    expect(screen.getByText('处理媒体资源')).not.toHaveClass('done', 'current')
    expect(screen.getByText('正在转写语音 3/8... 31%')).toBeVisible()

    const progressbar = screen.getByRole('progressbar', { name: '导出进度' })
    expect(progressbar).toHaveAttribute('aria-valuenow', '31')
    expect(progressbar.querySelector('span')).toHaveStyle({ width: '31%' })
  })

  it('shows the current conversation and overall position for all export', () => {
    render(
      <ExportPreviewPanel
        {...baseProps}
        allExport
        selectedCount={30}
        progress={{
          jobId: 'fixture-job',
          phase: 'media',
          processed: 5,
          total: 12,
          percent: 36,
          currentTargetIndex: 11,
          currentTargetCount: 30,
          currentTargetName: '项目讨论群',
          currentTargetType: 'group'
        }}
        includeVoiceTranscripts={false}
        zip={false}
      />
    )

    expect(screen.getByText('群聊')).toBeVisible()
    expect(screen.getByText('第 11/30 个：项目讨论群')).toBeVisible()
    expect(screen.getByRole('progressbar', { name: '导出进度' })).toHaveAttribute(
      'aria-valuenow',
      '36'
    )
  })
})
