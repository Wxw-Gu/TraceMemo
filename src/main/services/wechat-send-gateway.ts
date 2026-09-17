import { randomUUID } from 'node:crypto'
import type {
  PersonalWechatSendRequest,
  PersonalWechatSendResult
} from '../../shared/personal-wechat'
import {
  normalizeWechatSendRequest,
  resolveSendTransport,
  type WechatSendErrorCode,
  type WechatSendLogEntry,
  type WechatSendRequest,
  type WechatSendResult,
  type WechatSendTransport
} from '../../shared/wechat-send'
import { isILinkError } from './wechat-ilink/errors'
import { wechatSendLogService, type WechatSendLogService } from './wechat-send-log-service'

/** iLink 发送适配器的注入点；由主进程在启动时接到 WechatConnectorService 上。 */
export type IlinkSendAdapter = (request: WechatSendRequest) => Promise<void>

export interface WechatSendGatewayDependencies {
  now?: () => number
  createRequestId?: () => string
  /** 个人微信（注入式发送）适配器。 */
  sendPersonal?: (request: PersonalWechatSendRequest) => Promise<PersonalWechatSendResult>
  /** iLink 适配器；未注入时 iLink 发送记为 TRANSPORT_UNAVAILABLE。 */
  sendIlink?: IlinkSendAdapter
  log?: WechatSendLogService
}

class UnsupportedSendTypeError extends Error {}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function classifyIlinkError(error: unknown): WechatSendErrorCode {
  if (isILinkError(error) && error.isStaleToken) return 'STALE_TOKEN'
  return 'SEND_FAILED'
}

/**
 * 统一微信发送入口。
 *
 * ```text
 * 业务层
 *   │
 *   ▼
 * WechatSendGateway
 *   ├── Send Log
 *   ├── iLink adapter        → WechatConnectorService
 *   └── Personal adapter     → PersonalWechatSendService（Windows / macOS 注入式）
 * ```
 *
 * 统一的是 TM 上层发送模型，不强行统一底层协议：
 * 个人微信仍然是 `{toWxid,type,msg}` 心智模型，iLink 仍然是 sendmessage。
 */
export class WechatSendGateway {
  private readonly deps: Required<Pick<WechatSendGatewayDependencies, 'now' | 'createRequestId'>> &
    WechatSendGatewayDependencies
  private ilinkAdapter: IlinkSendAdapter | null

  constructor(dependencies: WechatSendGatewayDependencies = {}) {
    this.deps = {
      now: dependencies.now ?? (() => Date.now()),
      createRequestId: dependencies.createRequestId ?? (() => randomUUID()),
      log: dependencies.log ?? wechatSendLogService,
      ...(dependencies.sendPersonal ? { sendPersonal: dependencies.sendPersonal } : {}),
      ...(dependencies.sendIlink ? { sendIlink: dependencies.sendIlink } : {})
    }
    this.ilinkAdapter = dependencies.sendIlink ?? null
  }

  /** 主进程启动时注入 iLink 通道（WechatConnectorService）。 */
  configureIlinkSender(adapter: IlinkSendAdapter): void {
    this.ilinkAdapter = adapter
  }

  hasIlinkSender(): boolean {
    return this.ilinkAdapter !== null
  }

  listSendLog(): WechatSendLogEntry[] {
    return this.deps.log?.list() ?? []
  }

  /**
   * 统一发送入口。
   * 刻意不抛异常：调用方永远拿到结构化结果，失败也会留下 Send Log。
   */
  async send(input: unknown): Promise<WechatSendResult> {
    const startedAt = this.deps.now()
    const fallbackRequestId =
      input &&
      typeof input === 'object' &&
      typeof (input as { request_id?: unknown }).request_id === 'string'
        ? String((input as { request_id: string }).request_id).trim()
        : ''
    const requestId = fallbackRequestId || this.deps.createRequestId()

    const request = normalizeWechatSendRequest(input, { createRequestId: () => requestId })

    if (!request) {
      const raw = (input ?? {}) as Partial<WechatSendRequest>
      const transport = resolveSendTransport({
        ...(raw.transport === 'ilink' || raw.transport === 'personal'
          ? { transport: raw.transport }
          : {}),
        ...(typeof raw.context_token === 'string' ? { context_token: raw.context_token } : {})
      })
      return this.finish({
        requestId,
        transport,
        type: typeof raw.type === 'string' ? (raw.type as WechatSendRequest['type']) : 'text',
        to: typeof raw.to === 'string' ? raw.to : '',
        msg: typeof raw.msg === 'string' ? raw.msg : '',
        startedAt,
        errorCode: 'INVALID_REQUEST',
        error: '发送请求不合法：缺少接收者、类型或内容'
      })
    }

    const transport = resolveSendTransport(request)
    try {
      if (transport === 'ilink') {
        if (!this.ilinkAdapter) {
          return this.finish({
            requestId: request.request_id,
            transport,
            type: request.type,
            to: request.to,
            msg: request.msg,
            startedAt,
            ...(request.account_id ? { accountId: request.account_id } : {}),
            errorCode: 'TRANSPORT_UNAVAILABLE',
            error: 'iLink 发送通道尚未初始化'
          })
        }
        await this.ilinkAdapter(request)
      } else {
        const personalResult = await this.sendPersonalRequest(unifiedToPersonalRequest(request))
        if (!personalResult.success) {
          return this.finish({
            requestId: request.request_id,
            transport,
            type: request.type,
            to: request.to,
            msg: request.msg,
            startedAt,
            ...(request.account_id ? { accountId: request.account_id } : {}),
            errorCode: 'SEND_FAILED',
            error: personalResult.error || '个人微信发送失败'
          })
        }
      }
      return this.finish({
        requestId: request.request_id,
        transport,
        type: request.type,
        to: request.to,
        msg: request.msg,
        startedAt,
        ...(request.account_id ? { accountId: request.account_id } : {}),
        status: 'sent'
      })
    } catch (error) {
      const errorCode: WechatSendErrorCode =
        error instanceof UnsupportedSendTypeError
          ? 'UNSUPPORTED_TYPE'
          : transport === 'ilink'
            ? classifyIlinkError(error)
            : 'SEND_FAILED'
      return this.finish({
        requestId: request.request_id,
        transport,
        type: request.type,
        to: request.to,
        msg: request.msg,
        startedAt,
        ...(request.account_id ? { accountId: request.account_id } : {}),
        errorCode,
        error: errorMessage(error)
      })
    }
  }

  /**
   * 兼容入口：既有个人微信调用方直接给 `PersonalWechatSendRequest`。
   * 走同一条 Send Log，但保持原有返回类型，避免打断现有业务与测试。
   */
  async sendPersonal(request: PersonalWechatSendRequest): Promise<PersonalWechatSendResult> {
    const requestId = this.deps.createRequestId()
    const startedAt = this.deps.now()
    const preview = personalToPreview(request)
    try {
      const result = await this.sendPersonalRequest(request)
      this.record({
        requestId,
        transport: 'personal',
        type: preview.type,
        to: preview.to,
        msg: preview.msg,
        startedAt,
        status: result.success ? 'sent' : 'failed',
        ...(result.success ? {} : { errorCode: 'SEND_FAILED' as WechatSendErrorCode })
      })
      return result
    } catch (error) {
      this.record({
        requestId,
        transport: 'personal',
        type: preview.type,
        to: preview.to,
        msg: preview.msg,
        startedAt,
        status: 'failed',
        errorCode: 'SEND_FAILED'
      })
      throw error
    }
  }

  private async sendPersonalRequest(
    request: PersonalWechatSendRequest
  ): Promise<PersonalWechatSendResult> {
    const sender = this.deps.sendPersonal ?? (await defaultPersonalSender())
    return sender(request)
  }

  private finish(input: {
    requestId: string
    transport: WechatSendTransport
    type: WechatSendRequest['type']
    to: string
    msg: string
    startedAt: number
    accountId?: string
    status?: 'sent' | 'failed' | 'blocked'
    errorCode?: WechatSendErrorCode
    error?: string
  }): WechatSendResult {
    const durationMs = Math.max(0, this.deps.now() - input.startedAt)
    const status = input.status ?? 'failed'
    this.record({
      requestId: input.requestId,
      transport: input.transport,
      type: input.type,
      to: input.to,
      msg: input.msg,
      startedAt: input.startedAt,
      status,
      durationMs,
      ...(input.accountId ? { accountId: input.accountId } : {}),
      ...(input.errorCode ? { errorCode: input.errorCode } : {})
    })
    return {
      request_id: input.requestId,
      success: status === 'sent',
      status,
      transport: input.transport,
      duration_ms: durationMs,
      ...(input.errorCode ? { error_code: input.errorCode } : {}),
      ...(input.error ? { error: input.error } : {})
    }
  }

  private record(input: {
    requestId: string
    transport: WechatSendTransport
    type: WechatSendRequest['type']
    to: string
    msg: string
    startedAt: number
    status: 'sent' | 'failed' | 'blocked'
    durationMs?: number
    accountId?: string
    errorCode?: WechatSendErrorCode
  }): void {
    const log = this.deps.log
    if (!log) return
    try {
      log.record(
        log.buildEntry({
          request_id: input.requestId,
          transport: input.transport,
          to: input.to,
          type: input.type,
          msg: input.msg,
          status: input.status,
          timestamp: this.deps.now(),
          ...(input.durationMs !== undefined ? { duration_ms: input.durationMs } : {}),
          ...(input.accountId ? { account_id: input.accountId } : {}),
          ...(input.errorCode ? { error_code: input.errorCode } : {})
        })
      )
    } catch (error) {
      console.warn('[WechatSendGateway] 发送日志记录失败:', error)
    }
  }
}

/** 统一模型 → 个人微信模型。文件类型个人通道不支持，显式报错而不是静默降级。 */
export function unifiedToPersonalRequest(request: WechatSendRequest): PersonalWechatSendRequest {
  const base = { to: request.to, isGroup: request.is_group === true }
  if (request.type === 'text') {
    return { ...base, type: 'text', text: request.msg }
  }
  if (request.type === 'image') {
    return { ...base, type: 'image', filePath: request.msg }
  }
  if (request.type === 'voice') {
    const metadata = request.metadata ?? {}
    const fromId = typeof metadata.fromId === 'string' ? metadata.fromId.trim() : ''
    const durationMs =
      typeof metadata.durationMs === 'number' && Number.isFinite(metadata.durationMs)
        ? metadata.durationMs
        : undefined
    return {
      ...base,
      type: 'voice',
      filePath: request.msg,
      ...(fromId ? { fromId } : {}),
      ...(durationMs !== undefined ? { durationMs } : {})
    }
  }
  throw new UnsupportedSendTypeError('个人微信通道暂不支持发送文件')
}

function personalToPreview(request: PersonalWechatSendRequest): {
  type: WechatSendRequest['type']
  to: string
  msg: string
} {
  if (request.type === 'text') return { type: 'text', to: request.to, msg: request.text }
  return {
    type: request.type === 'image' ? 'image' : 'voice',
    to: request.to,
    msg: request.filePath
  }
}

let cachedPersonalSender:
  | ((request: PersonalWechatSendRequest) => Promise<PersonalWechatSendResult>)
  | null = null

async function defaultPersonalSender(): Promise<
  (request: PersonalWechatSendRequest) => Promise<PersonalWechatSendResult>
> {
  if (!cachedPersonalSender) {
    const module = await import('./personal-wechat-send-service')
    cachedPersonalSender = (request) => module.personalWechatSendService.send(request)
  }
  return cachedPersonalSender
}

/** 兼容性名称。 */
export const wechatSendGateway = new WechatSendGateway()
