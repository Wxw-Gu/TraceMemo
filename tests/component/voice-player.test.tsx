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
      })
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
})
