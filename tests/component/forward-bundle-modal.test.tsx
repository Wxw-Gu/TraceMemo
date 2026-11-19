import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { RichMessageBubble } from '../../src/renderer/src/components/RichMessageBubble'
import type { ParsedContent } from '../../src/shared/types'

describe('ForwardBundleBubble stacked modal windows', () => {
  beforeEach(() => {
    ;(window as unknown as { api?: Record<string, unknown> }).api = {
      getImage: vi.fn().mockResolvedValue({
        success: true,
        data: 'data:image/jpeg;base64,AAAA'
      }),
      copyImage: vi.fn().mockResolvedValue({ success: true })
    }
  })

  it('opens a modal on click and stacks a second modal window for nested forwards', async () => {
    const contentData: ParsedContent = {
      type: 'forwardBundle',
      title: '群聊的聊天记录',
      recordDir: 'fixture-rec-0001',
      items: [
        {
          messageType: 2,
          sender: '张三',
          sentAt: '2026-01-02 10:00',
          text: '[图片]',
          dataIndex: 0,
          imageMd5: '0123456789abcdef0123456789abcdef',
          imageDatName: 'rec:fixture-rec-0001:0'
        },
        {
          messageType: 17,
          sender: '成员A',
          sentAt: '2026-01-02 10:05',
          text: '[聊天记录]',
          nestedTitle: '嵌套的聊天记录',
          nested: [
            {
              messageType: 1,
              sender: '成员B',
              sentAt: '2026-01-02 09:30',
              text: '这是第二层弹窗里的内容'
            }
          ]
        }
      ]
    }

    render(
      <RichMessageBubble contentData={contentData} sessionId="filehelper" onImageClick={vi.fn()} />
    )

    expect(screen.getByText('[图片]')).toBeTruthy()
    expect(screen.queryAllByRole('dialog')).toHaveLength(0)

    fireEvent.click(screen.getByTitle('点击弹窗查看完整聊天记录'))
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByRole('dialog', { name: '群聊的聊天记录' })).toBeTruthy()

    fireEvent.click(screen.getByText('嵌套的聊天记录'))
    expect(screen.getAllByRole('dialog')).toHaveLength(2)
    expect(screen.getByRole('dialog', { name: '嵌套的聊天记录' })).toBeTruthy()
    expect(screen.getByText('这是第二层弹窗里的内容')).toBeTruthy()

    // 关闭顶层不应连带关掉下层。
    const closeButtons = screen.getAllByLabelText('关闭聊天记录窗口')
    fireEvent.click(closeButtons[1])
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByRole('dialog', { name: '群聊的聊天记录' })).toBeTruthy()

    fireEvent.click(screen.getByLabelText('关闭聊天记录窗口'))
    expect(screen.queryAllByRole('dialog')).toHaveLength(0)
  })
})
