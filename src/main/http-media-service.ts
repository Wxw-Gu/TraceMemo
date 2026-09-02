import { loadSettings } from './services/settings-store'
import { getChatDb, getImageMessageReference, isReady } from './services/chat-service'
import { ImageDecryptService } from './image-decrypt-service'
import { ImageKeyConfigService } from './services/image-key-config-service'

export type HttpImageResult = {
  buffer: Buffer
  mimeType: string
}

export class HttpMediaError extends Error {
  constructor(
    public readonly code: 'NOT_READY' | 'NOT_FOUND' | 'NOT_IMAGE' | 'READ_FAILED',
    message: string
  ) {
    super(message)
    this.name = 'HttpMediaError'
  }
}

let imageService: ImageDecryptService | null = null
let imageServiceKey = ''
let imageServiceClient: ReturnType<
  NonNullable<ReturnType<typeof getChatDb>>['getWcdb4Client']
> | null = null

function getImageService(): ImageDecryptService {
  const config = new ImageKeyConfigService()
  const imageConfig = config.getConfig()
  const aesKey = imageConfig.aesKey || ''
  const xorKey = imageConfig.xorKey || '0x40'
  const key = `${xorKey}:${aesKey}`
  const client = getChatDb()?.getWcdb4Client() || null
  if (!imageService || imageServiceKey !== key || imageServiceClient !== client) {
    imageService = new ImageDecryptService(xorKey, aesKey, client, loadSettings().dbRoot)
    imageServiceKey = key
    imageServiceClient = client
  }
  return imageService
}

function decodeDataUrl(value: string): HttpImageResult | null {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=]+)$/i.exec(value)
  if (!match) return null
  return { mimeType: match[1].toLowerCase(), buffer: Buffer.from(match[2], 'base64') }
}

export async function readImageMedia(messageId: string): Promise<HttpImageResult> {
  if (!isReady()) throw new HttpMediaError('NOT_READY', 'TraceMemo 数据库未初始化')
  const reference = getImageMessageReference(messageId)
  if (!reference) throw new HttpMediaError('NOT_FOUND', '未找到图片消息')
  if (!reference.imageMd5 && !reference.imageDatName) {
    throw new HttpMediaError('NOT_IMAGE', '消息不是可读取的图片消息')
  }

  const service = getImageService()
  const filePath = await service.findImageFileAsync(reference.imageMd5, reference.imageDatName, {
    allowThumbnail: false,
    sessionId: reference.sessionId,
    createTime: reference.createTime
  })
  const fallbackPath =
    filePath ||
    (await service.findImageFileAsync(reference.imageMd5, reference.imageDatName, {
      allowThumbnail: true,
      sessionId: reference.sessionId,
      createTime: reference.createTime
    }))
  if (!fallbackPath) throw new HttpMediaError('NOT_FOUND', '图片文件不存在')

  const decoded = await service.decryptImageToBase64WithFallbackAsync(fallbackPath, true)
  if (!decoded) throw new HttpMediaError('READ_FAILED', '图片读取或解密失败')
  const image = decodeDataUrl(decoded.data)
  if (!image || image.buffer.length === 0) {
    throw new HttpMediaError('READ_FAILED', '图片数据无效')
  }
  return image
}

export function resetHttpMediaService(): void {
  imageService = null
  imageServiceKey = ''
  imageServiceClient = null
}
