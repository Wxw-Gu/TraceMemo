import fs from 'fs-extra'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ExtensionLogEntry } from '../../shared/extensions/types'

const MAX_ENTRIES_PER_EXTENSION = 200
const MAX_MESSAGE_LENGTH = 500
const MAX_FILE_BYTES = 256 * 1024

/**
 * 扩展日志：内存环形缓冲 + 磁盘 JSONL（超过上限时轮转一份 `.1`）。
 *
 * 隐私边界：宿主只记录**生命周期与错误摘要**，不写聊天正文。
 * 扩展主动写入的内容会原样落盘并展示给用户，作者必须自己遵守隐私约定。
 */
export class ExtensionLogStore {
  private readonly logsDir: string
  private readonly memory = new Map<string, ExtensionLogEntry[]>()
  private readonly loaded = new Set<string>()

  constructor(logsDir: string) {
    this.logsDir = logsDir
  }

  append(
    extensionId: string,
    level: ExtensionLogEntry['level'],
    source: ExtensionLogEntry['source'],
    message: string
  ): ExtensionLogEntry {
    this.ensureLoaded(extensionId)
    const entry: ExtensionLogEntry = {
      id: randomUUID(),
      at: Date.now(),
      level,
      source,
      message: sanitizeMessage(message)
    }
    const list = this.memory.get(extensionId) ?? []
    list.push(entry)
    if (list.length > MAX_ENTRIES_PER_EXTENSION)
      list.splice(0, list.length - MAX_ENTRIES_PER_EXTENSION)
    this.memory.set(extensionId, list)
    this.appendToDisk(extensionId, entry)
    return entry
  }

  list(extensionId: string, limit = MAX_ENTRIES_PER_EXTENSION): ExtensionLogEntry[] {
    this.ensureLoaded(extensionId)
    const list = this.memory.get(extensionId) ?? []
    return list.slice(-Math.max(1, Math.min(limit, MAX_ENTRIES_PER_EXTENSION))).reverse()
  }

  clear(extensionId: string): void {
    this.memory.set(extensionId, [])
    this.loaded.add(extensionId)
    fs.removeSync(this.filePath(extensionId))
    fs.removeSync(`${this.filePath(extensionId)}.1`)
  }

  remove(extensionId: string): void {
    this.memory.delete(extensionId)
    this.loaded.delete(extensionId)
    fs.removeSync(this.filePath(extensionId))
    fs.removeSync(`${this.filePath(extensionId)}.1`)
  }

  private filePath(extensionId: string): string {
    return path.join(this.logsDir, `${extensionId}.jsonl`)
  }

  private ensureLoaded(extensionId: string): void {
    if (this.loaded.has(extensionId)) return
    this.loaded.add(extensionId)
    try {
      const text = fs.readFileSync(this.filePath(extensionId), 'utf8')
      const lines = text.split('\n').filter(Boolean).slice(-MAX_ENTRIES_PER_EXTENSION)
      const entries: ExtensionLogEntry[] = []
      for (const line of lines) {
        try {
          const raw = JSON.parse(line) as Partial<ExtensionLogEntry>
          if (!raw || typeof raw !== 'object') continue
          if (typeof raw.message !== 'string') continue
          entries.push({
            id: String(raw.id || randomUUID()),
            at: Number(raw.at) || 0,
            level: raw.level === 'warn' || raw.level === 'error' ? raw.level : 'info',
            source: raw.source === 'extension' ? 'extension' : 'core',
            message: sanitizeMessage(raw.message)
          })
        } catch {
          // 单行损坏不影响其余日志。
        }
      }
      this.memory.set(extensionId, entries)
    } catch {
      this.memory.set(extensionId, [])
    }
  }

  private appendToDisk(extensionId: string, entry: ExtensionLogEntry): void {
    try {
      const filePath = this.filePath(extensionId)
      fs.ensureDirSync(path.dirname(filePath))
      const size = fs.statSync(filePath, { throwIfNoEntry: false })?.size ?? 0
      if (size > MAX_FILE_BYTES) fs.moveSync(filePath, `${filePath}.1`, { overwrite: true })
      fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf8')
    } catch {
      // 日志写不进去不能影响扩展运行。
    }
  }
}

// eslint-disable-next-line no-control-regex -- 终端 ANSI 序列与控制字符要在落盘前剥掉
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g
// eslint-disable-next-line no-control-regex -- 同上：日志里不允许出现不可见控制字符
const CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g

function sanitizeMessage(value: unknown): string {
  const text = String(value ?? '')
    .replace(ANSI_PATTERN, '')
    .replace(CONTROL_PATTERN, '')
    .trim()
  return text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH)}…` : text
}
