import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'

import { MacWechatRuntimeManifestCache } from '../../src/main/services/mac-wechat-runtime-artifact'

const directories: string[] = []
const AGENT_HASH = 'a'.repeat(64)
const PROFILE_HASH = 'b'.repeat(64)
const FIXTURE_WECHAT_VERSION = 'fixture-wechat-version'

function createRuntimeDirectory(version: string): string {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'tracememo-runtime-cache-'))
  directories.push(runtimeDir)
  const manifest = {
    runtime: 'tm-wechat-native',
    version,
    platform: 'darwin-arm64',
    architecture: 'arm64',
    protocolVersion: 1,
    tmSendSourceSha256: AGENT_HASH,
    addressProfileSha256: PROFILE_HASH,
    supportedWechatVersions: [FIXTURE_WECHAT_VERSION],
    capabilities: ['text', 'image', 'voice']
  }
  writeFileSync(join(runtimeDir, 'runtime-manifest.json'), JSON.stringify(manifest))
  writeFileSync(join(runtimeDir, 'tm-wechat-host'), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01]))
  writeFileSync(join(runtimeDir, 'libtmwechat.dylib'), Buffer.concat([
    Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01]),
    Buffer.from(AGENT_HASH + PROFILE_HASH)
  ]))
  return runtimeDir
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('MacWechatRuntimeManifestCache', () => {
  it('reuses the validated manifest while all runtime artifacts remain unchanged', () => {
    const runtimeDir = createRuntimeDirectory('0.3.0')
    const cache = new MacWechatRuntimeManifestCache()
    const first = cache.read(runtimeDir, 'arm64')
    const second = cache.read(runtimeDir, 'arm64')
    expect(second).toBe(first)
  })

  it('revalidates when a runtime artifact changes', () => {
    const runtimeDir = createRuntimeDirectory('0.3.0')
    const cache = new MacWechatRuntimeManifestCache()
    cache.read(runtimeDir, 'arm64')
    writeFileSync(join(runtimeDir, 'runtime-manifest.json'), JSON.stringify({
      runtime: 'tm-wechat-native',
      version: '0.3.1',
      platform: 'darwin-arm64',
      architecture: 'arm64',
      protocolVersion: 1,
      tmSendSourceSha256: AGENT_HASH,
      addressProfileSha256: PROFILE_HASH,
      supportedWechatVersions: [FIXTURE_WECHAT_VERSION],
      capabilities: ['text', 'image', 'voice']
    }))
    expect(cache.read(runtimeDir, 'arm64').version).toBe('0.3.1')
  })

  it('does not return a cached manifest after an artifact disappears', () => {
    const runtimeDir = createRuntimeDirectory('0.3.0')
    const cache = new MacWechatRuntimeManifestCache()
    cache.read(runtimeDir, 'arm64')
    rmSync(join(runtimeDir, 'tm-wechat-host'))
    expect(() => cache.read(runtimeDir, 'arm64')).toThrow(/tm-wechat-host missing/)
  })
})
