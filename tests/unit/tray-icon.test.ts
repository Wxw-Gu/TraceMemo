import { describe, expect, it, vi } from 'vitest'
import { createTrayImage, type TrayNativeImage } from '../../src/main/tray-icon'

function makeImage(empty = false): TrayNativeImage {
  const image = {
    addRepresentation: vi.fn(),
    isEmpty: vi.fn(() => empty),
    resize: vi.fn(),
    setTemplateImage: vi.fn()
  }
  image.resize.mockReturnValue(image)
  return image as unknown as TrayNativeImage
}

describe('tray icon creation', () => {
  it('uses a monochrome 1x/2x template image on macOS', () => {
    const image = makeImage()
    const readImageFile = vi.fn((path: string) => Buffer.from(path))
    const nativeImage = {
      createEmpty: vi.fn(() => image),
      createFromPath: vi.fn(() => makeImage())
    }

    const result = createTrayImage(
      'darwin',
      '/app/icon.png',
      { oneX: '/resources/trayTemplate.png', twoX: '/resources/trayTemplate@2x.png' },
      nativeImage,
      readImageFile
    )

    expect(result).toBe(image)
    expect(readImageFile.mock.calls.map(([path]) => path)).toEqual([
      '/resources/trayTemplate.png',
      '/resources/trayTemplate@2x.png'
    ])
    expect(image.addRepresentation).toHaveBeenNthCalledWith(1, {
      scaleFactor: 1,
      dataURL: `data:image/png;base64,${Buffer.from('/resources/trayTemplate.png').toString('base64')}`
    })
    expect(image.addRepresentation).toHaveBeenNthCalledWith(2, {
      scaleFactor: 2,
      dataURL: `data:image/png;base64,${Buffer.from('/resources/trayTemplate@2x.png').toString('base64')}`
    })
    expect(image.setTemplateImage).toHaveBeenCalledWith(true)
    expect(nativeImage.createFromPath).not.toHaveBeenCalled()
  })

  it('preserves the app icon resize policy on Windows', () => {
    const appImage = makeImage()
    const nativeImage = {
      createEmpty: vi.fn(() => makeImage()),
      createFromPath: vi.fn(() => appImage)
    }

    const result = createTrayImage(
      'win32',
      '/app/icon.png',
      { oneX: '/resources/trayTemplate.png', twoX: '/resources/trayTemplate@2x.png' },
      nativeImage,
      vi.fn(() => Buffer.alloc(0))
    )

    expect(nativeImage.createFromPath).toHaveBeenCalledWith('/app/icon.png')
    expect(appImage.resize).toHaveBeenCalledWith({ width: 24, height: 24, quality: 'best' })
    expect(appImage.setTemplateImage).not.toHaveBeenCalled()
    expect(result).toBe(appImage)
  })
})
