import { existsSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

import type { MacWechatRuntimeManifest } from '../../shared/personal-wechat-mac-runtime'

const REQUIRED_CAPABILITIES = ['text', 'image', 'voice'] as const

function assertFile(path: string, label: string): void {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`${label} missing: ${path}`)
  }
}

function assertMachOArm64(path: string, label: string): void {
  const binary = readFileSync(path)
  if (binary.length < 8 || binary.readUInt32LE(0) !== 0xfeedfacf) {
    throw new Error(`${label} is not a 64-bit Mach-O binary`)
  }
  if (binary.readUInt32LE(4) !== 0x0100000c) {
    throw new Error(`${label} is not arm64`)
  }
}

export function readMacWechatRuntimeManifest(
  runtimeDir: string,
  architecture = process.arch
): MacWechatRuntimeManifest {
  const manifestPath = join(runtimeDir, 'runtime-manifest.json')
  const hostPath = join(runtimeDir, 'tm-wechat-host')
  const dylibPath = join(runtimeDir, 'libtmwechat.dylib')
  assertFile(manifestPath, 'runtime manifest')
  assertFile(hostPath, 'runtime host')
  assertFile(dylibPath, 'runtime dylib')

  let manifest: MacWechatRuntimeManifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as MacWechatRuntimeManifest
  } catch (error) {
    throw new Error(`runtime manifest is unreadable: ${String(error)}`)
  }

  if (manifest.runtime !== 'tm-wechat-native') {
    throw new Error(`unexpected runtime name: ${String(manifest.runtime)}`)
  }
  if (manifest.platform !== 'darwin-arm64') {
    throw new Error(`runtime platform must be darwin-arm64: ${String(manifest.platform)}`)
  }
  if (manifest.architecture !== 'arm64' || architecture !== 'arm64') {
    throw new Error(
      `runtime architecture mismatch: artifact=${String(manifest.architecture)} process=${architecture}`
    )
  }
  if (manifest.protocolVersion !== 1) {
    throw new Error(`unsupported runtime protocolVersion: ${String(manifest.protocolVersion)}`)
  }
  if (!/^[a-f0-9]{64}$/.test(manifest.tmSendSourceSha256 || '')) {
    throw new Error('runtime manifest has no valid tmSendSourceSha256')
  }
  if (!/^[a-f0-9]{64}$/.test(manifest.addressProfileSha256 || '')) {
    throw new Error('runtime manifest has no valid addressProfileSha256')
  }
  if (
    !Array.isArray(manifest.supportedWechatVersions) ||
    manifest.supportedWechatVersions.length === 0
  ) {
    throw new Error('runtime manifest has no supported WeChat versions')
  }
  const capabilities = new Set(manifest.capabilities || [])
  for (const capability of REQUIRED_CAPABILITIES) {
    if (!capabilities.has(capability)) {
      throw new Error(`runtime manifest capability missing: ${capability}`)
    }
  }
  assertMachOArm64(hostPath, 'runtime host')
  assertMachOArm64(dylibPath, 'runtime dylib')
  if (!readFileSync(dylibPath).includes(Buffer.from(manifest.tmSendSourceSha256, 'utf8'))) {
    throw new Error('runtime dylib embedded agent hash does not match manifest')
  }
  if (!readFileSync(dylibPath).includes(Buffer.from(manifest.addressProfileSha256, 'utf8'))) {
    throw new Error('runtime dylib embedded address profile hash does not match manifest')
  }
  return manifest
}

export function bindingMatchesRuntimeManifest(
  binding: {
    hostPid?: number
    runtimeVersion?: string
    embeddedAgentSha256?: string
    embeddedAddressProfileSha256?: string
  },
  manifest: MacWechatRuntimeManifest
): boolean {
  return (
    Number.isInteger(binding.hostPid) &&
    Number(binding.hostPid) > 0 &&
    binding.runtimeVersion === `tm-wechat-runtime/${manifest.version}` &&
    binding.embeddedAgentSha256 === manifest.tmSendSourceSha256 &&
    binding.embeddedAddressProfileSha256 === manifest.addressProfileSha256
  )
}
