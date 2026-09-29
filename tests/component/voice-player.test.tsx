import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { VoicePlayer } from '../../src/renderer/src/components/VoicePlayer'

const play = vi.fn(() => Promise.resolve())
const pause = vi.fn()

let lastAudio: FakeAudio | null = null

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

  constructor() {
    lastAudio = this
  }
}

const renderPlayer = (duration?: number) =>
  render(
    <VoicePlayer
      sessionId="filehelper"
      localId={11}
      createTime={1785553200}
      duration={duration}
    />
  )

describe('VoicePlayer', () => {
  beforeEach(() => {
    play.mockClear()
    pause.mockClear()
    lastAudio = null
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

    // 用户主动触发必须带 force：否则会被身份级缓存（不含 audio_hash）短路。
    await waitFor(() =>
      expect(window.api.recognizeVoice).toHaveBeenCalledWith(
        {
          sessionId: 'filehelper',
          localId: 11,
          createTime: 1785553200,
          svrId: undefined
        },
        { force: true }
      )
    )
    expect(await screen.findByText('这是固定的测试转写')).toBeInTheDocument()
  })

  it('rounds the shown duration the way WeChat does', () => {
    // 微信 4211ms 显示 4"，所以口径是 round 不是 floor；进位要传给分钟位。
    const cases: Array<[number | undefined, string]> = [
      [1.7, '0:02'],
      [4.211, '0:04'],
      [7.505, '0:08'],
      [59.6, '1:00'],
      [119.6, '2:00'],
      [3, '0:03'],
      [7, '0:07'],
      [15, '0:15'],
      [0, '0:00'],
      [undefined, '0:00'],
      [NaN, '0:00']
    ]
    for (const [duration, expected] of cases) {
      const { container, unmount } = renderPlayer(duration)
      expect(container.querySelector('.voice-duration')?.textContent).toBe(expected)
      unmount()
    }
  })

  it('keeps the WeChat duration instead of the systematically short decoded one', async () => {
    const { container } = renderPlayer(1.979)
    expect(container.querySelector('.voice-duration')?.textContent).toBe('0:02')

    await userEvent.click(container.querySelector('.voice-message') as HTMLElement)
    await waitFor(() => expect(lastAudio).not.toBeNull())
    // Silk 解码时长比微信 length 系统性偏短（实测少 20–279ms），用它覆盖会把精度弄丢。
    lastAudio!.duration = 1
    await act(async () => {
      lastAudio!.onloadedmetadata?.()
      lastAudio!.ontimeupdate?.()
    })

    expect(container.querySelector('.voice-duration')?.textContent).toBe('0:02')
  })

  it('falls back to the decoded duration when WeChat did not provide one', async () => {
    const { container } = renderPlayer()
    expect(container.querySelector('.voice-duration')?.textContent).toBe('0:00')

    await userEvent.click(container.querySelector('.voice-message') as HTMLElement)
    await waitFor(() => expect(lastAudio).not.toBeNull())
    lastAudio!.duration = 59.6
    lastAudio!.onloadedmetadata?.()

    await waitFor(() =>
      expect(container.querySelector('.voice-duration')?.textContent).toBe('1:00')
    )
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
