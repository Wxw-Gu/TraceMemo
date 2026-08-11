import { app, shell } from 'electron'
import fs from 'fs-extra'
import path from 'path'
import type { AppLogEntry } from '../shared/app-log'
import { isPackagedRuntime } from './runtime-mode'

const MAX_LOG_BYTES = 5 * 1024 * 1024
const REDACTED_KEY = /(?:api[-_]?key|authorization|token|secret|password|database[-_]?key)/i

const sanitize = (value: unknown, depth = 0): unknown => {
  if (depth > 4) return '[depth-limited]'
  if (typeof value === 'string') {
    return value
      .replace(/\bsk-[a-z0-9_-]{8,}\b/gi, '***')
      .replace(/\bBearer\s+[a-z0-9._~-]{8,}\b/gi, 'Bearer ***')
      .replace(/\b(?:0x)?[a-f0-9]{64}\b/gi, '***')
      .slice(0, 2000)
  }
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => sanitize(item, depth + 1))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        REDACTED_KEY.test(key) ? '***' : sanitize(item, depth + 1)
      ])
    )
  }
  return value
}

export class AppLogger {
  private get logDir(): string {
    return app.getPath('logs')
  }

  get logPath(): string {
    return path.join(this.logDir, 'tracememo.log')
  }

  private rotateIfNeeded(): void {
    try {
      if (!fs.existsSync(this.logPath) || fs.statSync(this.logPath).size < MAX_LOG_BYTES) return
      const previous = `${this.logPath}.1`
      if (fs.existsSync(previous)) fs.removeSync(previous)
      fs.moveSync(this.logPath, previous)
    } catch {
      // Logging must never interrupt the application.
    }
  }

  write(entry: AppLogEntry): void {
    try {
      fs.ensureDirSync(this.logDir)
      this.rotateIfNeeded()
      const record = {
        timestamp: new Date().toISOString(),
        mode: isPackagedRuntime() ? 'packaged' : 'development',
        level: entry.level,
        scope: String(entry.scope || 'app').slice(0, 80),
        message: String(sanitize(entry.message || '')).slice(0, 500),
        details: sanitize(entry.details || {})
      }
      fs.appendFileSync(this.logPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8' })
      if (!isPackagedRuntime()) {
        const method =
          entry.level === 'error'
            ? console.error
            : entry.level === 'warn'
              ? console.warn
              : console.log
        method(`[${record.scope}] ${record.message}`, record.details)
      }
    } catch {
      // Logging must never interrupt the application.
    }
  }

  reveal(): void {
    fs.ensureDirSync(this.logDir)
    if (!fs.existsSync(this.logPath)) fs.writeFileSync(this.logPath, '', 'utf8')
    shell.showItemInFolder(this.logPath)
  }
}

export const appLogger = new AppLogger()
