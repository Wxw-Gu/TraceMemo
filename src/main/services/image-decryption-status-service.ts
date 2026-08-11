import { app } from 'electron'
import fs from 'fs-extra'
import os from 'os'
import path from 'path'
import type {
  ImageDecoderStatus,
  ImageDecryptionStatus,
  ImageDecryptionTestResult,
  ImageKeyConfigResult,
  ImageResourceCheck,
  TestImageDecryptionRequest
} from '../../shared/image-decryption'
import {
  ImageDecryptService,
  inspectImageDecoderStatus,
  type ImageDecodeDiagnostic
} from '../image-decrypt-service'
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
    fs.existsSync(path.join(os.homedir(), 'Documents', 'TraceMemo', 'Emojis')) ||
    fs.existsSync(path.join(os.homedir(), 'Documents', 'WechatExplorer', 'Emojis'))
  const dbConnected = chat.isReady()
  const [wechatRunning, decoder] = await Promise.all([
    isWechatRunning(),
    inspectImageDecoderStatus()
  ])

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
    wechatRunning,
    accountIdentified: Boolean(chat.getSelfAccountInfo()?.wxid),
    cacheState: canUseCacheRoot() ? 'normal' : 'unavailable',
    decoder,
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

export async function testImageDecryption(
  request: TestImageDecryptionRequest
): Promise<ImageDecryptionTestResult> {
  const startedAt = Date.now()
  let testedImage:
    | { md5?: string; datName?: string; sessionId?: string; selection: string }
    | undefined
  let filePath: string | undefined
  let decodeDiagnostic: ImageDecodeDiagnostic | undefined
  let decoder: ImageDecoderStatus | undefined
  const finish = (
    result: Omit<ImageDecryptionTestResult, 'diagnosticLog'>
  ): ImageDecryptionTestResult => ({
    ...result,
    diagnosticLog: buildImageTestDiagnosticLog({
      request,
      result,
      startedAt,
      testedImage,
      filePath,
      decodeDiagnostic,
      decoder
    })
  })

  const normalized = validateImageKeyRequest(request)
  if (!normalized.success) return finish(failure('NOT_CONFIGURED', normalized.error))
  if (!chat.isReady() || !request.userMd5) {
    return finish(failure('NO_CONVERSATION', '请选择已连接账号中的聊天记录'))
  }

  try {
    const messages = chat.listMessages(request.userMd5, undefined, undefined, { limit: 300 })
    const imageMessage = [...messages]
      .reverse()
      .find((message) => message.contentData?.type === 'image')
    if (!imageMessage || imageMessage.contentData?.type !== 'image') {
      return finish(
        failure(
          'NO_IMAGE_MESSAGE',
          '所选聊天最近 300 条消息内没有可测试的图片，请换一个含图片的会话'
        )
      )
    }

    const service = new ImageDecryptService(
      normalized.xorKey,
      normalized.aesKey,
      chat.getChatDb()?.getWcdb4Client()
    )
    const image = imageMessage.contentData
    testedImage = {
      md5: image.md5,
      datName: image.datName,
      sessionId: imageMessage.sessionId,
      selection: '所选会话最近 300 条消息中的最后一张图片'
    }
    const testAccountDir = normalized.resourceRoot || undefined
    filePath =
      (await service.findImageFileAsync(image.md5, image.datName, {
        allowThumbnail: false,
        accountDir: testAccountDir,
        sessionId: imageMessage.sessionId,
        sessionMd5: request.userMd5,
        createTime: imageMessage.createTime
      })) || undefined
    if (!filePath) {
      filePath =
        (await service.findImageFileAsync(image.md5, image.datName, {
          allowThumbnail: true,
          accountDir: testAccountDir,
          sessionId: imageMessage.sessionId,
          sessionMd5: request.userMd5,
          createTime: imageMessage.createTime
        })) || undefined
    }
    if (!filePath) return finish(failure('FILE_NOT_FOUND', '图片文件不存在'))

    let decoded = await service.decryptImageToBase64WithFallbackAsync(filePath, true)
    if (!decoded) {
      // Worker 失败后在主进程做一次同步诊断：既能保留具体失败阶段，
      // 也能在少数 Worker 启动异常时继续测试普通图片。
      decoded = service.decryptImageToBase64WithFallback(filePath, true)
    }

    if (!decoded) {
      decodeDiagnostic = service.getLastDecodeDiagnostic()
      if (decodeDiagnostic.code === 'WXGF_REQUIRES_DECODER') {
        decoder = await inspectImageDecoderStatus()
      }
      return finish({
        success: false,
        code: 'DECRYPT_FAILED',
        error: getDecodeFailureMessage(decodeDiagnostic, decoder),
        fileFound: true,
        decrypted: isDecryptedDiagnostic(decodeDiagnostic.code),
        readable: false,
        isThumbnail: service.isThumbnailFile(filePath)
      })
    }

    filePath = decoded.filePath
    decodeDiagnostic = buildSuccessDiagnostic(decoded.data, decoded.filePath)
    const readable = decoded.data.startsWith('data:image/')
    if (!readable) {
      return finish({
        success: false,
        code: 'DECRYPT_FAILED',
        error: '图片解密结果不可读取',
        fileFound: true,
        decrypted: true,
        readable: false,
        isThumbnail: service.isThumbnailFile(decoded.filePath)
      })
    }
    return finish({
      success: true,
      fileFound: true,
      decrypted: true,
      readable: true,
      isThumbnail: service.isThumbnailFile(decoded.filePath)
    })
  } catch {
    return finish(failure('UNKNOWN', '图片解析测试未通过'))
  }
}

function buildSuccessDiagnostic(data: string, filePath: string): ImageDecodeDiagnostic {
  const format = /^data:image\/([^;]+);/i.exec(data)?.[1]?.toUpperCase()
  const directImageFormat = inspectDirectImageFormat(filePath)
  return {
    code: directImageFormat ? 'DIRECT_IMAGE' : 'SUCCESS',
    detail: directImageFormat ? 'DAT 文件内容是可直接读取的图片' : '图片解密并识别成功',
    datVersion: directImageFormat ? undefined : inspectDatVersion(filePath),
    fileSize: safeFileSize(filePath),
    imageFormat: format || directImageFormat
  }
}

function inspectDirectImageFormat(filePath: string): string | undefined {
  try {
    const signature = fs.readFileSync(filePath).subarray(0, 12)
    if (signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff) return 'JPEG'
    if (
      signature[0] === 0x89 &&
      signature[1] === 0x50 &&
      signature[2] === 0x4e &&
      signature[3] === 0x47
    )
      return 'PNG'
    if (
      signature[0] === 0x47 &&
      signature[1] === 0x49 &&
      signature[2] === 0x46 &&
      signature[3] === 0x38
    )
      return 'GIF'
    if (signature[0] === 0x42 && signature[1] === 0x4d) return 'BMP'
    if (signature.subarray(0, 4).toString('ascii') === 'RIFF') return 'WEBP'
    return undefined
  } catch {
    return undefined
  }
}

function inspectDatVersion(filePath: string): number | undefined {
  if (!path.extname(filePath).toLowerCase().includes('dat')) return undefined
  try {
    const signature = fs.readFileSync(filePath).subarray(0, 6)
    return signature.equals(Buffer.from([0x07, 0x08, 0x56, 0x32, 0x08, 0x07])) ? 2 : 0
  } catch {
    return undefined
  }
}

function safeFileSize(filePath: string): number | undefined {
  try {
    return fs.statSync(filePath).size
  } catch {
    return undefined
  }
}

function isDecryptedDiagnostic(code: ImageDecodeDiagnostic['code']): boolean {
  return code === 'WXGF_REQUIRES_DECODER' || code === 'UNKNOWN_IMAGE_FORMAT'
}

function getDecodeFailureMessage(
  diagnostic: ImageDecodeDiagnostic,
  decoder?: ImageDecoderStatus
): string {
  switch (diagnostic.code) {
    case 'UNSUPPORTED_DAT_VERSION':
      return '仅支持 WeChat 4.0 图片协议，当前图片格式不受支持'
    case 'MISSING_AES_KEY':
      return '图片密钥未配置'
    case 'AES_DECRYPT_FAILED':
      return '图片密钥与当前账号不匹配，或图片文件已损坏'
    case 'INVALID_DAT_FILE':
      return '图片文件不完整或格式异常'
    case 'WXGF_REQUIRES_DECODER':
      return decoder?.available
        ? 'WXGF/HEVC 图片转换失败，请复制测试日志反馈'
        : '该图片需要 FFmpeg 的 HEVC 解码能力'
    case 'UNKNOWN_IMAGE_FORMAT':
      return '图片已解密，但当前格式无法识别'
    default:
      return '无法解析媒体文件'
  }
}

export function buildImageTestDiagnosticLog(input: {
  request: TestImageDecryptionRequest
  result: Omit<ImageDecryptionTestResult, 'diagnosticLog'>
  startedAt: number
  testedImage?: { md5?: string; datName?: string; sessionId?: string; selection: string }
  filePath?: string
  decodeDiagnostic?: ImageDecodeDiagnostic
  decoder?: ImageDecoderStatus
}): string {
  const root = String(input.request.resourceRoot || '').trim()
  const rootExists = root ? fs.existsSync(root) : false
  const rootIsDirectory = rootExists ? safeIsDirectory(root) : false
  const resultCode = input.result.success ? 'SUCCESS' : input.result.code || 'UNKNOWN'
  return [
    'TraceMemo 图片解析测试日志（已脱敏）',
    `时间：${new Date().toISOString()}`,
    `应用版本：${safeAppVersion()}`,
    `运行环境：${process.platform} ${process.arch}`,
    `测试结果：${input.result.success ? '成功' : '失败'}（${resultCode}）`,
    `耗时：${Date.now() - input.startedAt} ms`,
    '',
    '[配置]',
    `资源目录：${root ? `已填写（末级 ${redactIdentifier(path.basename(root))}）` : '未填写'}`,
    `目录存在：${yesNo(rootExists)}`,
    `目录可读取：${yesNo(rootIsDirectory)}`,
    `包含图片目录：${yesNo(rootIsDirectory && hasImageDirectory(root))}`,
    `AES 密钥：${input.request.aesKey.trim().length === 16 ? '已配置（长度有效，内容未记录）' : '未配置或长度无效'}`,
    `XOR Key：${/^0x[0-9a-f]{2}$/i.test(input.request.xorKey.trim()) ? '格式有效（内容未记录）' : '格式无效'}`,
    '',
    '[测试样本]',
    `选取方式：${input.testedImage?.selection || '未选取'}`,
    `会话定位信息：${input.testedImage?.sessionId ? '有' : '无'}`,
    `图片 MD5：${redactIdentifier(input.testedImage?.md5)}`,
    `DAT 文件名：${redactFileName(input.testedImage?.datName)}`,
    '',
    '[文件查找]',
    '查找方式：异步会话目录 + Hardlink 索引',
    `找到文件：${yesNo(input.result.fileFound)}`,
    `文件来源：${input.filePath ? describeFileSource(input.filePath) : '无'}`,
    `清晰度：${input.filePath ? (input.result.isThumbnail ? '缩略图' : '原图/高清变体') : '未知'}`,
    `文件大小：${formatBytes(input.decodeDiagnostic?.fileSize ?? (input.filePath ? safeFileSize(input.filePath) : undefined))}`,
    `DAT 协议：${formatDatProtocol(input.decodeDiagnostic, input.filePath)}`,
    '',
    '[解析结果]',
    `文件找到：${yesNo(input.result.fileFound)}`,
    `数据解密：${yesNo(input.result.decrypted)}`,
    `图片可读：${yesNo(input.result.readable)}`,
    `诊断代码：${input.decodeDiagnostic?.code || resultCode}`,
    `诊断说明：${input.decodeDiagnostic?.detail || input.result.error || '无'}`,
    `图片格式：${input.decodeDiagnostic?.imageFormat || '未识别'}`,
    `WXGF/HEVC：${input.decodeDiagnostic?.wxgf ? '是' : '否/未检测'}`,
    `FFmpeg：${formatDecoder(input.decoder)}`,
    '',
    `建议：${buildDiagnosticAdvice(resultCode, input.decodeDiagnostic, input.decoder)}`
  ].join('\n')
}

function safeAppVersion(): string {
  try {
    return app.getVersion()
  } catch {
    return '未知'
  }
}

function safeIsDirectory(value: string): boolean {
  try {
    return fs.statSync(value).isDirectory()
  } catch {
    return false
  }
}

function redactIdentifier(value?: string): string {
  const normalized = String(value || '').trim()
  if (!normalized) return '无'
  if (normalized.length <= 8) return `${normalized.slice(0, 2)}***`
  return `${normalized.slice(0, 4)}…${normalized.slice(-4)}`
}

function redactFileName(value?: string): string {
  const normalized = path.basename(String(value || '').trim())
  if (!normalized) return '无'
  const extension = path.extname(normalized)
  const stem = extension ? normalized.slice(0, -extension.length) : normalized
  return `${redactIdentifier(stem)}${extension.toLowerCase()}`
}

function describeFileSource(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase()
  if (normalized.includes('/msg/attach/')) return 'msg/attach'
  if (normalized.includes('/cache/')) return 'cache'
  if (normalized.includes('/filestorage/')) return 'FileStorage'
  return '其他本地目录（完整路径未记录）'
}

function yesNo(value: boolean): string {
  return value ? '是' : '否'
}

function formatBytes(value?: number): string {
  if (!Number.isFinite(value)) return '未知'
  if ((value as number) < 1024) return `${value} B`
  return `${((value as number) / 1024).toFixed(1)} KiB`
}

function formatDatVersion(value?: number): string {
  if (value === 2) return 'WeChat 4.0 V2'
  if (value === 0) return '不受支持/旧版格式'
  return '未检测'
}

function formatDatProtocol(diagnostic?: ImageDecodeDiagnostic, filePath?: string): string {
  if (diagnostic?.code === 'DIRECT_IMAGE') return '明文图片（无需 DAT 解密）'
  return formatDatVersion(
    diagnostic?.datVersion ?? (filePath ? inspectDatVersion(filePath) : undefined)
  )
}

function formatDecoder(decoder?: ImageDecoderStatus): string {
  if (!decoder) return '未检测（当前失败阶段不需要）'
  if (!decoder.installed) return '未安装'
  return decoder.available
    ? `可用（${decoder.source}，支持 HEVC）`
    : `已安装但不支持 HEVC（${decoder.source}）`
}

function buildDiagnosticAdvice(
  resultCode: string,
  diagnostic?: ImageDecodeDiagnostic,
  decoder?: ImageDecoderStatus
): string {
  if (resultCode === 'SUCCESS') return '图片解析正常，无需处理。'
  if (resultCode === 'FILE_NOT_FOUND') {
    return '确认图片资源目录属于当前微信账号，并在最近发送过图片的会话中重新测试。'
  }
  switch (diagnostic?.code) {
    case 'UNSUPPORTED_DAT_VERSION':
      return '换一张由微信 4.0 接收或发送的近期图片测试。'
    case 'AES_DECRYPT_FAILED':
    case 'MISSING_AES_KEY':
      return '重新获取当前微信账号的图片密钥后再测试。'
    case 'INVALID_DAT_FILE':
      return '在微信中重新打开或下载该图片，再重新测试。'
    case 'WXGF_REQUIRES_DECODER':
      return decoder?.available
        ? 'FFmpeg 已可用但转换失败，请将本日志发给开发者。'
        : '安装或重新选择支持 HEVC 的 FFmpeg 后再测试。'
    case 'UNKNOWN_IMAGE_FORMAT':
      return '请将本日志发给开发者，并换一张近期普通图片交叉测试。'
    default:
      return inputAdviceForCode(resultCode)
  }
}

function inputAdviceForCode(resultCode: string): string {
  if (resultCode === 'NO_CONVERSATION') return '先连接微信账号并选择一条聊天记录。'
  if (resultCode === 'NO_IMAGE_MESSAGE') return '换一个最近 300 条消息内包含图片的会话。'
  if (resultCode === 'NOT_CONFIGURED') return '检查资源目录、AES 密钥和 XOR Key 格式。'
  return '请将本日志发给开发者进一步排查。'
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
