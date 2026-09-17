import { app } from 'electron'
import { createHash } from 'node:crypto'
import fs from 'fs-extra'
import path from 'path'
import {
  buildSendPreview,
  type WechatSendLogEntry,
  type WechatSendStatus,
  type WechatSendTransport,
  type WechatSendType
} from '../../shared/wechat-send'

const MAX_LOG_ENTRIES = 500

/**
 * 只允许白名单字段落盘。
 * 即使调用方不小心把 context_token / bot_token 之类的字段混进条目，
 * 也绝不会被写进 Send Log——隐私边界放在这里兜底，而不是依赖调用方自觉。
 */
function sanitizeEntry(entry: WechatSendLogEntry): WechatSendLogEntry {
  return {
    request_id: String(entry.request_id ?? ''),
    timestamp: Number(entry.timestamp) || 0,
    transport: entry.transport,
    to: String(entry.to ?? ''),
    type: entry.type,
    status: entry.status,
    ...(entry.msg_preview ? { msg_preview: entry.msg_preview } : {}),
    ...(entry.msg_hash ? { msg_hash: entry.msg_hash } : {}),
    ...(entry.account_id ? { account_id: entry.account_id } : {}),
    ...(entry.duration_ms !== undefined ? { duration_ms: entry.duration_ms } : {}),
    ...(entry.error_code ? { error_code: entry.error_code } : {})
  }
}

export interface WechatSendLogServiceOptions {
  getUserDataPath?: () => string
  maxEntries?: number
}

/**
 * 发送日志（Send Log）。
 *
 * 与 WechatActionGateway 的 Action 审计刻意分成两层：
 * - Send Log：**每一次**经过 WechatSendGateway 的发送都记录，包括普通 Agent 问答回复；
 * - Action 审计：只记录需要业务审计的高层动作（定时日报、退群通知、用户主动 TTS）。
 *
 * 记录内容：request_id / 时间 / transport / 目标 / 类型 / 截断预览 / sha256 / 状态 / 耗时。
 * **不记录**：context_token、bot_token、完整聊天文本、完整本地路径、Authorization 头。
 */
export class WechatSendLogService {
  private readonly getUserDataPath: () => string
  private readonly maxEntries: number

  constructor(options: WechatSendLogServiceOptions = {}) {
    this.getUserDataPath = options.getUserDataPath || (() => app.getPath('userData'))
    this.maxEntries = options.maxEntries ?? MAX_LOG_ENTRIES
  }

  /** 对消息原文计算稳定哈希；不做任何截断，用于后续比对是否同一条内容。 */
  hashMessage(msg: string): string {
    return `sha256:${createHash('sha256')
      .update(String(msg ?? ''))
      .digest('hex')}`
  }

  /** 组装一条日志条目；预览会自动截断，媒体只保留文件名。 */
  buildEntry(input: {
    request_id: string
    transport: WechatSendTransport
    to: string
    type: WechatSendType
    msg: string
    status: WechatSendStatus
    timestamp: number
    duration_ms?: number
    account_id?: string
    error_code?: WechatSendLogEntry['error_code']
  }): WechatSendLogEntry {
    const preview = buildSendPreview(input.msg, input.type)
    return {
      request_id: input.request_id,
      timestamp: input.timestamp,
      transport: input.transport,
      to: input.to,
      type: input.type,
      status: input.status,
      ...(preview ? { msg_preview: preview } : {}),
      msg_hash: this.hashMessage(input.msg),
      ...(input.account_id ? { account_id: input.account_id } : {}),
      ...(input.duration_ms !== undefined ? { duration_ms: input.duration_ms } : {}),
      ...(input.error_code ? { error_code: input.error_code } : {})
    }
  }

  list(): WechatSendLogEntry[] {
    return this.readAll().map((entry) => ({ ...entry }))
  }

  record(entry: WechatSendLogEntry): void {
    const records = this.readAll()
    const sanitized = sanitizeEntry(entry)
    const withoutSameRequest = records.filter((item) => item.request_id !== sanitized.request_id)
    const next = [sanitized, ...withoutSameRequest].slice(0, this.maxEntries)
    try {
      fs.ensureDirSync(path.dirname(this.filePath()))
      fs.writeJsonSync(this.filePath(), next, { spaces: 2 })
    } catch (error) {
      // 发送日志写失败不能影响真实发送结果。
      console.warn('[WechatSendLog] 发送日志写入失败:', error)
    }
  }

  clear(): void {
    try {
      fs.writeJsonSync(this.filePath(), [], { spaces: 2 })
    } catch {
      // 忽略：清空失败不影响后续发送。
    }
  }

  private filePath(): string {
    return path.join(this.getUserDataPath(), 'actions', 'wechat-send-log.json')
  }

  private readAll(): WechatSendLogEntry[] {
    try {
      const value = fs.readJsonSync(this.filePath()) as unknown
      if (!Array.isArray(value)) return []
      return value.filter((item): item is WechatSendLogEntry => {
        if (!item || typeof item !== 'object') return false
        const record = item as Partial<WechatSendLogEntry>
        // `to` 允许为空：非法请求同样要留痕，此时没有可用的接收者。
        return Boolean(
          String(record.request_id || '').trim() &&
          String(record.type || '').trim() &&
          String(record.status || '').trim() &&
          Number.isFinite(Number(record.timestamp))
        )
      })
    } catch {
      return []
    }
  }
}

export const wechatSendLogService = new WechatSendLogService()
