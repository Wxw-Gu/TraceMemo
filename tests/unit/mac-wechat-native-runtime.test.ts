import { createRequire } from 'module'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

import {
  bindingMatchesRuntimeManifest,
  readMacWechatRuntimeManifest
} from '../../src/main/services/mac-wechat-runtime-artifact'

const nodeRequire = createRequire(import.meta.url)
const { readAndValidateArtifact, syncArtifact } = nodeRequire(
  '../../scripts/prepare-wechat-native-runtime.cjs'
) as {
  readAndValidateArtifact: (sourceDir: string) => { manifest: { tmSendSourceSha256: string } }
  syncArtifact: (sourceDir: string, targetDir: string) => unknown
}

const AGENT_HASH = 'a'.repeat(64)
const ADDRESS_PROFILE_HASH = 'b'.repeat(64)

function writeMachOArm64(filePath: string, suffix = Buffer.alloc(0)): void {
  const header = Buffer.alloc(32)
  header.writeUInt32LE(0xfeedfacf, 0)
  header.writeUInt32LE(0x0100000c, 4)
  writeFileSync(filePath, Buffer.concat([header, suffix]))
}

function createArtifact(root: string): void {
  writeMachOArm64(join(root, 'tm-wechat-host'))
  writeMachOArm64(
    join(root, 'libtmwechat.dylib'),
    Buffer.from(`${AGENT_HASH}${ADDRESS_PROFILE_HASH}`)
  )
  writeFileSync(
    join(root, 'runtime-manifest.json'),
    JSON.stringify({
      runtime: 'tm-wechat-native',
      version: '0.1.0',
      platform: 'darwin-arm64',
      architecture: 'arm64',
      protocolVersion: 1,
      buildCommit: 'test',
      tmSendSourceSha256: AGENT_HASH,
      addressProfileSha256: ADDRESS_PROFILE_HASH,
      supportedWechatVersions: ['4.1.11.53'],
      capabilities: ['text', 'image', 'voice']
    })
  )
}

describe('macOS self-contained WeChat runtime artifact', () => {
  it('validates the manifest, architecture, capabilities and embedded agent identity', () => {
    const root = mkdtempSync(join(tmpdir(), 'tm-native-runtime-'))
    createArtifact(root)

    const manifest = readMacWechatRuntimeManifest(root, 'arm64')
    expect(manifest.tmSendSourceSha256).toBe(AGENT_HASH)
    expect(
      bindingMatchesRuntimeManifest(
        {
          hostPid: 123,
          runtimeVersion: 'tm-wechat-runtime/0.1.0',
          embeddedAgentSha256: AGENT_HASH,
          embeddedAddressProfileSha256: ADDRESS_PROFILE_HASH
        },
        manifest
      )
    ).toBe(true)
    expect(
      bindingMatchesRuntimeManifest(
        { hostPid: 123, runtimeVersion: 'tm-wechat-runtime/0.1.0' },
        manifest
      )
    ).toBe(false)
    expect(
      bindingMatchesRuntimeManifest(
        {
          runtimeVersion: 'tm-wechat-runtime/0.1.0',
          embeddedAgentSha256: AGENT_HASH
        },
        manifest
      )
    ).toBe(false)
  })

  it('rejects a manifest whose embedded address profile hash is absent from the dylib', () => {
    const root = mkdtempSync(join(tmpdir(), 'tm-native-runtime-profile-mismatch-'))
    createArtifact(root)
    writeFileSync(
      join(root, 'runtime-manifest.json'),
      JSON.stringify({
        runtime: 'tm-wechat-native',
        version: '0.1.0',
        platform: 'darwin-arm64',
        architecture: 'arm64',
        protocolVersion: 1,
        buildCommit: 'test',
        tmSendSourceSha256: AGENT_HASH,
        addressProfileSha256: 'c'.repeat(64),
        supportedWechatVersions: ['4.1.11.53'],
        capabilities: ['text', 'image', 'voice']
      })
    )
    expect(() => readMacWechatRuntimeManifest(root, 'arm64')).toThrow(/address profile hash/)
  })

  it('prepares an exact runtime tree and removes old external agent and table directories', () => {
    const source = mkdtempSync(join(tmpdir(), 'tm-native-source-'))
    const target = mkdtempSync(join(tmpdir(), 'tm-native-target-parent-'))
    const targetRuntime = join(target, 'darwin-arm64')
    createArtifact(source)
    mkdirSync(join(targetRuntime, 'scripts'), { recursive: true })
    writeFileSync(join(targetRuntime, 'scripts', 'tm_send.js'), 'old external agent')
    mkdirSync(join(targetRuntime, 'wechat_version'), { recursive: true })
    writeFileSync(join(targetRuntime, 'wechat_version', '4_1_11_53_mac.json'), '{}')

    expect(readAndValidateArtifact(source).manifest.tmSendSourceSha256).toBe(AGENT_HASH)
    syncArtifact(source, targetRuntime)

    expect(existsSync(join(targetRuntime, 'scripts'))).toBe(false)
    expect(existsSync(join(targetRuntime, 'wechat_version'))).toBe(false)
    expect(existsSync(join(targetRuntime, 'runtime-manifest.json'))).toBe(true)
    expect(readAndValidateArtifact(targetRuntime).manifest.tmSendSourceSha256).toBe(AGENT_HASH)
  })
})
