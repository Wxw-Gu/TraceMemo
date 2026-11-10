import fs from 'fs-extra'
import os from 'os'
import path from 'path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wxe-api-token-store-'))
const storage = vi.hoisted(() => ({
  available: true,
  syncAvailable: vi.fn(), syncEncrypt: vi.fn(), syncDecrypt: vi.fn(),
  asyncAvailable: vi.fn(), asyncEncrypt: vi.fn(), asyncDecrypt: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => root },
  safeStorage: {
    isEncryptionAvailable: storage.syncAvailable,
    encryptString: storage.syncEncrypt,
    decryptString: storage.syncDecrypt,
    isAsyncEncryptionAvailable: storage.asyncAvailable,
    encryptStringAsync: storage.asyncEncrypt,
    decryptStringAsync: storage.asyncDecrypt
  }
}))

import { ApiTokenStore } from '../../src/main/api-token-store'

describe('ApiTokenStore', () => {
  const filePath = path.join(root, 'fixture-token.bin')

  beforeEach(() => {
    vi.resetAllMocks()
    storage.available = true
    storage.syncAvailable.mockImplementation(() => storage.available)
    storage.syncEncrypt.mockImplementation((value: string) => Buffer.from(value, 'utf8').reverse())
    storage.syncDecrypt.mockImplementation((value: Buffer) => Buffer.from(value).reverse().toString('utf8'))
    storage.asyncAvailable.mockImplementation(async () => storage.available)
    storage.asyncEncrypt.mockImplementation(async (value: string) => Buffer.from(value, 'utf8').reverse())
    storage.asyncDecrypt.mockImplementation(async (value: Buffer) => ({ result: Buffer.from(value).reverse().toString('utf8'), shouldReEncrypt: false }))
    fs.removeSync(filePath)
  })

  afterEach(() => vi.useRealTimers())
  afterAll(() => fs.removeSync(root))

  it('generates a 256-bit base64url token once and persists it', () => {
    const firstStore = new ApiTokenStore(filePath)
    expect(firstStore.ensureToken()).toMatchObject({ success: true, hasToken: true })
    const first = firstStore.revealToken().token
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(fs.readFileSync(filePath, 'utf8')).not.toContain(String(first))
    if (process.platform !== 'win32') {
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600)
    }

    const secondStore = new ApiTokenStore(filePath)
    expect(secondStore.ensureToken()).toMatchObject({ success: true, hasToken: true })
    expect(secondStore.revealToken().token).toBe(first)
  })

  it('rotates the token while keeping status responses masked', () => {
    const store = new ApiTokenStore(filePath)
    store.ensureToken()
    const oldToken = store.revealToken().token
    const result = store.rotateToken()
    const newToken = store.revealToken().token
    expect(result).toEqual({
      success: true,
      available: true,
      hasToken: true,
      maskedToken: '••••••••••••••••'
    })
    expect(newToken).not.toBe(oldToken)
  })

  it('fails closed without writing plaintext when safeStorage is unavailable', () => {
    storage.available = false
    const store = new ApiTokenStore(filePath)
    expect(store.ensureToken()).toMatchObject({ success: false, available: false, hasToken: false })
    expect(fs.existsSync(filePath)).toBe(false)
    expect(store.revealToken().token).toBeUndefined()
  })

  it('does not silently replace a legacy token when migration is deferred', () => {
    const store = new ApiTokenStore(filePath)
    store.setAutomaticGenerationBlocked('legacy token migration pending')

    expect(store.ensureToken()).toMatchObject({
      success: false,
      hasToken: false,
      error: 'legacy token migration pending'
    })
    expect(fs.existsSync(filePath)).toBe(false)

    expect(store.rotateToken()).toMatchObject({ success: true, hasToken: true })
    expect(fs.existsSync(filePath)).toBe(true)
  })
  it('mac async startup decrypts an existing token without rewriting ciphertext or accessing synchronous storage', async () => {
    const token = 'A'.repeat(43)
    const ciphertext = Buffer.from(token).reverse()
    fs.writeFileSync(filePath, ciphertext)
    const store = new ApiTokenStore(filePath, 'darwin')
    expect(await store.initializeForStartup()).toMatchObject({ success: true, hasToken: true })
    expect(store.getStatus()).toMatchObject({ available: true, hasToken: true })
    expect(store.ensureToken().success).toBe(true)
    expect(store.revealToken().token).toBe(token)
    expect(store.getTokenForAuthentication()).toBe(token)
    expect(fs.readFileSync(filePath).equals(ciphertext)).toBe(true)
    expect(storage.asyncDecrypt).toHaveBeenCalledTimes(1)
    expect(storage.asyncEncrypt).not.toHaveBeenCalled()
    expect(storage.syncAvailable).not.toHaveBeenCalled()
    expect(storage.syncDecrypt).not.toHaveBeenCalled()
    expect(storage.syncEncrypt).not.toHaveBeenCalled()
  })

  it('mac async startup generates only when no prior token exists, and later startup preserves it', async () => {
    const first = new ApiTokenStore(filePath, 'darwin')
    expect((await first.ensureTokenAsync()).success).toBe(true)
    const token = first.getTokenForAuthentication()
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const bytes = fs.readFileSync(filePath)
    const second = new ApiTokenStore(filePath, 'darwin')
    expect((await second.ensureTokenAsync()).success).toBe(true)
    expect(second.getTokenForAuthentication()).toBe(token)
    expect(fs.readFileSync(filePath).equals(bytes)).toBe(true)
    expect(storage.asyncEncrypt).toHaveBeenCalledTimes(1)
    expect(storage.syncAvailable).not.toHaveBeenCalled()
  })

  it('mac decryption failure preserves the existing token file and fails closed without replacement', async () => {
    const ciphertext = Buffer.from('unreadable ciphertext')
    fs.writeFileSync(filePath, ciphertext)
    storage.asyncDecrypt.mockRejectedValue(new Error('access denied'))
    const store = new ApiTokenStore(filePath, 'darwin')
    expect(await store.ensureTokenAsync()).toMatchObject({ success: false, hasToken: false })
    expect(store.ensureToken().success).toBe(false)
    expect(store.getTokenForAuthentication()).toBeNull()
    expect(store.revealToken().token).toBeUndefined()
    expect(fs.readFileSync(filePath).equals(ciphertext)).toBe(true)
    expect(storage.asyncEncrypt).not.toHaveBeenCalled()
    expect(storage.syncAvailable).not.toHaveBeenCalled()
    expect(storage.syncDecrypt).not.toHaveBeenCalled()
  })

  it('mac unavailable storage does not generate a token or fall back to synchronous/plaintext storage', async () => {
    storage.available = false
    const store = new ApiTokenStore(filePath, 'darwin')
    expect(await store.ensureTokenAsync()).toMatchObject({ success: false, available: false })
    expect(store.getTokenForAuthentication()).toBeNull()
    expect(store.ensureToken().success).toBe(false)
    expect(fs.existsSync(filePath)).toBe(false)
    expect(storage.asyncEncrypt).not.toHaveBeenCalled()
    expect(storage.syncAvailable).not.toHaveBeenCalled()
  })

  it('mac startup timeout leaves one pending read, lets callers fail closed, and accepts a late authorized result', async () => {
    vi.useFakeTimers()
    const token = 'B'.repeat(43)
    fs.writeFileSync(filePath, Buffer.from(token).reverse())
    let authorize!: (available: boolean) => void
    storage.asyncAvailable.mockReturnValue(new Promise<boolean>((resolve) => { authorize = resolve }))
    const store = new ApiTokenStore(filePath, 'darwin')
    const startup = store.initializeForStartup(100)
    const pending = store.ensureTokenAsync()
    await vi.advanceTimersByTimeAsync(100)
    expect(await startup).toMatchObject({ success: false, hasToken: false })
    expect(store.getTokenForAuthentication()).toBeNull()
    expect(store.ensureToken().success).toBe(false)
    expect(store.ensureTokenAsync()).toBe(pending)
    expect(storage.asyncAvailable).toHaveBeenCalledTimes(1)
    authorize(true)
    expect((await pending).success).toBe(true)
    expect(store.getTokenForAuthentication()).toBe(token)
    expect(storage.syncAvailable).not.toHaveBeenCalled()
    expect(storage.asyncEncrypt).not.toHaveBeenCalled()
  })

  it('mac explicit rotation uses async encryption while keeping ordinary status/reads cached', async () => {
    const store = new ApiTokenStore(filePath, 'darwin')
    await store.ensureTokenAsync()
    const oldToken = store.getTokenForAuthentication()
    expect((await store.rotateTokenAsync()).success).toBe(true)
    expect(store.getTokenForAuthentication()).not.toBe(oldToken)
    expect((await store.revealTokenAsync()).token).toBe(store.getTokenForAuthentication())
    expect(storage.asyncEncrypt).toHaveBeenCalledTimes(2)
    expect(storage.syncEncrypt).not.toHaveBeenCalled()
    expect(storage.syncAvailable).not.toHaveBeenCalled()
  })

  it('runs startup recovery once after late authorization and reads the latest API configuration', async () => {
    vi.useFakeTimers()
    fs.writeFileSync(filePath, Buffer.from('C'.repeat(43)).reverse())
    let authorize!: (available: boolean) => void
    storage.asyncAvailable.mockReturnValue(new Promise<boolean>((resolve) => { authorize = resolve }))
    const settings = { apiEnabled: true, apiHost: '127.0.0.1', apiPort: 5031 }
    const startApi = vi.fn().mockResolvedValue(undefined)
    const store = new ApiTokenStore(filePath, 'darwin')
    const startup = store.initializeForStartup(100, async () => {
      if (settings.apiEnabled) await startApi(settings.apiHost, settings.apiPort)
    })

    await vi.advanceTimersByTimeAsync(100)
    expect((await startup).success).toBe(false)
    expect(startApi).not.toHaveBeenCalled()
    settings.apiPort = 5042
    authorize(true)
    await store.ensureTokenAsync()
    expect(startApi).toHaveBeenCalledExactlyOnceWith('127.0.0.1', 5042)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(startApi).toHaveBeenCalledTimes(1)
    expect(storage.asyncAvailable).toHaveBeenCalledTimes(1)
    expect(storage.syncAvailable).not.toHaveBeenCalled()
  })

  it('does not restart an API disabled while startup authorization was pending', async () => {
    vi.useFakeTimers()
    fs.writeFileSync(filePath, Buffer.from('D'.repeat(43)).reverse())
    let authorize!: (available: boolean) => void
    storage.asyncAvailable.mockReturnValue(new Promise<boolean>((resolve) => { authorize = resolve }))
    const settings = { apiEnabled: true }
    const startApi = vi.fn()
    const store = new ApiTokenStore(filePath, 'darwin')
    const startup = store.initializeForStartup(100, () => {
      if (settings.apiEnabled) startApi()
    })

    await vi.advanceTimersByTimeAsync(100)
    expect((await startup).success).toBe(false)
    settings.apiEnabled = false
    authorize(true)
    expect((await store.ensureTokenAsync()).success).toBe(true)
    expect(startApi).not.toHaveBeenCalled()
  })

  it('does not invoke startup recovery when authorization fails', async () => {
    storage.available = false
    const ready = vi.fn()
    const store = new ApiTokenStore(filePath, 'darwin')
    expect((await store.initializeForStartup(100, ready)).success).toBe(false)
    expect(ready).not.toHaveBeenCalled()
  })

  it('non-mac async entry retains existing synchronous storage behavior', async () => {
    const store = new ApiTokenStore(filePath, 'win32')
    expect((await store.ensureTokenAsync()).success).toBe(true)
    expect((await store.rotateTokenAsync()).success).toBe(true)
    expect(storage.syncEncrypt).toHaveBeenCalledTimes(2)
    expect(storage.asyncAvailable).not.toHaveBeenCalled()
  })

  it('mac async startup honors a deferred legacy migration without minting a token', async () => {
    const store = new ApiTokenStore(filePath, 'darwin')
    store.setAutomaticGenerationBlocked('legacy token migration pending')
    expect(await store.ensureTokenAsync()).toMatchObject({ success: false, error: 'legacy token migration pending' })
    expect(fs.existsSync(filePath)).toBe(false)
    expect(storage.asyncEncrypt).not.toHaveBeenCalled()
    expect(storage.syncAvailable).not.toHaveBeenCalled()
  })

})
