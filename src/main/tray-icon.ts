import { readFileSync } from 'fs'

export interface TrayNativeImage {
  addRepresentation(options: { scaleFactor: number; dataURL: string }): void
  isEmpty(): boolean
  resize(options: { width: number; height: number; quality: 'best' }): TrayNativeImage
  setTemplateImage(option: boolean): void
}

export interface TrayNativeImageFactory<T extends TrayNativeImage = TrayNativeImage> {
  createEmpty(): T
  createFromPath(path: string): T
}

export interface TrayTemplateIconPaths {
  oneX: string
  twoX: string
}

type ReadImageFile = (path: string) => Buffer

function toPngDataUrl(buffer: Buffer): string {
  return `data:image/png;base64,${buffer.toString('base64')}`
}

export function createTrayImage<T extends TrayNativeImage>(
  platform: NodeJS.Platform,
  appIconPath: string,
  templateIconPaths: TrayTemplateIconPaths,
  nativeImage: TrayNativeImageFactory<T>,
  readImageFile: ReadImageFile = readFileSync
): T {
  if (platform === 'darwin') {
    const image = nativeImage.createEmpty()
    image.addRepresentation({
      scaleFactor: 1,
      dataURL: toPngDataUrl(readImageFile(templateIconPaths.oneX))
    })
    image.addRepresentation({
      scaleFactor: 2,
      dataURL: toPngDataUrl(readImageFile(templateIconPaths.twoX))
    })
    image.setTemplateImage(true)
    return image
  }

  const image = nativeImage.createFromPath(appIconPath)
  return image.isEmpty()
    ? nativeImage.createEmpty()
    : (image.resize({ width: 24, height: 24, quality: 'best' }) as T)
}
