import { chmodSync, mkdirSync, renameSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { WechatInboundItem, WechatInboundMessage } from './wechat-ilink/types'

/**
 * Agent Hub 入站收件箱。
 *
 * 存在意义只有一个：**拿到消息就立刻落盘，然后才允许长轮询推进游标**。
 * 先推进游标再异步投递的话，进程在两步之间崩溃就会静默丢消息；
 * 因此这里的语义是 at-least-once：允许重复，不允许丢失。
 *
 * 代价：极端情况下（处理完但删除前崩溃）会重复处理同一条消息。
 * Agent Hub 有 message_id 去重 + 业务侧幂等，重复可以接受，丢消息不行。
 *
 * 文件含聊天文本与 context_token，因此固定 0600 权限、处理完即删除，且从不写入日志。
 */

export interface WechatInboundInboxEntry {
  key: string
  accountId: string
  fromUserId: string
  messageId: string
  contextToken?: string
  items: WechatInboundItem[]
  receivedAt: number
  attempts: number
}

interface InboxFile {
  entries: WechatInboundInboxEntry[]
}

export interface WechatInboundInboxOptions {
  filePath: () => string
  maxAttempts?: number
  maxEntries?: number
  now?: () => number
}

const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_MAX_ENTRIES = 200

export function inboxKeyFor(
  message: WechatInboundMessage,
  fallbackIndex: number,
  now: number
): string {
  if (message.messageId) return `${message.accountId}::${message.messageId}`
  return `${message.accountId}::${message.fromUserId}::${now}::${fallbackIndex}`
}

export class WechatInboundInbox {
  private readonly options: WechatInboundInboxOptions
  private readonly maxAttempts: number
  private readonly maxEntries: number
  private entries: WechatInboundInboxEntry[] | null = null

  constructor(options: WechatInboundInboxOptions) {
    this.options = options
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  }

  /**
   * 持久化接收一批消息，返回**本次新增**的条目。
   * 已存在（重复投递）的条目不会重复返回，也不会重复处理。
   */
  accept(messages: WechatInboundMessage[]): WechatInboundInboxEntry[] {
    const current = this.load()
    const known = new Set(current.map((entry) => entry.key))
    const accepted: WechatInboundInboxEntry[] = []
    const now = this.options.now?.() ?? Date.now()

    messages.forEach((message, index) => {
      const key = inboxKeyFor(message, index, now)
      if (known.has(key)) return
      known.add(key)
      accepted.push({
        key,
        accountId: message.accountId,
        fromUserId: message.fromUserId,
        messageId: message.messageId,
        ...(message.contextToken ? { contextToken: message.contextToken } : {}),
        items: message.items.map((item) => ({ ...item })),
        receivedAt: message.receivedAt || now,
        attempts: 0
      })
    })

    if (accepted.length === 0) return []
    const next = [...current, ...accepted].slice(-this.maxEntries)
    this.persist(next)
    this.entries = next
    return accepted
  }

  /** 尚未处理完成的条目，按接收顺序返回。 */
  pending(): WechatInboundInboxEntry[] {
    return this.load().map((entry) => ({ ...entry }))
  }

  contains(key: string): boolean {
    return this.load().some((entry) => entry.key === key)
  }

  size(): number {
    return this.load().length
  }

  /** 处理成功，从收件箱移除。 */
  complete(key: string): void {
    const current = this.load()
    const next = current.filter((entry) => entry.key !== key)
    if (next.length === current.length) return
    this.persist(next)
    this.entries = next
  }

  /**
   * 处理失败：累加尝试次数。
   * 达到上限后放弃，返回 abandoned=true，由调用方明确记一条 error 日志——
   * 静默丢弃是不允许的，但无限重试同一条毒消息同样不允许。
   */
  recordFailure(key: string): { attempts: number; abandoned: boolean } {
    const current = this.load()
    let attempts = 0
    let abandoned = false
    const next = current
      .map((entry) => {
        if (entry.key !== key) return entry
        attempts = entry.attempts + 1
        abandoned = attempts >= this.maxAttempts
        return { ...entry, attempts }
      })
      .filter((entry) => !(entry.key === key && abandoned))
    this.persist(next)
    this.entries = next
    return { attempts, abandoned }
  }

  clear(): void {
    this.persist([])
    this.entries = []
  }

  private load(): WechatInboundInboxEntry[] {
    if (this.entries) return this.entries
    let parsed: InboxFile | null = null
    try {
      parsed = JSON.parse(readFileSync(this.options.filePath(), 'utf8')) as InboxFile
    } catch {
      parsed = null
    }
    const entries = Array.isArray(parsed?.entries)
      ? parsed!.entries.filter((entry): entry is WechatInboundInboxEntry => {
          if (!entry || typeof entry !== 'object') return false
          const candidate = entry as Partial<WechatInboundInboxEntry>
          return Boolean(
            String(candidate.key || '').trim() && String(candidate.fromUserId || '').trim()
          )
        })
      : []
    this.entries = entries
    return entries
  }

  private persist(entries: WechatInboundInboxEntry[]): void {
    const path = this.options.filePath()
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`
      writeFileSync(tempPath, JSON.stringify({ entries } satisfies InboxFile, null, 2), {
        encoding: 'utf8',
        mode: 0o600
      })
      chmodSync(tempPath, 0o600)
      renameSync(tempPath, path)
      chmodSync(path, 0o600)
    } catch (error) {
      // 落盘失败必须向上抛：调用方要放弃推进游标，让服务端重新投递。
      try {
        rmSync(`${path}.tmp-${process.pid}`, { force: true })
      } catch {
        // 忽略临时文件清理失败。
      }
      throw error
    }
  }
}
