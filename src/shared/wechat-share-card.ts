export interface WechatShareServiceConfig {
  serviceUrl: string
  uploadToken: string
}

export interface WechatShareServiceConfigResult {
  success: boolean
  configured?: boolean
  serviceUrl?: string
  error?: string
}

export interface PublishWechatShareCardRequest {
  pngPath: string
  title: string
  description: string
  expiresInDays?: number
}

export interface PublishWechatShareCardResult {
  success: boolean
  cardId?: string
  shareUrl?: string
  viewUrl?: string
  qrCodeDataUrl?: string
  expiresAt?: string
  error?: string
}
