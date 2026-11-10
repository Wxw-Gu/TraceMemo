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
const STORAGE_UNAVAILABLE = '系统安全存储不可用，本地 API 已安全停用。请检查系统钥匙串或凭据服务后重试。'
const STORAGE_PENDING = '正在等待系统安全存储授权，本地 API 暂未启用。'

interface TokenReadResult {
  success: boolean
  token?: string
  error?: string
}

export class ApiTokenStore {
  private cachedToken: string | null = null
  private automaticGenerationBlockedReason: string | null = null
  private asyncStorage: { available: boolean; error?: string } | undefined
  private asyncInitialization: Promise<ApiTokenActionResult> | undefined
  private asyncRotation: Promise<ApiTokenActionResult> | undefined

  constructor(
    private readonly filePathOverride?: string,
    private readonly platform: NodeJS.Platform = process.platform
  ) {}

  private get filePath(): string {
    return this.filePathOverride || path.join(app.getPath('userData'), 'local-api-token.bin')
  }

  getStatus(): ApiTokenStatus {
    if (this.asyncStorage) {
      return {
        available: this.asyncStorage.available,
        hasToken: Boolean(this.cachedToken),
        maskedToken: MASKED_TOKEN,
        ...(this.asyncStorage.error ? { error: this.asyncStorage.error } : {})
      }
    }
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
    // macOS 的异步初始化一旦开始，同步消费者只读缓存，绝不再次阻塞主线程。
    if (this.asyncStorage) {
      return this.cachedToken ? this.actionSuccess() : this.actionError(this.asyncStorage.error)
    }
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

  /** macOS 启动路径：保留已有密文，读失败绝不生成替代 Token。 */
  ensureTokenAsync(): Promise<ApiTokenActionResult> {
    if (this.platform !== 'darwin') return Promise.resolve(this.ensureToken())
    if (this.asyncInitialization) return this.asyncInitialization
    if (this.asyncRotation) return this.asyncRotation
    if (this.cachedToken) {
      this.asyncStorage = { available: true }
      return Promise.resolve(this.actionSuccess())
    }
    this.asyncStorage = { available: false, error: STORAGE_PENDING }
    this.asyncInitialization = this.initializeMacToken().finally(() => {
      this.asyncInitialization = undefined
    })
    return this.asyncInitialization
  }

  /**
   * 钥匙串没有回应时，其他启动服务也能继续；底层只保留一次未完成初始化。
   * 超时只结束启动等待，不丢弃授权完成后的回调，让调用方按届时的设置恢复服务。
   */
  async initializeForStartup(
    timeoutMs = 15_000,
    onTokenReady?: () => void | Promise<void>
  ): Promise<ApiTokenActionResult> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const initialized = this.ensureTokenAsync().then(async (result) => {
      if (result.success) await onTokenReady?.()
      return result
    })
    try {
      return await Promise.race([
        initialized,
        new Promise<ApiTokenActionResult>((resolve) => {
          timer = setTimeout(() => resolve(this.actionError(STORAGE_PENDING)), timeoutMs)
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private async initializeMacToken(): Promise<ApiTokenActionResult> {
    try {
      const available = await safeStorage.isAsyncEncryptionAvailable()
      this.asyncStorage = { available }
      if (!available) return this.asyncError(STORAGE_UNAVAILABLE)
      if (await fs.pathExists(this.filePath)) {
        const encrypted = await fs.readFile(this.filePath)
        const { result: token } = await safeStorage.decryptStringAsync(encrypted)
        if (!TOKEN_PATTERN.test(token)) return this.asyncError('已保存的 API Token 格式无效，未修改原文件')
        this.cachedToken = token
        return this.actionSuccess()
      }
      if (this.automaticGenerationBlockedReason) {
        return this.asyncError(this.automaticGenerationBlockedReason)
      }
      return await this.persistAsync(this.generateToken())
    } catch {
      return this.asyncError('API Token 无法从系统安全存储读取，原文件未被替换。请完成钥匙串授权后重试。')
    }
  }

  async revealTokenAsync(): Promise<ApiTokenRevealResult> {
    const ensured = await this.ensureTokenAsync()
    return ensured.success ? { ...ensured, token: this.cachedToken || undefined } : ensured
  }

  rotateTokenAsync(): Promise<ApiTokenActionResult> {
    if (this.platform !== 'darwin') return Promise.resolve(this.rotateToken())
    if (this.asyncRotation) return this.asyncRotation
    this.asyncStorage ??= { available: false, error: STORAGE_PENDING }
    this.asyncRotation = (async () => {
      // 初始化与用户明确请求的重置串行，防止启动解密覆盖刚生成的缓存。
      if (this.asyncInitialization) await this.asyncInitialization
      try {
        const available = await safeStorage.isAsyncEncryptionAvailable()
        this.asyncStorage = { available }
        if (!available) return this.asyncError(STORAGE_UNAVAILABLE)
        const result = await this.persistAsync(this.generateToken())
        if (result.success) this.automaticGenerationBlockedReason = null
        return result
      } catch {
        return this.asyncError('API Token 无法保存到系统安全存储')
      }
    })().finally(() => { this.asyncRotation = undefined })
    return this.asyncRotation
  }

  private async persistAsync(token: string): Promise<ApiTokenActionResult> {
    // 先加密再写文件：系统拒绝授权时不会截断已有密文。
    const encrypted = await safeStorage.encryptStringAsync(token)
    await fs.ensureDir(path.dirname(this.filePath))
    await fs.writeFile(this.filePath, encrypted, { mode: 0o600 })
    await fs.chmod(this.filePath, 0o600)
    this.cachedToken = token
    this.asyncStorage = { available: true }
    return this.actionSuccess()
  }

  private asyncError(error: string): ApiTokenActionResult {
    this.asyncStorage = { available: this.asyncStorage?.available === true, error }
    return this.actionError(error)
  }

  revealToken(): ApiTokenRevealResult {
    const ensured = this.ensureToken()
    if (!ensured.success) return ensured
    return { ...ensured, token: this.cachedToken || undefined }
  }

  rotateToken(): ApiTokenActionResult {
    if (this.asyncStorage) return this.actionError('请使用异步安全存储重置 API Token')
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
    if (this.asyncStorage) return { success: false, error: this.asyncStorage.error || STORAGE_PENDING }
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
      available: this.asyncStorage?.available ?? safeStorage.isEncryptionAvailable(),
      hasToken: false,
      maskedToken: MASKED_TOKEN,
      error: error || 'API Token 安全存储不可用'
    }
  }
}

export const apiTokenStore = new ApiTokenStore()
