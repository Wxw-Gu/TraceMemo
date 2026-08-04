import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { VoicePlayer } from '../../src/renderer/src/components/VoicePlayer'

const play = vi.fn(() => Promise.resolve())
const pause = vi.fn()

class FakeAudio {
  preload = ''
  src = ''
  duration = 1
  currentTime = 0
  onloadedmetadata: (() => void) | null = null
  ontimeupdate: (() => void) | null = null
  onended: (() => void) | null = null
  play = play
  pause = pause
  load = vi.fn()
  removeAttribute = vi.fn()
}

describe('VoicePlayer', () => {
  beforeEach(() => {
    play.mockClear()
    pause.mockClear()
    vi.stubGlobal('Audio', FakeAudio)
    window.api = {
      getVoiceData: vi.fn().mockResolvedValue({
        success: true,
        data: 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA='
      }),
      getVoiceModelStatus: vi.fn().mockResolvedValue({
        modelId: 'sensevoice-small-int8',
        version: 'fixture',
        state: 'ready',
        downloadedBytes: 10,
        totalBytes: 10,
        progress: 1,
        platform: 'win32',
        architecture: 'x64',
        supported: true
      }),
      recognizeVoice: vi.fn().mockResolvedValue({
        success: true,
        transcript: '这是固定的测试转写',
        language: 'zh',
        cached: false
      }),
      downloadVoiceModel: vi.fn(),
      cancelVoiceModelDownload: vi.fn(),
      cancelVoiceRecognition: vi.fn(),
      onVoiceModelProgress: vi.fn(() => vi.fn())
    } as typeof window.api
  })

  it('waits for decrypted bytes and calls play on the first click', async () => {
    const { container } = render(
      <VoicePlayer sessionId="filehelper" localId={11} createTime={1785553200} duration={1} />
    )
    await userEvent.click(container.querySelector('.voice-message') as HTMLElement)

    await waitFor(() => expect(window.api.getVoiceData).toHaveBeenCalledOnce())
    await waitFor(() => expect(play).toHaveBeenCalledOnce())
    expect(container.querySelector('.voice-icon')).toHaveClass('playing')
    expect(screen.queryByText('当前版本暂不支持播放')).not.toBeInTheDocument()
  })

  it('recognizes one voice message and renders the transcript', async () => {
    render(<VoicePlayer sessionId="filehelper" localId={11} createTime={1785553200} duration={1} />)
    await userEvent.click(screen.getByRole('button', { name: '转文字' }))

    await waitFor(() =>
      expect(window.api.recognizeVoice).toHaveBeenCalledWith({
        sessionId: 'filehelper',
        localId: 11,
        createTime: 1785553200,
        svrId: undefined
      })
    )
    expect(await screen.findByText('这是固定的测试转写')).toBeInTheDocument()
  })

  it('opens centralized settings when recognition assets are missing', async () => {
    vi.mocked(window.api.getVoiceModelStatus).mockResolvedValue({
      modelId: 'sensevoice-small-int8',
      version: 'fixture',
      state: 'missing',
      downloadedBytes: 0,
      totalBytes: 239_549_735,
      progress: 0,
      platform: 'win32',
      architecture: 'x64',
      supported: true
    })
    render(<VoicePlayer sessionId="filehelper" localId={12} createTime={1785553300} duration={2} />)
    const openSettings = vi.fn()
    window.addEventListener('wxe:open-voice-recognition-settings', openSettings, { once: true })
    await userEvent.click(screen.getByRole('button', { name: '转文字' }))

    expect(await screen.findByText(/请先在设置中准备离线语音模型/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '前往设置' }))
    expect(openSettings).toHaveBeenCalledOnce()
    expect(window.api.recognizeVoice).not.toHaveBeenCalled()
  })
})
