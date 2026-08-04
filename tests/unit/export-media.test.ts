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
    const select = dom.window.document.querySelector('#conversation-select') as HTMLSelectElement
    expect(filter.hasAttribute('hidden')).toBe(false)
    expect(filter.parentElement?.classList.contains('archive-heading')).toBe(true)
    expect((dom.window.document.querySelector('#archive-title') as HTMLElement).hidden).toBe(true)
    expect(dom.window.document.querySelector('#archive-meta')?.textContent).toMatch(/^更新于 /)
    expect(select.options).toHaveLength(3)
    expect(select.value).toBe('all')
    expect(select.options[0].textContent).toBe('全部聊天（3）')
    expect(dom.window.document.querySelectorAll('.conversation-source')).toHaveLength(3)
    expect(dom.window.document.querySelector('#count')?.textContent).toBe(
      '已显示 3 / 筛选 3 / 全部 3'
    )
    select.value = 'alpha'
    select.dispatchEvent(new dom.window.Event('change'))
    expect(dom.window.document.querySelectorAll('.message')).toHaveLength(2)
    expect(dom.window.document.querySelectorAll('.conversation-source')).toHaveLength(0)
    expect(dom.window.document.querySelector('#count')?.textContent).toBe(
      '已显示 2 / 筛选 2 / 当前聊天 2'
    )
    expect(dom.window.document.querySelectorAll('.timeline-month')).toHaveLength(2)

    const search = dom.window.document.querySelector('#query') as HTMLInputElement
    search.value = '共同关键词'
    search.dispatchEvent(new dom.window.Event('input'))
    expect(dom.window.document.querySelectorAll('.message')).toHaveLength(1)
    expect(dom.window.document.querySelector('#count')?.textContent).toBe(
      '已显示 1 / 筛选 1 / 当前聊天 2'
    )
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
        exportMediaUrl: 'files/target.pdf'
      },
      {
        ...messageForArchive('target-share', 'fixture', '定位消息', '', 5),
        type: '分享',
        contentData: { type: 'share', typeVal: '5', title: '目标分享' }
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
    ;(dom.window.document.querySelector('.locate-all') as HTMLElement).click()
    expect(
      dom.window.document.querySelector('[data-kind="all"]')?.classList.contains('active')
    ).toBe(true)
    expect(dom.window.document.querySelector('.message.located')?.getAttribute('data-index')).toBe(
      '0'
    )
    expect(dom.window.document.querySelector('.message.located')?.textContent).toContain('目标文字')
    dom.window.close()
  })

  it('keeps relative media, file download, quote, and missing-media renderers', () => {
    const html = renderExportPage('媒体档案')

    expect(html).toContain('audio class="audio" controls preload="metadata"')
    expect(html).toContain('video class="media-image" controls preload="metadata"')
    expect(html).toContain('class="file-attachment" href="')
    expect(html).toContain('class="quote-reference"')
    expect(html).toContain('message.exportMediaError')
    expect(html).toContain('.audio-wrap { width: 260px; max-width: 100%; min-width: 0; }')
    expect(html).toContain('.audio { display: block; width: 100%; max-width: 100%; height: 38px; }')
    expect(html).not.toMatch(/(?:src|href)="[A-Za-z]:\\/)
  })

  it('renders explicit and keyboard-accessible lightbox closing controls', () => {
    const html = renderExportPage('图片预览')

    expect(html).toContain('aria-label="关闭图片预览"')
    expect(html).toContain("closeButton.addEventListener('click', closeLightbox)")
    expect(html).toContain('if (event.target === box) closeLightbox()')
    expect(html).toContain("if (event.key === 'Escape') closeLightbox()")
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
