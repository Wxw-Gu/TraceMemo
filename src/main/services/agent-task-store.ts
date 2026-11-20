import fs from 'node:fs/promises'
import path from 'node:path'
import type { AgentTaskRecord, AgentTaskReply } from '../../shared/agent-task'

/**
 * Agent 任务状态持久化。
 *
 * 目的只有一个：**重启后不重复提交**。
 * 因此写入顺序必须是「先落 `submitting`，再发请求」——崩溃发生时磁盘上留下的是
 * 「不确定是否已提交」，而不是一句「没提交过」。
 *
 * 文件为 JSON 数组，权限 0600，位于 `<userData>`；最多保留 `maxRecords` 条最新记录。
 */

const DEFAULT_MAX_RECORDS = 200
const DEFAULT_DEBOUNCE_MS = 200

export interface AgentTaskStoreOptions {
  filePath: string
  maxRecords?: number
  debounceMs?: number
  now?: () => number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function sanitizeRecord(value: unknown): AgentTaskRecord | null {
  if (!isRecord(value)) return null
  const id = typeof value.id === 'string' ? value.id : ''
  const triggerKey = typeof value.triggerKey === 'string' ? value.triggerKey : ''
  const conversationId = typeof value.conversationId === 'string' ? value.conversationId : ''
  const prompt = typeof value.prompt === 'string' ? value.prompt : ''
  const status = typeof value.status === 'string' ? value.status : ''
  if (!id || !triggerKey || !conversationId || !status) return null
  return {
    id,
    provider: typeof value.provider === 'string' ? value.provider : 'workbuddy',
    conversationId,
    triggerKey,
    prompt,
    status: status as AgentTaskRecord['status'],
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : 0,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
    ...(typeof value.submittedAt === 'number' ? { submittedAt: value.submittedAt } : {}),
    ...(typeof value.completedAt === 'number' ? { completedAt: value.completedAt } : {}),
    ...(typeof value.externalMessageId === 'string'
      ? { externalMessageId: value.externalMessageId }
      : {}),
    ...(typeof value.lastReplyId === 'string' ? { lastReplyId: value.lastReplyId } : {}),
    ...(typeof value.errorKind === 'string'
      ? { errorKind: value.errorKind as AgentTaskRecord['errorKind'] }
      : {}),
    ...(typeof value.errorMessage === 'string' ? { errorMessage: value.errorMessage } : {}),
    replies: Array.isArray(value.replies)
      ? value.replies
          .filter(isRecord)
          .map(
            (reply): AgentTaskReply => ({
              messageId: typeof reply.messageId === 'string' ? reply.messageId : '',
              role:
                reply.role === 'assistant' || reply.role === 'user'
                  ? reply.role
                  : ('other' as const),
              text: typeof reply.text === 'string' ? reply.text : '',
              ...(typeof reply.createdAt === 'string' ? { createdAt: reply.createdAt } : {})
            })
          )
          .filter((reply) => Boolean(reply.messageId))
      : []
  }
}

export class AgentTaskStore {
  private readonly records = new Map<string, AgentTaskRecord>()
  private readonly maxRecords: number
  private readonly debounceMs: number
  private readonly now: () => number
  private loaded: Promise<void> | null = null
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private writeChain: Promise<void> = Promise.resolve()

  constructor(private readonly options: AgentTaskStoreOptions) {
    this.maxRecords = Math.max(1, options.maxRecords ?? DEFAULT_MAX_RECORDS)
    this.debounceMs = Math.max(0, options.debounceMs ?? DEFAULT_DEBOUNCE_MS)
    this.now = options.now ?? Date.now
  }

  async load(): Promise<void> {
    if (!this.loaded) this.loaded = this.loadFromDisk()
    return this.loaded
  }

  get(id: string): AgentTaskRecord | undefined {
    const record = this.records.get(id)
    return record ? { ...record, replies: [...record.replies] } : undefined
  }

  findByTrigger(triggerKey: string): AgentTaskRecord | undefined {
    for (const record of this.records.values()) {
      if (record.triggerKey === triggerKey) return { ...record, replies: [...record.replies] }
    }
    return undefined
  }

  list(limit = 50): AgentTaskRecord[] {
    return Array.from(this.records.values())
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, Math.max(1, Math.min(limit, this.maxRecords)))
      .map((record) => ({ ...record, replies: [...record.replies] }))
  }

  upsert(record: AgentTaskRecord): void {
    this.records.set(record.id, { ...record, replies: [...record.replies] })
    this.trim()
    this.schedulePersist()
  }

  /** 强制写盘（测试与退出前调用）。 */
  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    const snapshot = JSON.stringify(this.list(this.maxRecords), null, 2)
    this.writeChain = this.writeChain.then(() => this.writeSnapshot(snapshot))
    await this.writeChain
  }

  private async loadFromDisk(): Promise<void> {
    let raw = ''
    try {
      raw = await fs.readFile(this.options.filePath, 'utf8')
    } catch {
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }
    if (!Array.isArray(parsed)) return

    for (const item of parsed) {
      const record = sanitizeRecord(item)
      if (!record) continue
      /*
       * 恢复语义：`submitting` 表示「请求可能已经发出，但进程没等到响应」。
       * 这种情况绝不能重投，也不能谎称失败在本地 —— 标记为不可重试的
       * `ambiguous_submission`，让人工/后续阶段决定。
       */
      if (record.status === 'submitting') {
        record.status = 'failed'
        record.errorKind = 'ambiguous_submission'
        record.errorMessage = '进程在投递过程中退出，无法确认远端是否已接收；不会自动重试'
        record.updatedAt = this.now()
      } else if (record.status === 'queued') {
        record.status = 'failed'
        record.errorKind = 'internal'
        record.errorMessage = '进程在投递前退出，未发送'
        record.updatedAt = this.now()
      }
      this.records.set(record.id, record)
    }
    this.trim()
  }

  private trim(): void {
    if (this.records.size <= this.maxRecords) return
    const ordered = Array.from(this.records.values()).sort((a, b) => a.createdAt - b.createdAt)
    const overflow = this.records.size - this.maxRecords
    for (let index = 0; index < overflow; index += 1) {
      this.records.delete(ordered[index].id)
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      const snapshot = JSON.stringify(this.list(this.maxRecords), null, 2)
      this.writeChain = this.writeChain.then(() => this.writeSnapshot(snapshot))
    }, this.debounceMs)
    this.persistTimer.unref?.()
  }

  private async writeSnapshot(snapshot: string): Promise<void> {
    const target = this.options.filePath
    const temp = `${target}.tmp`
    try {
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(temp, snapshot, { encoding: 'utf8', mode: 0o600 })
      await fs.rename(temp, target)
      await fs.chmod(target, 0o600).catch(() => undefined)
    } catch (error) {
      console.warn(
        `[AgentTaskStore] persist failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
}
