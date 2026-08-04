import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const requestImage = vi.fn()
vi.mock('../../src/renderer/src/components/image-loader', () => ({
  getCachedLoadedImage: vi.fn(() => undefined),
  requestImage: (...args: unknown[]) => requestImage(...args)
}))

import { ImageBubble } from '../../src/renderer/src/components/ImageBubble'
import { RichMessageBubble } from '../../src/renderer/src/components/RichMessageBubble'

const thumbnail =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII='
const original = `${thumbnail}original`

describe('ImageBubble', () => {
  beforeEach(() => {
    requestImage.mockReset()
    window.api = { copyImage: vi.fn().mockResolvedValue({ success: true }) } as typeof window.api
  })

  it('loads a thumbnail lazily, then requests the original when opened', async () => {
    requestImage
      .mockResolvedValueOnce({ data: thumbnail, isThumbnail: true })
      .mockResolvedValueOnce({ data: original, isThumbnail: false })
    const onImageClick = vi.fn()
    render(
      <ImageBubble
        imageMd5="fixture-image"
        imageDatName="fixture.dat"
        sessionId="fixture-session"
        onImageClick={onImageClick}
      />
    )

    const image = await screen.findByAltText('图片')
    expect(image).toHaveAttribute('src', thumbnail)
    await userEvent.click(image)
    await waitFor(() => expect(onImageClick).toHaveBeenCalledWith(original))
    expect(requestImage.mock.calls[1][3]).toMatchObject({ force: true })
  })

  it('shows an explicit error and allows retry', async () => {
    requestImage.mockRejectedValueOnce(new Error('不支持的 DAT 版本'))
    render(<ImageBubble imageMd5="unsupported" />)
    expect(await screen.findByText('不支持的 DAT 版本')).toBeVisible()

    requestImage.mockResolvedValueOnce({ data: thumbnail, isThumbnail: true })
    await userEvent.click(screen.getByText('加载失败'))
    expect(await screen.findByAltText('图片')).toBeVisible()
  })

  it('places a quoted image on the line below the quoted sender', async () => {
    requestImage.mockResolvedValueOnce({ data: thumbnail, isThumbnail: true })
    const { container } = render(
      <RichMessageBubble
        contentData={{
          type: 'quote',
          content: '回复内容',
          quotedContent: '[图片]',
          quotedSender: '测试群成员',
          quotedImageMd5: 'fixture-image'
        }}
        sessionId="fixture-session"
      />
    )

    expect(screen.getByText('测试群成员')).toBeInTheDocument()
    expect(container.querySelector('.quoted-message')).toHaveClass('quoted-message-image')
    expect(await screen.findByAltText('图片')).toBeVisible()
  })
})
