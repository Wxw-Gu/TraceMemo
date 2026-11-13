import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ExtensionError } from '../../shared/extensions/errors'
import {
  hasExtensionPermission,
  type ExtensionPermission
} from '../../shared/extensions/permissions'
import type {
  ExtensionSendImageRequest,
  ExtensionSendTextRequest,
  ExtensionSendTextResult,
  ExtensionSendVideoRequest
} from '../../shared/extensions/rpc'
import type { PersonalWechatSendCapability } from '../../shared/personal-wechat'
import type { WechatActionRequest, WechatActionResult } from '../../shared/wechat-action'
import type { ExtensionEntitlementResult } from './extension-entitlement'
import { isPathInside } from './extension-paths'

const MAX_TEXT_LENGTH = 2_000
const MAX_RECIPIENT_LENGTH = 128
const MAX_MEDIA_BYTES = 100 * 1024 * 1024
const SEND_INTERVAL_MS = 2_000
const SEND_WINDOW_MS = 60_000
const SEND_WINDOW_LIMIT = 10
/** 原生发送端把视频按 `type: 'video'` 提交，这里只放行常见容器。 */
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'])
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v'])

export interface ExtensionSendContext {
  extensionId: string
  permissions: ExtensionPermission[]
  /** manifest 声明的会话范围；空数组表示不限制。 */
  conversationScope: string[]
}

export interface ExtensionSendGatewayDependencies {
  getCapability: () => Promise<PersonalWechatSendCapability>
  checkEntitlement: () => Promise<ExtensionEntitlementResult>
  executeAction: (request: WechatActionRequest) => Promise<WechatActionResult>
  /** 扩展数据目录；媒体文件只允许从这里或系统临时目录发送。 */
  getExtensionDataRoot?: (extensionId: string) => string
  now?: () => number
}

/**
 * 扩展发送出口：权限 / 范围 / 授权 / 频率通过后交给 WechatActionGateway。
 *
 * origin、purpose、triggerType、幂等键全部由宿主填写，扩展只描述
 * 「发给谁、发什么」。
 */
export class ExtensionSendGateway {
  private readonly getCapability: () => Promise<PersonalWechatSendCapability>
  private readonly checkEntitlement: () => Promise<ExtensionEntitlementResult>
  private readonly executeAction: (request: WechatActionRequest) => Promise<WechatActionResult>
  private readonly getExtensionDataRoot: (extensionId: string) => string
  private readonly now: () => number
  private readonly sendHistory = new Map<string, number[]>()

  constructor(dependencies: ExtensionSendGatewayDependencies) {
    this.getCapability = dependencies.getCapability
    this.checkEntitlement = dependencies.checkEntitlement
    this.executeAction = dependencies.executeAction
    this.getExtensionDataRoot = dependencies.getExtensionDataRoot ?? (() => '')
    this.now = dependencies.now ?? (() => Date.now())
  }

  async sendText(
    context: ExtensionSendContext,
    request: ExtensionSendTextRequest
  ): Promise<ExtensionSendTextResult> {
    if (!hasExtensionPermission(context.permissions, 'wechat.send.text')) {
      throw new ExtensionError('PERMISSION_DENIED', '扩展没有 wechat.send.text 权限')
    }
    const to = String(request?.to || '').trim()
    const text = String(request?.text || '').trim()
    if (!to || to.length > MAX_RECIPIENT_LENGTH) {
      throw new ExtensionError('INVALID_REQUEST', '接收会话 id 不合法')
    }
    if (!text || text.length > MAX_TEXT_LENGTH) {
      throw new ExtensionError('INVALID_REQUEST', '发送内容不能为空且不能超过 2000 字')
    }
    if (context.conversationScope.length > 0 && !context.conversationScope.includes(to)) {
      throw new ExtensionError('PERMISSION_DENIED', '目标会话超出扩展声明的范围')
    }
    const at = normalizeAt(request?.at, to)
    this.assertRateLimit(context.extensionId)

    const capability = await this.getCapability().catch(() => null)
    if (!capability || !capability.supported) {
      throw new ExtensionError(
        'SEND_NOT_SUPPORTED',
        capability?.message || '当前环境不支持微信发送'
      )
    }
    if (!capability.ready || !capability.capabilities?.text) {
      throw new ExtensionError(
        'CAPABILITY_UNAVAILABLE',
        capability.message || '个人微信发送能力尚未就绪'
      )
    }

    const entitlement = await this.checkEntitlement()
    if (!entitlement.ok) {
      throw new ExtensionError('LICENSE_REQUIRED', entitlement.message)
    }

    const result = await this.executeAction({
      ...(request.dedupeKey
        ? { idempotencyKey: extensionIdempotencyKey(context.extensionId, request.dedupeKey) }
        : {}),
      origin: 'extension',
      purpose: 'extension_send',
      triggerType: 'automation',
      recipient: { type: to.endsWith('@chatroom') ? 'group' : 'contact', id: to },
      content: { type: 'text', text, ...(at ? { at } : {}) },
      metadata: { extensionId: context.extensionId }
    })

    if (result.status === 'sent') {
      return { actionId: result.actionId, status: 'sent' }
    }
    throw new ExtensionError(mapGatewayError(result.errorCode), result.reason || '微信发送失败')
  }

  /**
   * 发送图片。
   *
   * 文件边界是硬性的：只允许扩展数据目录或系统临时目录里的普通文件，
   * 否则扩展就能借 TraceMemo 把本机任意文件发出去。
   */
  async sendImage(
    context: ExtensionSendContext,
    request: ExtensionSendImageRequest
  ): Promise<ExtensionSendTextResult> {
    if (!hasExtensionPermission(context.permissions, 'wechat.send.image')) {
      throw new ExtensionError('PERMISSION_DENIED', '扩展没有 wechat.send.image 权限')
    }
    const to = String(request?.to || '').trim()
    if (!to || to.length > MAX_RECIPIENT_LENGTH) {
      throw new ExtensionError('INVALID_REQUEST', '接收会话 id 不合法')
    }
    if (context.conversationScope.length > 0 && !context.conversationScope.includes(to)) {
      throw new ExtensionError('PERMISSION_DENIED', '目标会话超出扩展声明的范围')
    }
    const mediaPath = assertSendableMediaPath(
      request?.path,
      this.getExtensionDataRoot(context.extensionId),
      IMAGE_EXTENSIONS
    )
    this.assertRateLimit(context.extensionId)

    const capability = await this.getCapability().catch(() => null)
    if (!capability || !capability.supported) {
      throw new ExtensionError(
        'SEND_NOT_SUPPORTED',
        capability?.message || '当前环境不支持微信发送'
      )
    }
    if (!capability.ready || !capability.capabilities?.image) {
      throw new ExtensionError(
        'CAPABILITY_UNAVAILABLE',
        capability.message || '个人微信发送能力尚未就绪'
      )
    }

    const entitlement = await this.checkEntitlement()
    if (!entitlement.ok) {
      throw new ExtensionError('LICENSE_REQUIRED', entitlement.message)
    }

    const result = await this.executeAction({
      ...(request.dedupeKey
        ? { idempotencyKey: extensionIdempotencyKey(context.extensionId, request.dedupeKey) }
        : {}),
      origin: 'extension',
      purpose: 'extension_send',
      triggerType: 'automation',
      recipient: { type: to.endsWith('@chatroom') ? 'group' : 'contact', id: to },
      content: { type: 'image', path: mediaPath },
      metadata: { extensionId: context.extensionId }
    })

    if (result.status === 'sent') {
      return { actionId: result.actionId, status: 'sent' }
    }
    throw new ExtensionError(mapGatewayError(result.errorCode), result.reason || '微信发送失败')
  }

  /**
   * 发送视频。
   *
   * 与图片分开是刻意的：原生 Host 用 `type: 'video'` 提交，失败时不能悄悄降级成图片。
   * 文件边界与图片相同（扩展数据目录 / 临时目录、普通文件、≤ 100MB）。
   */
  async sendVideo(
    context: ExtensionSendContext,
    request: ExtensionSendVideoRequest
  ): Promise<ExtensionSendTextResult> {
    if (!hasExtensionPermission(context.permissions, 'wechat.send.video')) {
      throw new ExtensionError('PERMISSION_DENIED', '扩展没有 wechat.send.video 权限')
    }
    const to = String(request?.to || '').trim()
    if (!to || to.length > MAX_RECIPIENT_LENGTH) {
      throw new ExtensionError('INVALID_REQUEST', '接收会话 id 不合法')
    }
    if (context.conversationScope.length > 0 && !context.conversationScope.includes(to)) {
      throw new ExtensionError('PERMISSION_DENIED', '目标会话超出扩展声明的范围')
    }
    const mediaPath = assertSendableMediaPath(
      request?.path,
      this.getExtensionDataRoot(context.extensionId),
      VIDEO_EXTENSIONS
    )
    this.assertRateLimit(context.extensionId)

    const capability = await this.getCapability().catch(() => null)
    if (!capability || !capability.supported) {
      throw new ExtensionError(
        'SEND_NOT_SUPPORTED',
        capability?.message || '当前环境不支持微信发送'
      )
    }
    if (!capability.ready || !capability.capabilities?.video) {
      throw new ExtensionError(
        'CAPABILITY_UNAVAILABLE',
        capability.message || '当前微信发送能力不支持视频'
      )
    }

    const entitlement = await this.checkEntitlement()
    if (!entitlement.ok) {
      throw new ExtensionError('LICENSE_REQUIRED', entitlement.message)
    }

    const result = await this.executeAction({
      ...(request.dedupeKey
        ? { idempotencyKey: extensionIdempotencyKey(context.extensionId, request.dedupeKey) }
        : {}),
      origin: 'extension',
      purpose: 'extension_send',
      triggerType: 'automation',
      recipient: { type: to.endsWith('@chatroom') ? 'group' : 'contact', id: to },
      content: { type: 'video', path: mediaPath },
      metadata: { extensionId: context.extensionId }
    })

    if (result.status === 'sent') {
      return { actionId: result.actionId, status: 'sent' }
    }
    throw new ExtensionError(mapGatewayError(result.errorCode), result.reason || '微信发送失败')
  }

  /** 令牌窗口：同一扩展 60 秒内最多 10 条，且两条之间至少 2 秒。 */
  private assertRateLimit(extensionId: string): void {
    const now = this.now()
    const history = (this.sendHistory.get(extensionId) ?? []).filter(
      (timestamp) => now - timestamp < SEND_WINDOW_MS
    )
    const last = history[history.length - 1]
    if (last !== undefined && now - last < SEND_INTERVAL_MS) {
      throw new ExtensionError('RATE_LIMITED', '发送过于频繁，请稍后再试')
    }
    if (history.length >= SEND_WINDOW_LIMIT) {
      throw new ExtensionError('RATE_LIMITED', '已达到每分钟发送上限')
    }
    history.push(now)
    this.sendHistory.set(extensionId, history)
  }
}

/**
 * 媒体路径校验：必须是扩展数据目录或系统临时目录内的普通文件。
 *
 * 用 realpath 复核，符号链接跳到目录外同样会被拒绝；这一层不能省，
 * 否则 `wechat.send.image` 就等价于「读取并外发任意本机文件」。
 */
function assertSendableMediaPath(value: unknown, dataRoot: string, allowed: Set<string>): string {
  const raw = String(value ?? '').trim()
  if (!raw || raw.length > 4_096) {
    throw new ExtensionError('INVALID_REQUEST', '媒体路径不合法')
  }
  if (!path.isAbsolute(raw)) {
    throw new ExtensionError('INVALID_REQUEST', '媒体路径必须是绝对路径')
  }
  let realPath: string
  try {
    realPath = fs.realpathSync(raw)
  } catch {
    throw new ExtensionError('INVALID_REQUEST', '媒体文件不存在')
  }
  const stat = fs.statSync(realPath)
  if (!stat.isFile()) {
    throw new ExtensionError('INVALID_REQUEST', '媒体路径必须是普通文件')
  }
  if (stat.size <= 0 || stat.size > MAX_MEDIA_BYTES) {
    throw new ExtensionError('INVALID_REQUEST', '媒体文件为空或超过 100MB')
  }
  const extension = path.extname(realPath).toLowerCase()
  if (!allowed.has(extension)) {
    throw new ExtensionError('SEND_NOT_SUPPORTED', `不支持发送 ${extension || '无扩展名'} 文件`)
  }
  const roots = [dataRoot, os.tmpdir()]
    .filter(Boolean)
    .map((root) => {
      try {
        return fs.realpathSync(root)
      } catch {
        return ''
      }
    })
    .filter(Boolean)
  if (!roots.some((root) => isPathInside(root, realPath))) {
    throw new ExtensionError('PERMISSION_DENIED', '只能发送扩展数据目录或临时目录中的文件')
  }
  return realPath
}

function normalizeAt(value: unknown, recipientId: string): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  if (!recipientId.endsWith('@chatroom')) return undefined
  const entries = Object.entries(value as Record<string, unknown>)
  if (!entries.length || entries.length > 50) return undefined
  const result: Record<string, string> = {}
  for (const [wxid, name] of entries) {
    const key = String(wxid).trim()
    if (!key || typeof name !== 'string' || !name.trim()) continue
    result[key] = name.trim()
  }
  return Object.keys(result).length ? result : undefined
}

/** 扩展提供的去重键只作为后缀，前缀固定，避免与官方自动化幂等键串台。 */
export function extensionIdempotencyKey(extensionId: string, dedupeKey: string): string {
  const digest = createHash('sha1')
    .update(`${extensionId}\u0001${String(dedupeKey).trim()}`)
    .digest('hex')
  return `extension:${extensionId}:${digest}`
}

function mapGatewayError(
  code: string | undefined
): 'CAPABILITY_UNAVAILABLE' | 'PERMISSION_DENIED' | 'ACTION_FAILED' | 'INVALID_REQUEST' {
  switch (code) {
    case 'SEND_CAPABILITY_UNAVAILABLE':
    case 'SEND_NOT_READY':
      return 'CAPABILITY_UNAVAILABLE'
    case 'ACTION_NOT_ALLOWED':
    case 'RECIPIENT_SCOPE_VIOLATION':
      return 'PERMISSION_DENIED'
    case 'INVALID_REQUEST':
    case 'INVALID_RECIPIENT':
      return 'INVALID_REQUEST'
    default:
      return 'ACTION_FAILED'
  }
}
