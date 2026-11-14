import fs from 'fs-extra'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-database-key-store-'))
const mocks = vi.hoisted(() => ({
  available: vi.fn(), decrypt: vi.fn(), encrypt: vi.fn(),
  syncAvailable: vi.fn(), syncDecrypt: vi.fn(), syncEncrypt: vi.fn()
}))
vi.mock('electron', () => ({
  app: { getPath: () => root },
  safeStorage: {
    isAsyncEncryptionAvailable: mocks.available,
    decryptStringAsync: mocks.decrypt,
    encryptStringAsync: mocks.encrypt,
    isEncryptionAvailable: mocks.syncAvailable,
    decryptString: mocks.syncDecrypt,
    encryptString: mocks.syncEncrypt
  }
}))
import { DatabaseKeyStore } from '../../src/main/database-key-store'

const originalPlatform = process.platform
const accountRoot = path.join(root, 'account')
const id = crypto.createHash('sha256').update(path.resolve(accountRoot).toLowerCase()).digest('hex')
const accountFile = path.join(root, 'database-keys', `${id}.bin`)
const legacyFile = path.join(root, 'wechat-db-key.bin')
const key = 'a'.repeat(64)
const ciphertext = Buffer.from('fixture existing encrypted key')

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  fs.emptyDirSync(root)
  mocks.available.mockResolvedValue(true)
  mocks.decrypt.mockResolvedValue({ result: `0x${key}` })
  mocks.encrypt.mockResolvedValue(ciphertext)
  mocks.syncAvailable.mockImplementation(() => { throw new Error('sync keychain called on macOS') })
  mocks.syncDecrypt.mockImplementation(() => { throw new Error('sync keychain called on macOS') })
  mocks.syncEncrypt.mockImplementation(() => { throw new Error('sync keychain called on macOS') })
})
afterEach(() => Object.defineProperty(process, 'platform', { value: originalPlatform }))
afterAll(() => fs.removeSync(root))

function expectNoSyncCalls(): void {
  expect(mocks.syncAvailable).not.toHaveBeenCalled()
  expect(mocks.syncDecrypt).not.toHaveBeenCalled()
  expect(mocks.syncEncrypt).not.toHaveBeenCalled()
}

describe('DatabaseKeyStore async macOS storage', () => {
  it('loads old per-account and legacy encrypted files without rewriting either', async () => {
    fs.outputFileSync(accountFile, ciphertext)
    fs.outputFileSync(legacyFile, ciphertext)
    const write = vi.spyOn(fs, 'writeFile')
    const store = new DatabaseKeyStore()
    expect(await store.load(accountRoot)).toEqual({ success: true, saved: true, encryptionAvailable: true, key })
    expect(await store.loadLegacy()).toEqual({ success: true, saved: true, encryptionAvailable: true, key })
    expect(mocks.decrypt).toHaveBeenNthCalledWith(1, ciphertext)
    expect(mocks.decrypt).toHaveBeenNthCalledWith(2, ciphertext)
    expect(mocks.encrypt).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
    expect(fs.readFileSync(accountFile)).toEqual(ciphertext)
    expect(fs.readFileSync(legacyFile)).toEqual(ciphertext)
    expectNoSyncCalls()
  })

  it('saves via async encryption with restricted permissions', async () => {
    expect(await new DatabaseKeyStore().save(accountRoot, ` 0x${key} `)).toEqual({ success: true, saved: true, encryptionAvailable: true, key })
    expect(mocks.encrypt).toHaveBeenCalledWith(key)
    expect(fs.readFileSync(accountFile)).toEqual(ciphertext)
    expect(fs.statSync(accountFile).mode & 0o777).toBe(0o600)
    expectNoSyncCalls()
  })

  it('clears after an earlier save finishes awaiting Keychain so a deleted key cannot reappear', async () => {
    let finishEncryption!: (value: Buffer) => void
    let enteredEncryption!: () => void
    const entered = new Promise<void>((resolve) => { enteredEncryption = resolve })
    mocks.encrypt.mockImplementationOnce(() => {
      enteredEncryption()
      return new Promise<Buffer>((resolve) => { finishEncryption = resolve })
    })
    const remove = vi.spyOn(fs, 'remove')
    const store = new DatabaseKeyStore()
    const saved = store.save(accountRoot, key)
    await entered
    const cleared = store.clear(accountRoot)
    await Promise.resolve()
    expect(remove).not.toHaveBeenCalled()

    finishEncryption(ciphertext)
    expect((await saved).success).toBe(true)
    expect(await cleared).toEqual({ success: true })
    expect(fs.existsSync(accountFile)).toBe(false)
    expect(remove).toHaveBeenCalledExactlyOnceWith(accountFile)
    expectNoSyncCalls()
  })

  it('keeps the latest save in invocation order while allowing another account to proceed', async () => {
    const newerKey = 'b'.repeat(64)
    const otherRoot = path.join(root, 'other-account')
    let finishEncryption!: (value: Buffer) => void
    let enteredEncryption!: () => void
    const entered = new Promise<void>((resolve) => { enteredEncryption = resolve })
    mocks.encrypt.mockImplementation(async (value: string) => {
      if (value === key) {
        enteredEncryption()
        return new Promise<Buffer>((resolve) => { finishEncryption = resolve })
      }
      return Buffer.from(`encrypted:${value}`)
    })
    const store = new DatabaseKeyStore()
    const first = store.save(accountRoot, key)
    await entered
    const second = store.save(accountRoot, newerKey)
    const other = store.save(otherRoot, 'c'.repeat(64))
    expect((await other).success).toBe(true)
    expect(mocks.encrypt).not.toHaveBeenCalledWith(newerKey)

    finishEncryption(ciphertext)
    expect((await first).success).toBe(true)
    expect((await second).success).toBe(true)
    expect(fs.readFileSync(accountFile)).toEqual(Buffer.from(`encrypted:${newerKey}`))
  })

  it('allows clearing after an earlier encryption failure', async () => {
    fs.outputFileSync(accountFile, ciphertext)
    mocks.encrypt.mockRejectedValueOnce(new Error('Keychain access denied'))
    const store = new DatabaseKeyStore()
    const saved = store.save(accountRoot, key)
    const cleared = store.clear(accountRoot)
    expect((await saved).success).toBe(false)
    expect((await cleared).success).toBe(true)
    expect(fs.existsSync(accountFile)).toBe(false)
  })

  it('authorization denial returns a failure without replacing existing ciphertext', async () => {
    fs.outputFileSync(accountFile, ciphertext)
    fs.outputFileSync(legacyFile, ciphertext)
    mocks.decrypt.mockRejectedValue(new Error('Keychain access denied'))
    mocks.encrypt.mockRejectedValue(new Error('Keychain access denied'))
    const store = new DatabaseKeyStore()
    expect(await store.load(accountRoot)).toMatchObject({ success: false, saved: true, error: 'Keychain access denied' })
    expect(await store.loadLegacy()).toMatchObject({ success: false, saved: true, error: 'Keychain access denied' })
    expect(await store.save(accountRoot, 'b'.repeat(64))).toMatchObject({ success: false, saved: true, error: 'Keychain access denied' })
    expect(fs.readFileSync(accountFile)).toEqual(ciphertext)
    expect(fs.readFileSync(legacyFile)).toEqual(ciphertext)
    expectNoSyncCalls()
  })

  it('fails closed when async availability is denied and writes no plaintext', async () => {
    mocks.available.mockRejectedValue(new Error('denied'))
    const store = new DatabaseKeyStore()
    expect(await store.save(accountRoot, key)).toMatchObject({ success: false, saved: false, encryptionAvailable: false })
    expect(fs.existsSync(accountFile)).toBe(false)
    expect(await store.getStatus(accountRoot)).toEqual({ saved: false, encryptionAvailable: false })
    expect(mocks.encrypt).not.toHaveBeenCalled()
    expectNoSyncCalls()
  })

  it('retains validation messages and rejects invalid decrypted keys', async () => {
    const store = new DatabaseKeyStore()
    expect(await store.save('', key)).toMatchObject({ success: false, error: '请先选择微信账号' })
    expect(await store.save(accountRoot, 'invalid')).toMatchObject({ success: false, error: '密钥必须是 64 位十六进制字符' })
    fs.outputFileSync(accountFile, ciphertext)
    fs.outputFileSync(legacyFile, ciphertext)
    mocks.decrypt.mockResolvedValue({ result: 'invalid' })
    expect(await store.load(accountRoot)).toMatchObject({ success: false, error: '已保存的密钥格式无效' })
    expect(await store.loadLegacy()).toMatchObject({ success: false, error: '旧版密钥格式无效' })
    expectNoSyncCalls()
  })

  it('keeps non-macOS synchronous safeStorage behavior', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mocks.syncAvailable.mockReturnValue(true)
    mocks.syncEncrypt.mockReturnValue(ciphertext)
    mocks.syncDecrypt.mockReturnValue(key)
    const store = new DatabaseKeyStore()
    expect((await store.save(accountRoot, key)).success).toBe(true)
    expect((await store.load(accountRoot)).key).toBe(key)
    expect(mocks.available).not.toHaveBeenCalled()
    expect(mocks.encrypt).not.toHaveBeenCalled()
    expect(mocks.decrypt).not.toHaveBeenCalled()
  })
})
