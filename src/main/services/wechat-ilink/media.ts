import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import type { FetchLike, ILinkClient } from './client'
import { assertBusinessOk, excerptBody, ILinkError } from './errors'
import { buildSendMessageBody, createClientId } from './sender'
import {
  ILINK_CDN_BASE_URL,
  ILINK_CDN_MEDIA_TYPE_FILE,
  ILINK_CDN_MEDIA_TYPE_IMAGE,
  ILINK_CDN_MEDIA_TYPE_VIDEO,
  ILINK_ITEM_TYPE_FILE,
  ILINK_ITEM_TYPE_IMAGE,
  ILINK_ITEM_TYPE_VIDEO,
  type ILinkMessageItem
} from './types'

/**
 * 媒体消息（图片 / 视频 / 文件）。
 *
 * 协议要求端到端加密：随机 16 字节 AES-128-ECB 密钥 → 加密后 PUT 到 CDN →
 * sendmessage 里带 CDN 引用与 base64(hex key)。
 *
 * 本项目不生成缩略图：官方文档提到 IMAGE/VIDEO 可携带缩略图字段，
 * 这里显式声明 `no_need_thumb: true`，避免服务端等待一个永远不会上传的缩略图。
 */

const CDN_REQUEST_TIMEOUT_MS = 60_000
const AES_BLOCK_SIZE = 16

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.zip': 'application/zip'
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi'])

export function aesEcbPaddedSize(plaintextSize: number): number {
  return (Math.floor(plaintextSize / AES_BLOCK_SIZE) + 1) * AES_BLOCK_SIZE
}

export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

export function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  if (ciphertext.length === 0 || ciphertext.length % AES_BLOCK_SIZE !== 0) {
    throw new ILinkError({ kind: 'protocol', message: '密文长度不是 AES 块大小的整数倍' })
  }
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

/** 协议要求把 hex 字符串再做 base64 放进 item.media.aes_key。 */
export function aesKeyToBase64(hexKey: string): string {
  return Buffer.from(hexKey, 'utf8').toString('base64')
}

/** 反向解析 item.media.aes_key：base64 → hex 字符串 → 原始密钥。 */
export function aesKeyFromBase64(base64Key: string): Buffer {
  return Buffer.from(Buffer.from(base64Key, 'base64').toString('utf8'), 'hex')
}

export function stripQuery(rawUrl: string): string {
  const index = rawUrl.indexOf('?')
  return index >= 0 ? rawUrl.slice(0, index) : rawUrl
}

export function inferContentType(source: string): string {
  return MIME_BY_EXTENSION[extname(stripQuery(source)).toLowerCase()] || 'application/octet-stream'
}

export function classifyMedia(
  contentType: string,
  source: string
): { cdnMediaType: number; itemType: number } {
  const normalized = String(contentType || '').toLowerCase()
  const extension = extname(stripQuery(source)).toLowerCase()
  if (normalized.startsWith('image/') || IMAGE_EXTENSIONS.has(extension)) {
    return { cdnMediaType: ILINK_CDN_MEDIA_TYPE_IMAGE, itemType: ILINK_ITEM_TYPE_IMAGE }
  }
  if (normalized.startsWith('video/') || VIDEO_EXTENSIONS.has(extension)) {
    return { cdnMediaType: ILINK_CDN_MEDIA_TYPE_VIDEO, itemType: ILINK_ITEM_TYPE_VIDEO }
  }
  return { cdnMediaType: ILINK_CDN_MEDIA_TYPE_FILE, itemType: ILINK_ITEM_TYPE_FILE }
}

export interface UploadedMedia {
  downloadParam: string
  aesKeyHex: string
  fileSize: number
  cipherSize: number
}

async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  context: string
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('cdn timeout')), CDN_REQUEST_TIMEOUT_MS)
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new ILinkError({
        kind: 'http',
        message: `${context}失败：HTTP ${response.status} ${excerptBody(body)}`,
        httpStatus: response.status
      })
    }
    return response
  } catch (error) {
    if (error instanceof ILinkError) throw error
    throw new ILinkError({
      kind: 'network',
      message: `${context}失败：${error instanceof Error ? error.message : String(error)}`,
      cause: error
    })
  } finally {
    clearTimeout(timer)
  }
}

/** 加密并上传到微信 CDN，返回 sendmessage 需要的媒体引用。 */
export async function uploadMediaToCdn(
  client: ILinkClient,
  input: {
    data: Buffer
    toUserId: string
    mediaType: number
    fetchImpl?: FetchLike
    signal?: AbortSignal
  }
): Promise<UploadedMedia> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch
  const fileKey = randomBytes(16)
  const aesKey = randomBytes(16)
  const fileKeyHex = fileKey.toString('hex')
  const aesKeyHex = aesKey.toString('hex')
  const rawFileMd5 = createHash('md5').update(input.data).digest('hex')
  const cipherSize = aesEcbPaddedSize(input.data.length)

  const uploadResponse = await client.getUploadUrl(
    {
      filekey: fileKeyHex,
      media_type: input.mediaType,
      to_user_id: input.toUserId,
      rawsize: input.data.length,
      rawfilemd5: rawFileMd5,
      filesize: cipherSize,
      no_need_thumb: true,
      aeskey: aesKeyHex
    },
    input.signal
  )
  assertBusinessOk(uploadResponse, '获取 CDN 上传地址')

  const encrypted = encryptAesEcb(input.data, aesKey)
  const explicitUrl = String(uploadResponse.upload_full_url ?? '').trim()
  const uploadParam = String(uploadResponse.upload_param ?? '').trim()
  if (!explicitUrl && !uploadParam) {
    throw new ILinkError({
      kind: 'protocol',
      message: '服务端未返回可用的 CDN 上传地址'
    })
  }
  const cdnUrl =
    explicitUrl ||
    `${ILINK_CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(fileKeyHex)}`

  const uploadResult = await fetchWithTimeout(
    fetchImpl,
    cdnUrl,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(encrypted)
    },
    'CDN 上传'
  )

  const downloadParam = uploadResult.headers.get('X-Encrypted-Param') ?? ''
  if (!downloadParam) {
    throw new ILinkError({
      kind: 'protocol',
      message: 'CDN 上传成功但缺少 X-Encrypted-Param 响应头'
    })
  }
  return { downloadParam, aesKeyHex, fileSize: input.data.length, cipherSize }
}

async function downloadFromCdn(
  fetchImpl: FetchLike,
  encryptQueryParam: string,
  aesKeyBase64: string
): Promise<Buffer> {
  const url = `${ILINK_CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`
  const response = await fetchWithTimeout(fetchImpl, url, { method: 'GET' }, 'CDN 下载')
  const ciphertext = Buffer.from(await response.arrayBuffer())
  return decryptAesEcb(ciphertext, aesKeyFromBase64(aesKeyBase64))
}

function buildMediaItem(
  itemType: number,
  media: { encrypt_query_param: string; aes_key: string; encrypt_type: number },
  uploaded: UploadedMedia,
  fileName: string
): ILinkMessageItem {
  if (itemType === ILINK_ITEM_TYPE_IMAGE) {
    return { type: ILINK_ITEM_TYPE_IMAGE, image_item: { media, mid_size: uploaded.cipherSize } }
  }
  if (itemType === ILINK_ITEM_TYPE_VIDEO) {
    return { type: ILINK_ITEM_TYPE_VIDEO, video_item: { media, video_size: uploaded.cipherSize } }
  }
  return {
    type: ILINK_ITEM_TYPE_FILE,
    file_item: {
      media,
      file_name: fileName || 'file',
      len: String(uploaded.fileSize)
    }
  }
}

export interface SendMediaOptions {
  to: string
  data: Buffer
  fileName: string
  contentType: string
  source: string
  contextToken?: string
  fetchImpl?: FetchLike
  signal?: AbortSignal
}

/** 上传并发送一条媒体消息。 */
export async function sendMedia(
  client: ILinkClient,
  options: SendMediaOptions
): Promise<{ clientId: string; itemType: number }> {
  const to = String(options.to ?? '').trim()
  if (!to) throw new ILinkError({ kind: 'protocol', message: '发送媒体需要有效的接收者' })

  const { cdnMediaType, itemType } = classifyMedia(options.contentType, options.source)
  const uploaded = await uploadMediaToCdn(client, {
    data: options.data,
    toUserId: to,
    mediaType: cdnMediaType,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.signal ? { signal: options.signal } : {})
  })

  const clientId = createClientId()
  const response = await client.sendMessage(
    buildSendMessageBody({
      item: buildMediaItem(
        itemType,
        {
          encrypt_query_param: uploaded.downloadParam,
          aes_key: aesKeyToBase64(uploaded.aesKeyHex),
          encrypt_type: 1
        },
        uploaded,
        options.fileName
      ),
      to,
      clientId,
      ...(options.contextToken ? { contextToken: options.contextToken } : {})
    }),
    options.signal
  )
  assertBusinessOk(response, '发送媒体')
  return { clientId, itemType }
}

/** 发送本地文件。 */
export async function sendMediaFromPath(
  client: ILinkClient,
  input: {
    to: string
    filePath: string
    contextToken?: string
    fetchImpl?: FetchLike
    signal?: AbortSignal
  }
): Promise<{ clientId: string; itemType: number }> {
  let data: Buffer
  try {
    data = readFileSync(input.filePath)
  } catch (error) {
    throw new ILinkError({
      kind: 'protocol',
      message: `读取媒体文件失败：${error instanceof Error ? error.message : String(error)}`
    })
  }
  return sendMedia(client, {
    to: input.to,
    data,
    fileName: basename(input.filePath),
    contentType: inferContentType(input.filePath),
    source: input.filePath,
    ...(input.contextToken ? { contextToken: input.contextToken } : {}),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    ...(input.signal ? { signal: input.signal } : {})
  })
}

/** 发送远程媒体：下载后走同一条加密上传链路。 */
export async function sendMediaFromUrl(
  client: ILinkClient,
  input: {
    to: string
    mediaUrl: string
    contextToken?: string
    fetchImpl?: FetchLike
    signal?: AbortSignal
  }
): Promise<{ clientId: string; itemType: number }> {
  if (!/^https?:\/\//i.test(input.mediaUrl)) {
    throw new ILinkError({ kind: 'protocol', message: '远程媒体必须是 http(s) 地址' })
  }
  const fetchImpl = input.fetchImpl ?? globalThis.fetch
  const response = await fetchWithTimeout(
    fetchImpl,
    input.mediaUrl,
    { method: 'GET' },
    '下载远程媒体'
  )
  const data = Buffer.from(await response.arrayBuffer())
  const headerType = response.headers.get('content-type') ?? ''
  const name = basename(stripQuery(input.mediaUrl)) || 'file'
  return sendMedia(client, {
    to: input.to,
    data,
    fileName: name,
    contentType: headerType || inferContentType(input.mediaUrl),
    source: input.mediaUrl,
    ...(input.contextToken ? { contextToken: input.contextToken } : {}),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    ...(input.signal ? { signal: input.signal } : {})
  })
}

/** 发送媒体来源（本地路径优先，其次 http(s) URL）。供统一发送入口复用。 */
export async function sendMediaFromSource(
  client: ILinkClient,
  input: {
    to: string
    source: string
    mediaKind: 'image' | 'file'
    contextToken?: string
    fetchImpl?: FetchLike
    signal?: AbortSignal
  }
): Promise<{ clientId: string; itemType: number }> {
  const isLocal = !/^https?:\/\//i.test(input.source)
  if (isLocal) {
    return sendMediaFromPath(client, {
      to: input.to,
      filePath: input.source,
      ...(input.contextToken ? { contextToken: input.contextToken } : {}),
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      ...(input.signal ? { signal: input.signal } : {})
    })
  }
  return sendMediaFromUrl(client, {
    to: input.to,
    mediaUrl: input.source,
    ...(input.contextToken ? { contextToken: input.contextToken } : {}),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    ...(input.signal ? { signal: input.signal } : {})
  })
}

export { downloadFromCdn }
