import fs from 'fs-extra'
import os from 'os'
import path from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wxe-api-token-store-'))
const storage = vi.hoisted(() => ({ available: true }))

vi.mock('electron', () => ({
  app: { getPath: () => root },
  safeStorage: {
    isEncryptionAvailable: () => storage.available,
    encryptString: (value: string) => Buffer.from(value, 'utf8').reverse(),
    decryptString: (value: Buffer) => Buffer.from(value).reverse().toString('utf8')
  }
}))

import { ApiTokenStore } from '../../src/main/api-token-store'

describe('ApiTokenStore', () => {
  const filePath = path.join(root, 'fixture-token.bin')

  beforeEach(() => {
    storage.available = true
    fs.removeSync(filePath)
  })

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
})
