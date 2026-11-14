import { app, safeStorage } from 'electron'
import fs from 'fs-extra'
import path from 'path'
import crypto from 'crypto'
import type { DatabaseKeyStorageResult } from '../shared/database-key'

const normalizeDatabaseKey = (value: string): string => value.trim().replace(/^0x/i, '')

export const isValidDatabaseKey = (value: string): boolean =>
  /^[0-9a-f]{64}$/i.test(normalizeDatabaseKey(value))

// The macOS Keychain APIs may wait for authorization. Keep that wait off the
// Electron main thread; async safeStorage reads the existing ciphertext format.
async function encryptionAvailable(): Promise<boolean> {
  try {
    return process.platform === 'darwin'
      ? await safeStorage.isAsyncEncryptionAvailable()
      : safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

async function decryptKey(encrypted: Buffer): Promise<string> {
  return process.platform === 'darwin'
    ? (await safeStorage.decryptStringAsync(encrypted)).result
    : safeStorage.decryptString(encrypted)
}

async function encryptKey(key: string): Promise<Buffer> {
  return process.platform === 'darwin'
    ? safeStorage.encryptStringAsync(key)
    : safeStorage.encryptString(key)
}

export class DatabaseKeyStore {
  private readonly pendingMutations = new Map<string, Promise<void>>()

  /** Preserve invocation order for one account, including time spent waiting for Keychain. */
  private mutateAccount<T>(accountRoot: string, operation: () => Promise<T>): Promise<T> {
    const accountFile = this.filePath(accountRoot)
    const previous = this.pendingMutations.get(accountFile) || Promise.resolve()
    const result = previous.then(operation)
    const finished = result.then(() => undefined, () => undefined)
    this.pendingMutations.set(accountFile, finished)
    void finished.then(() => {
      if (this.pendingMutations.get(accountFile) === finished) {
        this.pendingMutations.delete(accountFile)
      }
    })
    return result
  }

  private get legacyFilePath(): string {
    return path.join(app.getPath('userData'), 'wechat-db-key.bin')
  }

  private get directoryPath(): string {
    return path.join(app.getPath('userData'), 'database-keys')
  }

  private filePath(accountRoot: string): string {
    const normalized = path.resolve(accountRoot).toLowerCase()
    const id = crypto.createHash('sha256').update(normalized).digest('hex')
    return path.join(this.directoryPath, `${id}.bin`)
  }

  async getStatus(accountRoot: string): Promise<{ saved: boolean; encryptionAvailable: boolean }> {
    return {
      saved: Boolean(accountRoot) && (await fs.pathExists(this.filePath(accountRoot))),
      encryptionAvailable: await encryptionAvailable()
    }
  }

  async load(accountRoot: string): Promise<DatabaseKeyStorageResult> {
    try {
      const status = await this.getStatus(accountRoot)
      if (!status.saved) return { success: true, ...status }
      if (!status.encryptionAvailable) {
        return { success: false, error: '系统安全存储不可用', ...status }
      }
      const encrypted = await fs.readFile(this.filePath(accountRoot))
      const key = normalizeDatabaseKey(await decryptKey(encrypted))
      if (!isValidDatabaseKey(key)) {
        return { success: false, error: '已保存的密钥格式无效', ...status }
      }
      return { success: true, key, ...status }
    } catch (error) {
      const status = await this.getStatus(accountRoot)
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        ...status
      }
    }
  }

  async loadLegacy(): Promise<DatabaseKeyStorageResult> {
    const saved = await fs.pathExists(this.legacyFilePath)
    const available = await encryptionAvailable()
    if (!saved) return { success: true, saved, encryptionAvailable: available }
    if (!available) {
      return { success: false, error: '系统安全存储不可用', saved, encryptionAvailable: available }
    }
    try {
      const key = normalizeDatabaseKey(
        await decryptKey(await fs.readFile(this.legacyFilePath))
      )
      return isValidDatabaseKey(key)
        ? { success: true, key, saved, encryptionAvailable: available }
        : { success: false, error: '旧版密钥格式无效', saved, encryptionAvailable: available }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        saved,
        encryptionAvailable: available
      }
    }
  }

  async clearLegacy(): Promise<void> {
    await fs.remove(this.legacyFilePath)
  }

  save(accountRoot: string, rawKey: string): Promise<DatabaseKeyStorageResult> {
    return this.mutateAccount(accountRoot, () => this.saveNow(accountRoot, rawKey))
  }

  private async saveNow(accountRoot: string, rawKey: string): Promise<DatabaseKeyStorageResult> {
    const key = normalizeDatabaseKey(rawKey)
    if (!accountRoot.trim()) {
      return {
        success: false,
        error: '请先选择微信账号',
        saved: false,
        encryptionAvailable: await encryptionAvailable()
      }
    }
    if (!isValidDatabaseKey(key)) {
      return {
        success: false,
        error: '密钥必须是 64 位十六进制字符',
        saved: await fs.pathExists(this.filePath(accountRoot)),
        encryptionAvailable: await encryptionAvailable()
      }
    }
    if (!(await encryptionAvailable())) {
      return {
        success: false,
        error: '系统安全存储不可用',
        saved: await fs.pathExists(this.filePath(accountRoot)),
        encryptionAvailable: false
      }
    }

    try {
      const filePath = this.filePath(accountRoot)
      const encrypted = await encryptKey(key)
      await fs.ensureDir(this.directoryPath)
      await fs.writeFile(filePath, encrypted, { mode: 0o600 })
      await fs.chmod(filePath, 0o600)
      return { success: true, key, saved: true, encryptionAvailable: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        saved: await fs.pathExists(this.filePath(accountRoot)),
        encryptionAvailable: true
      }
    }
  }

  clear(accountRoot: string): Promise<{ success: boolean; error?: string }> {
    return this.mutateAccount(accountRoot, () => this.clearNow(accountRoot))
  }

  private async clearNow(accountRoot: string): Promise<{ success: boolean; error?: string }> {
    try {
      if (accountRoot) await fs.remove(this.filePath(accountRoot))
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}
