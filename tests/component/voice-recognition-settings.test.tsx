import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { VoiceRecognitionPage } from '../../src/renderer/src/features/settings/pages/VoiceRecognitionPage'
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

describe('voice recognition settings', () => {
  beforeEach(() => {
    window.api = {
      getVoiceModelStatus: vi.fn().mockResolvedValue(readyStatus),
      downloadVoiceModel: vi.fn(),
      cancelVoiceModelDownload: vi.fn(),
      removeVoiceModel: vi.fn().mockResolvedValue({ ...readyStatus, state: 'missing' }),
      openVoiceModelDirectory: vi.fn().mockResolvedValue({ success: true }),
      onVoiceModelProgress: vi.fn(() => vi.fn())
    } as typeof window.api
  })

  it('shows Windows runtime and installed model actions', async () => {
    render(<VoiceRecognitionPage onNotice={vi.fn()} />)
    expect(await screen.findByText('Windows 64 位')).toBeInTheDocument()
    expect(screen.queryByText('额外环境')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'SenseVoice（MIT）' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'sherpa-onnx（Apache-2.0）' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '打开模型目录' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '删除模型' })).toBeInTheDocument()
  })

  it('downloads the model from the centralized settings page', async () => {
    const missing = { ...readyStatus, state: 'missing' as const, progress: 0, downloadedBytes: 0 }
    vi.mocked(window.api.getVoiceModelStatus).mockResolvedValue(missing)
    vi.mocked(window.api.downloadVoiceModel).mockResolvedValue({
      success: true,
      status: readyStatus
    })
    const notice = vi.fn()
    render(<VoiceRecognitionPage onNotice={notice} />)
    await userEvent.click(await screen.findByRole('button', { name: '下载模型' }))

    await waitFor(() => expect(window.api.downloadVoiceModel).toHaveBeenCalledOnce())
    expect(notice).toHaveBeenCalledWith('离线语音模型已准备好')
  })

  it('shows download percentage in the header and model card', async () => {
    const missing = {
      ...readyStatus,
      state: 'missing' as const,
      progress: 0,
      downloadedBytes: 0
    }
    let progressListener: ((status: VoiceModelStatus) => void) | undefined
    let finishDownload:
      | ((value: { success: boolean; status: VoiceModelStatus }) => void)
      | undefined
    vi.mocked(window.api.getVoiceModelStatus).mockResolvedValue(missing)
    vi.mocked(window.api.onVoiceModelProgress).mockImplementation((listener) => {
      progressListener = listener
      return vi.fn()
    })
    vi.mocked(window.api.downloadVoiceModel).mockReturnValue(
      new Promise((resolve) => {
        finishDownload = resolve
      })
    )
    render(<VoiceRecognitionPage onNotice={vi.fn()} />)
    await userEvent.click(await screen.findByRole('button', { name: '下载模型' }))
    progressListener?.({
      ...missing,
      state: 'downloading',
      downloadedBytes: Math.round(missing.totalBytes * 0.42),
      progress: 0.42
    })

    expect(await screen.findByText('下载中 42%')).toBeInTheDocument()
    expect(screen.getByText('正在下载 42%')).toBeInTheDocument()
    finishDownload?.({ success: true, status: readyStatus })
  })
})
