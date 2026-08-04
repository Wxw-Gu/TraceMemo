import { describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { EXPORT_PAGE_SIZE, renderExportPage } from '../../src/main/export-html-template'
import { getImageExportAttempts } from '../../src/shared/export-media'
import type { Message } from '../../src/shared/types'

const inlineScriptOf = (html: string): string =>
  Array.from(html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))
    .map((match) => match[1].trim())
    .find(Boolean) || ''

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

  it('loads archive data and provides timeline, filters, search, and bounded lazy rendering', () => {
    const html = renderExportPage('脱敏导出')

    expect(EXPORT_PAGE_SIZE).toBe(240)
    expect(html).toContain('<script src="data/messages.js"></script>')
    expect(html).toContain('aria-label="聊天时间轴"')
    expect(html).toContain('data-kind="media"')
    expect(html).toContain('placeholder="搜索发送者或消息内容…"')
    expect(html).toContain('filtered.slice(windowStart, windowEnd)')
    expect(html).toContain('windowStart = Math.max(0, windowEnd - PAGE_SIZE)')
    expect(html).toContain('scheduleWindowSlide')
    expect(html).toContain("list.addEventListener('wheel'")
    expect(html).toContain('date.getSeconds()')
    const inlineScript = inlineScriptOf(html)
    expect(inlineScript).toBeTruthy()
    expect(() => new Function(inlineScript)).not.toThrow()
  })

  it('keeps a bounded DOM while loading older and newer messages in both directions', async () => {
    const html = renderExportPage('大量消息')
    const dom = new JSDOM(html, { runScripts: 'outside-only' })
    const messages = Array.from(
      { length: 500 },
      (_, index): Message => ({
        id: `message-${index}`,
        from: 'user',
        type: '普通文本',
        datetime: '',
        content: index % 100 === 0 ? `needle-${index}` : `普通消息-${index}`,
        isSender: false,
        createTime: 1_767_225_600 + index * 86_400
      })
    )
    Object.assign(dom.window, {
      __WECHAT_EXPORT__: {
        version: 1,
        sourceId: 'fixture',
        name: '大量消息',
        exportedAt: '2026-08-04T00:00:00.000Z',
        messages
      }
    })

    dom.window.eval(inlineScriptOf(html))

    expect(dom.window.document.querySelectorAll('.message')).toHaveLength(EXPORT_PAGE_SIZE)
    expect(dom.window.document.querySelector('#count')?.textContent).toBe(
      '已显示 240 / 筛选 500 / 全部 500'
    )
    const list = dom.window.document.querySelector('#messages')!
    expect(list.querySelector('.message')?.getAttribute('data-index')).toBe('260')

    await new Promise((resolve) => dom.window.setTimeout(resolve, 10))
    list.dispatchEvent(new dom.window.WheelEvent('wheel', { deltaY: -100 }))
    await new Promise((resolve) => dom.window.setTimeout(resolve, 10))
    expect(list.querySelector('.message')?.getAttribute('data-index')).toBe('140')
    expect(dom.window.document.querySelectorAll('.message').length).toBe(EXPORT_PAGE_SIZE)

    await new Promise((resolve) => dom.window.setTimeout(resolve, 20))
    Object.defineProperty(list, 'scrollTop', { configurable: true, writable: true, value: 1_000 })
    list.dispatchEvent(new dom.window.Event('scroll'))
    await new Promise((resolve) => dom.window.setTimeout(resolve, 10))
    expect(list.querySelector('.message')?.getAttribute('data-index')).toBe('260')
    expect(dom.window.document.querySelectorAll('.message').length).toBe(EXPORT_PAGE_SIZE)

    const search = dom.window.document.querySelector('#query') as HTMLInputElement
    search.value = 'needle'
    search.dispatchEvent(new dom.window.Event('input'))
    expect(dom.window.document.querySelectorAll('.message')).toHaveLength(5)
    expect(dom.window.document.querySelectorAll('.timeline-month').length).toBeGreaterThan(1)
    dom.window.close()
  })

  it('keeps relative media, file download, quote, and missing-media renderers', () => {
    const html = renderExportPage('媒体档案')

    expect(html).toContain('audio class="audio" controls preload="metadata"')
    expect(html).toContain('video class="media-image" controls preload="metadata"')
    expect(html).toContain('class="file-attachment" href="')
    expect(html).toContain('class="quote-reference"')
    expect(html).toContain('message.exportMediaError')
    expect(html).toContain('.audio-wrap { width: 380px; max-width: 100%; min-width: 0; }')
    expect(html).toContain('.audio { display: block; width: 100%; max-width: 100%; height: 38px; }')
    expect(html).toContain('class="voice-transcript"')
    expect(html).toContain('message.voiceTranscript')
    expect(html).toContain('class="message-stack"')
    expect(html).not.toMatch(/(?:src|href)="[A-Za-z]:\\/)
  })

  it('renders a voice transcript below audio inside the same exported bubble', () => {
    const html = renderExportPage('语音转写档案')
    const dom = new JSDOM(html, { runScripts: 'outside-only' })
    Object.assign(dom.window, {
      __WECHAT_EXPORT__: {
        version: 1,
        sourceId: 'fixture',
        name: '语音转写档案',
        exportedAt: '2026-08-04T00:00:00.000Z',
        messages: [
          {
            id: 'voice-transcript',
            from: 'user',
            type: '语音',
            datetime: '2026-08-04 14:26',
            content: '[语音消息]',
            isSender: true,
            voiceDataUrl: 'voices/fixture.wav',
            voiceTranscript: '试一下',
            createTime: 1_785_549_600
          }
        ]
      }
    })
    dom.window.eval(inlineScriptOf(html))

    const stack = dom.window.document.querySelector('.message-stack')!
    const bubble = stack.querySelector('.bubble')!
    const transcript = stack.querySelector('.voice-transcript')!
    expect(bubble.querySelector('audio')?.getAttribute('src')).toBe('voices/fixture.wav')
    expect(transcript.textContent).toBe('试一下')
    expect(bubble.contains(transcript)).toBe(true)
    expect(stack.children).toHaveLength(1)
    expect(
      bubble.querySelector('audio')!.compareDocumentPosition(transcript) &
        dom.window.Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(bubble.textContent).not.toContain('[语音消息]')
    dom.window.close()
  })

  it('renders explicit and keyboard-accessible lightbox closing controls', () => {
    const html = renderExportPage('图片预览')

    expect(html).toContain('aria-label="关闭图片预览"')
    expect(html).toContain("closeButton.addEventListener('click', closeLightbox)")
    expect(html).toContain('if (event.target === box) closeLightbox()')
    expect(html).toContain("if (event.key === 'Escape') closeLightbox()")
  })
})
