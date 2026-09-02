import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ExportWorkspace } from '../../src/renderer/src/components/export/ExportWorkspace'
import type { VoiceModelStatus } from '../../src/shared/voice-recognition'

const readyStatus: VoiceModelStatus = {
  modelId: 'sensevoice-small-int8',
  version: '2024-07-17',
  state: 'ready',
  downloadedBytes: 239_549_735,
  totalBytes: 239_549_735,
  progress: 1,
  platform: 'win32',
  architecture: 'x64',
  supported: true
}

describe('export voice transcripts', () => {
  beforeEach(() => {
    window.api = {
      getVoiceModelStatus: vi.fn().mockResolvedValue(readyStatus),
      onExportProgress: vi.fn(() => vi.fn())
    } as typeof window.api
  })

  it('enables voice transcription by default for a ready HTML voice export', async () => {
    const onStartExport = vi.fn().mockResolvedValue({
      success: true,
      messageCount: 1,
      outputPath: 'C:\\fixture\\index.html'
    })
    render(
      <ExportWorkspace
        contacts={[
          {
            m_nsUsrName: 'filehelper',
            m_nsNickName: '文件传输助手',
            md5: 'fixture-contact',
            type: 'user'
          }
        ]}
        initialContact={{
          m_nsUsrName: 'filehelper',
          m_nsNickName: '文件传输助手',
          md5: 'fixture-contact',
          type: 'user'
        }}
        selfInfo={null}
        dbReady
        loadPreviewMessages={vi.fn().mockResolvedValue([])}
        onOpenSettings={vi.fn()}
        exportTasks={[]}
        onStartExport={onStartExport}
        onCancelExport={vi.fn()}
      />
    )

    await userEvent.click(
      within(screen.getByRole('radiogroup', { name: '导出格式' })).getByRole('radio', {
        name: /HTML/
      })
    )
    await userEvent.click(screen.getByRole('checkbox', { name: '语音' }))

    const transcriptOption = await screen.findByRole('checkbox', {
      name: '语音转文字，显示在语音条下方'
    })
    expect(transcriptOption).toBeEnabled()
    expect(transcriptOption).toBeChecked()

    await userEvent.click(screen.getByRole('button', { name: '开始导出' }))
    await waitFor(() => expect(onStartExport).toHaveBeenCalledOnce())
    expect(onStartExport.mock.calls[0][0]).toMatchObject({
      format: 'html',
      includeVoiceTranscripts: true,
      kinds: expect.arrayContaining(['voice'])
    })
  })
})
