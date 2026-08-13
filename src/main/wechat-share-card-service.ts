import { nativeImage } from 'electron'
import fs from 'fs-extra'
import QRCode from 'qrcode'
import type {
  PublishWechatShareCardRequest,
  PublishWechatShareCardResult
} from '../shared/wechat-share-card'
import { WechatShareConfigStore } from './wechat-share-config-store'

const MAX_REPORT_BYTES = 25 * 1024 * 1024

export class WechatShareCardService {
  constructor(private readonly configStore: WechatShareConfigStore) {}

  async publish(request: PublishWechatShareCardRequest): Promise<PublishWechatShareCardResult> {
    try {
      const config = await this.configStore.loadRaw()
      if (!config) return { success: false, error: '请先配置微信卡片服务' }
      const png = await fs.readFile(request.pngPath)
      if (!png.length) return { success: false, error: '日报图片为空' }
      if (png.length > MAX_REPORT_BYTES) return { success: false, error: '日报图片不能超过 25 MB' }

      const source = nativeImage.createFromBuffer(png)
      if (source.isEmpty()) return { success: false, error: '无法读取日报图片' }
      const size = source.getSize()
      const squareSize = Math.min(size.width, size.height)
      const thumbnail = source
        .crop({ x: 0, y: 0, width: squareSize, height: squareSize })
        .resize({ width: 360, height: 360, quality: 'best' })
        .toJPEG(84)

      const response = await fetch(`${config.serviceUrl}/api/cards`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.uploadToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          title: request.title.trim().slice(0, 64),
          description: request.description.trim().slice(0, 120),
          expiresInDays: Math.max(1, Math.min(30, request.expiresInDays || 7)),
          imageBase64: png.toString('base64'),
          thumbnailBase64: thumbnail.toString('base64')
        }),
        signal: AbortSignal.timeout(90_000)
      })
      const payload = (await response.json().catch(() => ({}))) as {
        cardId?: string
        shareUrl?: string
        viewUrl?: string
        expiresAt?: string
        error?: string
      }
      if (!response.ok || !payload.shareUrl) {
        return { success: false, error: payload.error || `卡片服务返回 HTTP ${response.status}` }
      }
      return {
        success: true,
        cardId: payload.cardId,
        shareUrl: payload.shareUrl,
        viewUrl: payload.viewUrl,
        expiresAt: payload.expiresAt,
        qrCodeDataUrl: await QRCode.toDataURL(payload.shareUrl, {
          width: 360,
          margin: 2,
          errorCorrectionLevel: 'M'
        })
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}
