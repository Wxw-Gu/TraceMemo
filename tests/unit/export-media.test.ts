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
      { allowThumbnail: false, preferThumbnail: false },
      { allowThumbnail: true, preferThumbnail: true }
    ])
    expect(repeated).toEqual(first)
  })

  it('loads archive data and provides timeline, filters, search, and bounded lazy rendering', () => {
    const html = renderExportPage('脱敏导出')

    expect(EXPORT_PAGE_SIZE).toBe(240)
    expect(html).toContain("dataScript.src = 'data/messages.js'")
    expect(html).toContain('id="archive-loading"')
    expect(html).toContain('正在加载聊天档案')
    expect(html).toContain('requestAnimationFrame(() => window.setTimeout(loadArchiveData, 0))')
    expect(html).toContain('aria-label="聊天时间轴"')
    expect(html).toContain('aria-expanded="')
    expect(html).toContain('setExpandedTimelineYear')
    expect(html).toContain('data-kind="media"')
    expect(html).toContain('placeholder="搜索发送者、消息内容或媒体文件名（不含后缀）…"')
    expect(html).toContain('font-size: 16px;')
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
    expect(dom.window.document.querySelector('#count')?.textContent).toBe('筛选 500 / 全部 500')
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
    expect(dom.window.document.querySelector('#count')?.textContent).toContain('筛选 5')
    expect(dom.window.document.querySelectorAll('.search-highlight')).toHaveLength(5)
    expect(dom.window.document.querySelectorAll('.locate-all')).toHaveLength(5)
    expect(dom.window.document.querySelectorAll('.timeline-month').length).toBeGreaterThan(1)
    expect(
      dom.window.document.querySelectorAll('.timeline-year[aria-expanded="true"]')
    ).toHaveLength(1)
    expect(dom.window.document.querySelectorAll('.timeline-months:not([hidden])')).toHaveLength(1)
    dom.window.close()
  })

  it('does not match hidden sender ids when searching visible message text', () => {
    const html = renderExportPage('搜索测试')
    const dom = new JSDOM(html, { runScripts: 'outside-only' })
    const messages: Message[] = [
      {
        id: 'hidden-sender-id-match',
        from: 'user',
        type: '普通文本',
        datetime: '',
        content: '这条消息不应命中',
        name: 'Jamie',
        senderId: 'wxid_fixture_member',
        isSender: false,
        createTime: 1_767_225_600
      },
      {
        id: 'visible-content-match',
        from: 'user',
        type: '普通文本',
        datetime: '',
        content: 'https://example.com/xi',
        name: 'Cherry',
        senderId: 'wxid_fixture_self',
        isSender: true,
        createTime: 1_767_225_601
      }
    ]
    Object.assign(dom.window, {
      __WECHAT_EXPORT__: {
        version: 1,
        sourceId: 'fixture',
        name: '搜索测试',
        exportedAt: '2026-08-05T00:00:00.000Z',
        messages
      }
    })

    dom.window.eval(inlineScriptOf(html))
    const search = dom.window.document.querySelector('#query') as HTMLInputElement
    search.value = 'xi'
    search.dispatchEvent(new dom.window.Event('input'))

    expect(dom.window.document.querySelectorAll('.message')).toHaveLength(1)
    expect(dom.window.document.querySelector('.message')?.textContent).toContain(
      'https://example.com/xi'
    )
    expect(dom.window.document.querySelectorAll('.search-highlight')).toHaveLength(1)
    expect(dom.window.document.querySelector('#count')?.textContent).toBe('筛选 1 / 全部 2')
    dom.window.close()
  })

  it('matches exported image and video filenames exactly without their extension', () => {
    const html = renderExportPage('媒体文件名搜索')
    const dom = new JSDOM(html, { runScripts: 'outside-only' })
    const imageFileName = 'image_0123456789abcdef.jpg'
    const videoFileName = 'video_fedcba9876543210.mp4'
    const messages: Message[] = [
      {
        ...messageForArchive('image-name', 'fixture', '媒体文件名搜索', '', 1),
        type: '图片',
        exportMediaType: 'image',
        exportMediaUrl: `media/${imageFileName}`,
        contentData: { type: 'image' }
      },
      {
        ...messageForArchive('video-name', 'fixture', '媒体文件名搜索', '', 2),
        type: '视频',
        exportMediaType: 'video',
        exportMediaUrl: `media/${videoFileName}`,
        contentData: { type: 'video' }
      }
    ]
    Object.assign(dom.window, {
      __WECHAT_EXPORT__: {
        version: 1,
        sourceId: 'fixture',
        name: '媒体文件名搜索',
        messages
      }
    })

    dom.window.eval(inlineScriptOf(html))
    const search = dom.window.document.querySelector('#query') as HTMLInputElement

    search.value = 'IMAGE_0123456789ABCDEF'
    search.dispatchEvent(new dom.window.Event('input'))
    expect(dom.window.document.querySelectorAll('.message')).toHaveLength(1)
    expect(dom.window.document.querySelectorAll('img.media-image')).toHaveLength(1)
    expect(dom.window.document.querySelectorAll('video.media-image')).toHaveLength(0)

    search.value = '0123456789abcdef'
    search.dispatchEvent(new dom.window.Event('input'))
    expect(dom.window.document.querySelectorAll('.message')).toHaveLength(0)

    search.value = 'video_fedcba9876543210'
    search.dispatchEvent(new dom.window.Event('input'))
    expect(dom.window.document.querySelectorAll('.message')).toHaveLength(1)
    expect(dom.window.document.querySelectorAll('img.media-image')).toHaveLength(0)
    expect(dom.window.document.querySelectorAll('video.media-image')).toHaveLength(1)

    search.value = videoFileName
    search.dispatchEvent(new dom.window.Event('input'))
    expect(dom.window.document.querySelectorAll('.message')).toHaveLength(0)
    dom.window.close()
  })

  it('filters a v2 merged archive by conversation before search and month counts', () => {
    const html = renderExportPage('合并档案')
    const dom = new JSDOM(html, { runScripts: 'outside-only' })
    Object.assign(dom.window, {
      __WECHAT_EXPORT__: {
        version: 2,
        name: '合并档案',
        exportedAt: '2026-08-04T00:00:00.000Z',
        conversations: [
          { id: 'alpha', name: '聊天 A', type: 'user', messageCount: 2 },
          { id: 'beta', name: '聊天 B', type: 'group', messageCount: 1 }
        ],
        messages: [
          messageForArchive('alpha-1', 'alpha', '聊天 A', '共同关键词', 1_767_225_600),
          messageForArchive('beta-1', 'beta', '聊天 B', '共同关键词', 1_769_904_000),
          messageForArchive('alpha-2', 'alpha', '聊天 A', '仅 A 可见', 1_769_990_400)
        ]
      }
    })

    dom.window.eval(inlineScriptOf(html))

    const filter = dom.window.document.querySelector('#conversation-filter')!
    const trigger = dom.window.document.querySelector('#conversation-trigger') as HTMLButtonElement
    const menu = dom.window.document.querySelector('#conversation-menu') as HTMLElement
    expect(filter.hasAttribute('hidden')).toBe(false)
    expect(filter.parentElement?.classList.contains('archive-heading')).toBe(true)
    expect((dom.window.document.querySelector('#archive-title') as HTMLElement).hidden).toBe(true)
    expect(trigger.textContent).toContain('全部聊天')
    expect(menu.querySelectorAll('[data-conversation-id]')).toHaveLength(3)
    expect(dom.window.document.querySelectorAll('.conversation-source')).toHaveLength(3)
    expect(dom.window.document.querySelector('#count')?.textContent).toBe('筛选 3 / 全部 3')
    trigger.click()
    ;(menu.querySelector('[data-conversation-id="alpha"]') as HTMLButtonElement).click()
    expect(dom.window.document.querySelectorAll('.message')).toHaveLength(2)
    expect(dom.window.document.querySelectorAll('.conversation-source')).toHaveLength(0)
    expect(dom.window.document.querySelector('#count')?.textContent).toBe('筛选 2 / 全部 2')
    expect(dom.window.document.querySelectorAll('.timeline-month')).toHaveLength(2)

    const search = dom.window.document.querySelector('#query') as HTMLInputElement
    search.value = '共同关键词'
    search.dispatchEvent(new dom.window.Event('input'))
    expect(dom.window.document.querySelectorAll('.message')).toHaveLength(1)
    expect(dom.window.document.querySelector('#count')?.textContent).toBe('筛选 1 / 全部 2')
    dom.window.close()
  })

  it('locates every filtered message kind in all messages, including outside the latest window', () => {
    const html = renderExportPage('定位消息')
    const dom = new JSDOM(html, { runScripts: 'outside-only' })
    const categorized: Message[] = [
      {
        ...messageForArchive('target-text', 'fixture', '定位消息', '目标文字', 1),
        type: '普通文本'
      },
      {
        ...messageForArchive('target-media', 'fixture', '定位消息', '', 2),
        type: '图片',
        exportMediaType: 'image',
        exportMediaUrl: 'media/target.jpg'
      },
      {
        ...messageForArchive('target-voice', 'fixture', '定位消息', '', 3),
        type: '语音',
        voiceDataUrl: 'voices/target.wav'
      },
      {
        ...messageForArchive('target-file', 'fixture', '定位消息', '', 4),
        type: '文件',
        exportMediaType: 'file',
        exportMediaUrl: 'files/target.mp3',
        exportMediaName: 'target.mp3'
      },
      {
        ...messageForArchive('target-document', 'fixture', '定位消息', '', 4.5),
        type: '文件',
        exportMediaType: 'file',
        exportMediaUrl: 'files/target.pdf',
        exportMediaName: 'target.pdf'
      },
      {
        ...messageForArchive('target-share', 'fixture', '定位消息', '', 5),
        type: '分享',
        contentData: {
          type: 'share',
          typeVal: '5',
          title: '目标分享',
          url: 'https://example.com/shared'
        }
      },
      {
        ...messageForArchive('target-system', 'fixture', '定位消息', '目标系统消息', 6),
        from: 'system',
        type: '系统消息',
        contentData: { type: 'system', content: '目标系统消息' }
      }
    ]
    const laterMessages = Array.from({ length: EXPORT_PAGE_SIZE }, (_, index) => ({
      ...messageForArchive(
        `later-${index}`,
        'fixture',
        '定位消息',
        `稍后消息-${index}`,
        100 + index
      ),
      type: '普通文本'
    }))
    Object.assign(dom.window, {
      __WECHAT_EXPORT__: {
        version: 1,
        sourceId: 'fixture',
        name: '定位消息',
        messages: [...categorized, ...laterMessages]
      }
    })

    dom.window.eval(inlineScriptOf(html))

    expect(dom.window.document.querySelectorAll('.locate-all')).toHaveLength(0)
    for (const kind of ['media', 'voice', 'file', 'share', 'system']) {
      const filterButton = dom.window.document.querySelector(`[data-kind="${kind}"]`) as HTMLElement
      filterButton.click()
      if (kind === 'file' || kind === 'share') {
        const link = dom.window.document.querySelector(
          kind === 'file' ? '.file-attachment' : '.structured-link'
        )
        expect(link?.getAttribute('target')).toBe('_blank')
        expect(link?.getAttribute('rel')).toBe('noreferrer noopener')
        if (kind === 'file') {
          expect(link?.hasAttribute('download')).toBe(false)
          const audioPlayers = dom.window.document.querySelectorAll('.audio')
          expect(audioPlayers).toHaveLength(1)
          expect(audioPlayers[0].getAttribute('src')).toBe('files/target.mp3')
        }
      }
      const locateButton = dom.window.document.querySelector('.locate-all') as HTMLElement
      expect(locateButton?.getAttribute('aria-label')).toBe('定位到聊天位置')
      expect(locateButton?.querySelector('.locate-icon')?.textContent).toBe('⌖')
      expect(locateButton?.querySelector('.locate-label')?.textContent).toBe('定位到聊天位置')
      locateButton.click()
      expect(
        dom.window.document.querySelector('[data-kind="all"]')?.classList.contains('active')
      ).toBe(true)
      expect(
        dom.window.document.querySelector('.message.located')?.getAttribute('data-index')
      ).toBe(String(categorized.findIndex((message) => kindOfFixture(message) === kind)))
    }

    const textFilter = dom.window.document.querySelector('[data-kind="text"]') as HTMLElement
    textFilter.click()
    const search = dom.window.document.querySelector('#query') as HTMLInputElement
    search.value = '目标文字'
    search.dispatchEvent(new dom.window.Event('input'))
    expect(dom.window.document.querySelector('.search-highlight')?.textContent).toBe('目标文字')
    ;(dom.window.document.querySelector('.locate-all') as HTMLElement).click()
    expect(
      dom.window.document.querySelector('[data-kind="all"]')?.classList.contains('active')
    ).toBe(true)
    expect(dom.window.document.querySelector('.message.located')?.getAttribute('data-index')).toBe(
      '0'
    )
    expect(dom.window.document.querySelector('.message.located')?.textContent).toContain('目标文字')

    search.value = '稍后消息-137'
    search.dispatchEvent(new dom.window.Event('input'))
    expect(
      dom.window.document.querySelector('[data-kind="all"]')?.classList.contains('active')
    ).toBe(true)
    expect(dom.window.document.querySelectorAll('.message')).toHaveLength(1)
    expect(dom.window.document.querySelector('.search-highlight')?.textContent).toBe('稍后消息-137')
    ;(dom.window.document.querySelector('.locate-all') as HTMLElement).click()
    expect(search.value).toBe('')
    expect(dom.window.document.querySelectorAll('.search-highlight')).toHaveLength(0)
    expect(dom.window.document.querySelectorAll('.locate-all')).toHaveLength(0)
    expect(dom.window.document.querySelector('.message.located')?.textContent).toContain(
      '稍后消息-137'
    )
    dom.window.close()
  })

  it('keeps relative media, new-window file links, quote, and missing-media renderers', () => {
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
    expect(html).toContain("if (event.key === 'Escape')")
    expect(html).toContain('closeLightbox()')
  })
})

function messageForArchive(
  id: string,
  conversationId: string,
  conversationName: string,
  content: string,
  createTime: number
): Message {
  return {
    id,
    from: 'user',
    type: '普通文本',
    datetime: '',
    content,
    isSender: false,
    createTime,
    exportConversationId: conversationId,
    exportConversationName: conversationName
  }
}

function kindOfFixture(message: Message): string {
  if (message.exportMediaType === 'image') return 'media'
  if (message.voiceDataUrl) return 'voice'
  if (message.exportMediaType === 'file') return 'file'
  if (message.contentData?.type === 'share') return 'share'
  if (message.contentData?.type === 'system') return 'system'
  return 'text'
}
