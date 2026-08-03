import { describe, expect, it } from 'vitest'
import { renderExportPage } from '../../src/main/export-html-template'
import { getImageExportAttempts } from '../../src/shared/export-media'
import type { Message } from '../../src/shared/types'

const baseMessage = (overrides: Partial<Message>): Message => ({
  id: 'fixture-message',
  from: 'fixture',
  type: '文本',
  datetime: '2026-08-01 10:00:00',
  content: '',
  isSender: false,
  ...overrides
})

describe('export media', () => {
  it('always attempts the original before an explicitly enabled thumbnail fallback', () => {
    const first = getImageExportAttempts({ preferOriginal: true, fallbackThumbnail: true })
    const repeated = getImageExportAttempts({ preferOriginal: true, fallbackThumbnail: true })

    expect(first).toEqual([
      { allowThumbnail: false, preferThumbnail: false, fallback: false },
      { allowThumbnail: true, preferThumbnail: true, fallback: true }
    ])
    expect(repeated).toEqual(first)
  })

  it('renders movable relative audio and video assets plus accurate missing-media details', () => {
    const html = renderExportPage('脱敏导出', [
      baseMessage({ id: 'voice', type: '语音', voiceDataUrl: 'voices/voice_1.wav' }),
      baseMessage({
        id: 'video',
        type: '视频',
        exportMediaType: 'video',
        exportMediaUrl: 'media/video_2.mp4'
      }),
      baseMessage({
        id: 'missing',
        type: '语音',
        exportMediaError: '语音文件缺失：本地未找到语音数据'
      })
    ])

    expect(html).toContain(
      'audio class="audio" controls preload="metadata" src="voices/voice_1.wav"'
    )
    expect(html).toContain('video class="media-image" controls src="media/video_2.mp4"')
    expect(html).toContain('语音文件缺失：本地未找到语音数据')
    expect(html).not.toMatch(/(?:src|href)="[A-Za-z]:\\/)
  })

  it('renders explicit and keyboard-accessible lightbox closing controls', () => {
    const html = renderExportPage('图片预览', [
      baseMessage({ id: 'image', type: '图片', exportMediaUrl: 'media/image.jpg' })
    ])

    expect(html).toContain('aria-label="关闭图片预览"')
    expect(html).toContain("closeButton.addEventListener('click',closeLightbox)")
    expect(html).toContain('if(event.target===box)closeLightbox()')
    expect(html).toContain("if(event.key==='Escape')closeLightbox()")
  })
})
