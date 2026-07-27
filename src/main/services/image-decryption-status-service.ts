import { app } from 'electron'
import fs from 'fs-extra'
import os from 'os'
import path from 'path'
import type {
  ImageDecryptionStatus,
  ImageDecryptionTestResult,
  ImageKeyConfigResult,
  ImageResourceCheck,
  TestImageDecryptionRequest
} from '../../shared/image-decryption'
import { ImageDecryptService } from '../image-decrypt-service'
import * as chat from './chat-service'
import { validateImageKeyRequest } from './image-key-config-service'
import { isWechatRunning } from './wechat-process-status'

export async function inspectImageDecryptionStatus(
  config: ImageKeyConfigResult
): Promise<ImageDecryptionStatus> {
  // 状态面板的"图片资源目录"始终等于当前识别到的微信账号根目录；
  // 仅在微信未连接时回退到上次配置中的 resourceRoot，避免空白。
  const accountRoot = chat.getCurrentAccountRoot() || config.resourceRoot || ''
  const imageDirectoryFound = hasImageDirectory(accountRoot)
  const stickerCacheFound =
    fs.existsSync(path.join(accountRoot, 'cache')) ||
    fs.existsSync(path.join(os.homedir(), 'Documents', 'WechatExplorer', 'Emojis'))
  const dbConnected = chat.isReady()

  return {
    configured: config.configured,
    saved: config.saved,
    encryptionAvailable: config.encryptionAvailable,
    source: config.source,
    accountId: config.accountId,
    resourceRoot: accountRoot,
    updatedAt: config.updatedAt,
    platform: process.platform,
    autoDetectSupported: process.platform === 'win32' || process.platform === 'darwin',
    wechatRunning: await isWechatRunning(),
    accountIdentified: Boolean(chat.getSelfAccountInfo()?.wxid),
    cacheState: canUseCacheRoot() ? 'normal' : 'unavailable',
    resources: {
      imageIndex: check(dbConnected, dbConnected ? '可用' : '数据库尚未连接'),
      imageDirectory: check(imageDirectoryFound, imageDirectoryFound ? '已找到' : '未找到'),
      thumbnail: pending(imageDirectoryFound),
      original: pending(imageDirectoryFound),
      sticker: stickerCacheFound
        ? check(true, '本地缓存可用')
        : { state: 'unknown', detail: '独立按需解析' },
      video: { state: 'unavailable', detail: '当前版本未提供视频媒体解析' }
    }
  }
}

export function testImageDecryption(
  request: TestImageDecryptionRequest
): ImageDecryptionTestResult {
  const normalized = validateImageKeyRequest(request)
  if (!normalized.success) return failure('NOT_CONFIGURED', normalized.error)
  if (!chat.isReady() || !request.userMd5) {
    return failure('NO_CONVERSATION', '请选择已连接账号中的聊天记录')
  }

  try {
    const messages = chat.listMessages(request.userMd5, undefined, undefined, { limit: 300 })
    const imageMessage = [...messages]
      .reverse()
      .find((message) => message.contentData?.type === 'image')
    if (!imageMessage || imageMessage.contentData?.type !== 'image') {
      return failure(
        'NO_IMAGE_MESSAGE',
        '所选聊天最近 300 条消息内没有可测试的图片，请换一个含图片的会话'
      )
    }

    const service = new ImageDecryptService(
      normalized.xorKey,
      normalized.aesKey,
      chat.getChatDb()?.getWcdb4Client()
    )
    const image = imageMessage.contentData
    // 测试时优先使用用户在下方"图片资源目录"输入框填写的目录；
    // 找不到再退回默认 accountDir。
    const testAccountDir = normalized.resourceRoot || undefined
    let filePath = service.findImageFile(image.md5, image.datName, {
      allowThumbnail: false,
      accountDir: testAccountDir
    })
    if (!filePath)
      filePath = service.findImageFile(image.md5, image.datName, {
        allowThumbnail: true,
        accountDir: testAccountDir
      })
    if (!filePath) return failure('FILE_NOT_FOUND', '图片文件不存在')

    const data = service.decryptImageToBase64(filePath)
    if (!data) {
      // 三步联动：解密失败 → fileFound/decrypted/readable 都为 false。
      return {
        success: false,
        code: 'DECRYPT_FAILED',
        error: '无法解析媒体文件',
        fileFound: false,
        decrypted: false,
        readable: false
      }
    }
    const readable = data.startsWith('data:image/')
    if (!readable) {
      // 三步联动：解密成功但字节流不可读 → 前一步打勾（确实找到了 dat），
      // 但 decrypted/readable 全为 false，让 UI 表达"找到但解析失败"。
      return {
        success: false,
        code: 'DECRYPT_FAILED',
        error: '图片解密结果不可读取',
        fileFound: true,
        decrypted: false,
        readable: false,
        isThumbnail: service.isThumbnailFile(filePath)
      }
    }
    return {
      success: true,
      fileFound: true,
      decrypted: true,
      readable: true,
      isThumbnail: service.isThumbnailFile(filePath)
    }
  } catch {
    return failure('UNKNOWN', '图片解析测试未通过')
  }
}

function hasImageDirectory(accountRoot: string): boolean {
  if (!accountRoot) return false
  return [
    path.join(accountRoot, 'msg', 'attach'),
    path.join(accountRoot, 'FileStorage', 'Image'),
    path.join(accountRoot, 'FileStorage', 'Image2'),
    path.join(accountRoot, 'FileStorage', 'MsgImg')
  ].some((candidate) => fs.existsSync(candidate))
}

function canUseCacheRoot(): boolean {
  try {
    const cacheRoot = path.join(app.getPath('userData'), 'cache')
    fs.ensureDirSync(cacheRoot)
    return fs.statSync(cacheRoot).isDirectory()
  } catch {
    return false
  }
}

function check(available: boolean, detail: string): ImageResourceCheck {
  return { state: available ? 'available' : 'unavailable', detail }
}

function pending(directoryFound: boolean): ImageResourceCheck {
  return directoryFound
    ? { state: 'unknown', detail: '通过图片解析测试确认' }
    : { state: 'unavailable', detail: '图片目录不可用' }
}

function failure(
  code: NonNullable<ImageDecryptionTestResult['code']>,
  error: string
): ImageDecryptionTestResult {
  return { success: false, code, error, fileFound: false, decrypted: false, readable: false }
}
