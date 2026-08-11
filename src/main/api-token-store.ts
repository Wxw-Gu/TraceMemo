import crypto from 'crypto'
import { app, safeStorage } from 'electron'
import fs from 'fs-extra'
import path from 'path'
import type {
  ApiTokenActionResult,
  ApiTokenRevealResult,
  ApiTokenStatus
} from '../shared/local-api-auth'

const MASKED_TOKEN = '••••••••••••••••'
const TOKEN_BYTES = 32
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

interface TokenReadResult {
  success: boolean
  token?: string
  error?: string
}

export class ApiTokenStore {
  private cachedToken: string | null = null
  private automaticGenerationBlockedReason: string | null = null

  constructor(private readonly filePathOverride?: string) {}

  private get filePath(): string {
    return this.filePathOverride || path.join(app.getPath('userData'), 'local-api-token.bin')
  }

  getStatus(): ApiTokenStatus {
    const available = safeStorage.isEncryptionAvailable()
    if (!available) {
      return {
        available: false,
        hasToken: false,
        maskedToken: MASKED_TOKEN,
        error: '系统安全存储不可用，本地 API 已安全停用。请检查系统钥匙串或凭据服务后重试。'
      }
    }
    const result = this.read()
    return {
      available: true,
      hasToken: result.success && Boolean(result.token),
      maskedToken: MASKED_TOKEN,
      ...(result.success
        ? result.token || !this.automaticGenerationBlockedReason
          ? {}
          : { error: this.automaticGenerationBlockedReason }
        : { error: result.error })
    }
  }

  setAutomaticGenerationBlocked(reason?: string): void {
    this.automaticGenerationBlockedReason = reason?.trim() || null
  }

  ensureToken(): ApiTokenActionResult {
    if (!safeStorage.isEncryptionAvailable()) {
      return {
        success: false,
        available: false,
        hasToken: false,
        maskedToken: MASKED_TOKEN,
        error: '系统安全存储不可用，本地 API 已安全停用。请检查系统钥匙串或凭据服务后重试。'
      }
    }
    const current = this.read()
    if (!current.success) return this.actionError(current.error)
    if (current.token) return this.actionSuccess()
    if (this.automaticGenerationBlockedReason) {
      return this.actionError(this.automaticGenerationBlockedReason)
    }
    return this.persist(this.generateToken())
  }

  revealToken(): ApiTokenRevealResult {
    const ensured = this.ensureToken()
    if (!ensured.success) return ensured
    return { ...ensured, token: this.cachedToken || undefined }
  }

  rotateToken(): ApiTokenActionResult {
    if (!safeStorage.isEncryptionAvailable()) return this.ensureToken()
    const result = this.persist(this.generateToken())
    if (result.success) this.automaticGenerationBlockedReason = null
    return result
  }

  getTokenForAuthentication(): string | null {
    if (this.cachedToken) return this.cachedToken
    const result = this.read()
    return result.success ? result.token || null : null
  }

  private generateToken(): string {
    return crypto.randomBytes(TOKEN_BYTES).toString('base64url')
  }

  private read(): TokenReadResult {
    if (this.cachedToken) return { success: true, token: this.cachedToken }
    if (!safeStorage.isEncryptionAvailable()) {
      return { success: false, error: '系统安全存储不可用' }
    }
    if (!fs.existsSync(this.filePath)) return { success: true }
    try {
      const token = safeStorage.decryptString(fs.readFileSync(this.filePath))
      if (!TOKEN_PATTERN.test(token)) throw new Error('invalid token data')
      this.cachedToken = token
      return { success: true, token }
    } catch {
      return { success: false, error: '已保存的 API Token 无法从系统安全存储读取' }
    }
  }

  private persist(token: string): ApiTokenActionResult {
    try {
      fs.ensureDirSync(path.dirname(this.filePath))
      fs.writeFileSync(this.filePath, safeStorage.encryptString(token), { mode: 0o600 })
      fs.chmodSync(this.filePath, 0o600)
      this.cachedToken = token
      return this.actionSuccess()
    } catch {
      return this.actionError('API Token 无法保存到系统安全存储')
    }
  }

  private actionSuccess(): ApiTokenActionResult {
    return {
      success: true,
      available: true,
      hasToken: true,
      maskedToken: MASKED_TOKEN
    }
  }

  private actionError(error?: string): ApiTokenActionResult {
    return {
      success: false,
      available: safeStorage.isEncryptionAvailable(),
      hasToken: false,
      maskedToken: MASKED_TOKEN,
      error: error || 'API Token 安全存储不可用'
    }
  }
}

export const apiTokenStore = new ApiTokenStore()
