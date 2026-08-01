export type ImageKeySource = 'secure-storage' | 'legacy-settings' | 'environment' | 'none'
export type ImageResourceState = 'available' | 'unavailable' | 'unknown'
export type ImageDecoderSource = 'selected' | 'environment' | 'bundled' | 'system' | 'none'

export interface ImageDecoderStatus {
  installed: boolean
  available: boolean
  source: ImageDecoderSource
  selected: boolean
  directory?: string
}

export interface ImageDecoderSelectionResult {
  success: boolean
  canceled: boolean
  status?: ImageDecoderStatus
  error?: string
}

export interface ImageKeyConfigResult {
  success: boolean
  configured: boolean
  saved: boolean
  encryptionAvailable: boolean
  source: ImageKeySource
  accountId?: string
  resourceRoot: string
  xorKey?: string
  aesKey?: string
  updatedAt?: number
  error?: string
}

export interface ImageResourceCheck {
  state: ImageResourceState
  detail: string
}

export interface ImageDecryptionStatus {
  configured: boolean
  saved: boolean
  encryptionAvailable: boolean
  source: ImageKeySource
  accountId?: string
  resourceRoot: string
  updatedAt?: number
  platform: NodeJS.Platform
  autoDetectSupported: boolean
  wechatRunning: boolean
  accountIdentified: boolean
  cacheState: 'normal' | 'unavailable'
  decoder: ImageDecoderStatus
  resources: {
    imageIndex: ImageResourceCheck
    imageDirectory: ImageResourceCheck
    thumbnail: ImageResourceCheck
    original: ImageResourceCheck
    sticker: ImageResourceCheck
    video: ImageResourceCheck
  }
}

export interface SaveImageKeyRequest {
  resourceRoot: string
  xorKey: string
  aesKey: string
}

export interface TestImageDecryptionRequest extends SaveImageKeyRequest {
  userMd5: string
}

export interface ImageDecryptionTestResult {
  success: boolean
  code?:
    | 'NOT_CONFIGURED'
    | 'NO_CONVERSATION'
    | 'NO_IMAGE_MESSAGE'
    | 'FILE_NOT_FOUND'
    | 'DECRYPT_FAILED'
    | 'ACCOUNT_MISMATCH'
    | 'UNKNOWN'
  error?: string
  fileFound: boolean
  decrypted: boolean
  readable: boolean
  isThumbnail?: boolean
}
