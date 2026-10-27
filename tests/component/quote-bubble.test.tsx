import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

// 图片引用会挂载 ImageBubble，这里不需要真的去取图。
vi.mock('../../src/renderer/src/components/image-loader', () => ({
  getCachedLoadedImage: vi.fn(() => undefined),
  requestImage: vi.fn(() => Promise.resolve({ data: '', isThumbnail: true }))
}))

import { RichMessageBubble } from '../../src/renderer/src/components/RichMessageBubble'

/** 合成 fixture：正文刻意写长，才能触发引用框的单行截断。名字用仓库通用占位名。 */
const LONG_QUOTED = [
  '群发言统计',
  '以下当前群成员在统计区间内的本地已归档消息中没有发言记录，这段正文刻意写长，用来触发引用框的单行省略',
  '1. 张三',
  '2. 李四',
  '3. 王五'
].join('\n')

describe('引用气泡 — 截断之外必须能把全文交出来', () => {
  it('引用框的 title 带完整引用内容，hover 就能看到被省略的部分', () => {
    const { container } = render(
      <RichMessageBubble
        contentData={{ type: 'quote', content: '👍👍', quotedContent: LONG_QUOTED }}
      />
    )

    const box = container.querySelector('.quoted-message')
    expect(box).not.toBeNull()
    const title = box!.getAttribute('title') || ''
    // 单行省略只是排版，title 里必须是**未截断**的原文
    expect(title).toContain('1. 张三')
    expect(title).toContain('3. 王五')
    expect(title).not.toContain('…')
  })

  it('有名字时 title 里也带上名字', () => {
    const { container } = render(
      <RichMessageBubble
        contentData={{
          type: 'quote',
          content: '👍👍',
          quotedSender: '张三',
          quotedContent: LONG_QUOTED
        }}
      />
    )

    expect(container.querySelector('.quoted-sender')?.textContent).toBe('张三')
    expect(container.querySelector('.quoted-message')?.getAttribute('title')).toBe(
      `张三: ${LONG_QUOTED}`
    )
  })

  it('空白 sender 不渲染名字，避免只剩一个冒号', () => {
    const { container } = render(
      <RichMessageBubble
        contentData={{
          type: 'quote',
          content: '好的',
          quotedSender: '   ',
          quotedContent: '被引用'
        }}
      />
    )

    expect(container.querySelector('.quoted-sender')).toBeNull()
    expect(container.querySelector('.quoted-message')?.getAttribute('title')).toBe('被引用')
  })

  it('图片引用同样带 title，且不渲染正文 span', () => {
    const { container } = render(
      <RichMessageBubble
        contentData={{
          type: 'quote',
          content: '这张图',
          quotedSender: '张三',
          quotedContent: '[图片]',
          quotedImageMd5: 'fixture-image',
          quotedImageDatName: 'fixture.dat'
        }}
        sessionId="fixture-session"
      />
    )

    const box = container.querySelector('.quoted-message')
    expect(box).toHaveClass('quoted-message-image')
    expect(box?.getAttribute('title')).toBe('张三: [图片]')
    expect(container.querySelector('.quoted-text')).toBeNull()
  })
})
