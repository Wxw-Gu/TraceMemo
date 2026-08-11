import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chooseUserDataRoot, getUserDataRoots, hasValidUserAssets } from '../../src/main/app-data-paths'

let root = ''

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'tracememo-app-data-paths-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function fixtureRoots(): ReturnType<typeof getUserDataRoots> {
  return getUserDataRoots(path.join(root, 'Application Support'))
}

function writeMarker(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, 'fixture')
}

describe('app data compatibility root selection', () => {
  it('chooses the new root for a clean install', () => {
    const roots = fixtureRoots()
    expect(hasValidUserAssets(roots.legacy)).toBe(false)
    expect(hasValidUserAssets(roots.current)).toBe(false)
    expect(chooseUserDataRoot(roots)).toBe(roots.current)
  })

  it('ignores runtime-only Chromium files', () => {
    const roots = fixtureRoots()
    mkdirSync(roots.current, { recursive: true })
    writeMarker(path.join(roots.current, 'Local State'))
    mkdirSync(path.join(roots.current, 'Cache'), { recursive: true })
    expect(hasValidUserAssets(roots.current)).toBe(false)
    expect(chooseUserDataRoot(roots)).toBe(roots.current)
  })

  it('prefers a legacy root containing user settings', () => {
    const roots = fixtureRoots()
    writeMarker(path.join(roots.legacy, 'settings.json'))
    expect(chooseUserDataRoot(roots)).toBe(roots.legacy)
  })

  it('uses a current root when only it contains valid user assets', () => {
    const roots = fixtureRoots()
    writeMarker(path.join(roots.current, 'ai-providers.json'))
    expect(chooseUserDataRoot(roots)).toBe(roots.current)
  })

  it('prefers legacy without modifying a valid current root', () => {
    const roots = fixtureRoots()
    writeMarker(path.join(roots.legacy, 'reports', '2026', '08', 'report.json'))
    writeMarker(path.join(roots.current, 'local-api-token.bin'))
    const currentToken = path.join(roots.current, 'local-api-token.bin')
    expect(chooseUserDataRoot(roots)).toBe(roots.legacy)
    expect(hasValidUserAssets(roots.current)).toBe(true)
    expect(readFileSync(currentToken, 'utf8')).toBe('fixture')
  })

  it('recognizes Knowledge only when a non-empty knowledge.sqlite exists', () => {
    const roots = fixtureRoots()
    mkdirSync(path.join(roots.legacy, 'knowledge', 'account-hash'), { recursive: true })
    expect(hasValidUserAssets(roots.legacy)).toBe(false)
    writeMarker(path.join(roots.legacy, 'knowledge', 'account-hash', 'knowledge.sqlite'))
    expect(hasValidUserAssets(roots.legacy)).toBe(true)
  })

  it('honors WXE_USER_DATA isolation before normal root selection', () => {
    const roots = fixtureRoots()
    writeMarker(path.join(roots.legacy, 'settings.json'))
    const isolated = path.join(root, 'isolated-user-data')
    expect(chooseUserDataRoot({ ...roots, isolated })).toBe(isolated)
  })

  it.each([
    'ai-provider-keys.bin',
    'local-api-token.bin',
    'wechat-image-keys.bin',
    path.join('database-keys', 'account.bin'),
    path.join('recall-archive', 'entry.json'),
    path.join('Local Storage', 'leveldb', '000001.ldb')
  ])('recognizes %s as a persistent user asset', (relativePath) => {
    const roots = fixtureRoots()
    writeMarker(path.join(roots.legacy, relativePath))
    expect(hasValidUserAssets(roots.legacy)).toBe(true)
    expect(chooseUserDataRoot(roots)).toBe(roots.legacy)
  })
})
