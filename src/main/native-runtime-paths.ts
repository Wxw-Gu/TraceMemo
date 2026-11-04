import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

import { findResource } from './resource-paths'

export type NativeRuntimeProfile = 'public' | 'native'

const BUILD_MARKER = 'tracememo-build.json'
const RUNTIME_RELATIVE = 'runtime/darwin-arm64'

let cachedProfile: NativeRuntimeProfile | null = null
let cachedMarkerRead = false

function getNativeRuntimeProfile(): NativeRuntimeProfile {
  const envProfile = !app.isPackaged ? process.env.TRACEMEMO_RUNTIME_PROFILE : undefined
  if (envProfile === 'public' || envProfile === 'native') return envProfile
  if (cachedMarkerRead && cachedProfile) return cachedProfile
  cachedMarkerRead = true
  const marker = findResource(BUILD_MARKER)
  if (marker) {
    try {
      const parsed = JSON.parse(fs.readFileSync(marker, 'utf8')) as { profile?: unknown }
      if (parsed.profile === 'public' || parsed.profile === 'native') {
        cachedProfile = app.isPackaged ? parsed.profile : 'native'
        return cachedProfile
      }
    } catch {
      // Packaged builds fail closed below when the marker cannot be read.
    }
  }
  cachedProfile = app.isPackaged ? 'public' : 'native'
  return cachedProfile
}

export function hasMacNativeBundle(): boolean {
  return process.platform === 'darwin' && getNativeRuntimeProfile() === 'native'
}

export function isMacNativeRuntimeUnavailable(): boolean {
  return process.platform === 'darwin' && !hasMacNativeBundle()
}

export function resolveWcdbLibrary(): string | null {
  if (process.platform !== 'darwin') return null
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  return findResource(`wcdb/macos/${arch}/libwcdb_api.dylib`)
}

export function resolveWcdbDependency(): string | null {
  const library = resolveWcdbLibrary()
  if (!library) return null
  const dependency = path.join(path.dirname(library), 'libWCDB.dylib')
  return fs.existsSync(dependency) ? dependency : null
}

export function resolveWcdbConfigHelper(): string | null {
  if (isMacNativeRuntimeUnavailable()) return null
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  return findResource(`wcdb/macos/${arch}/tm-wcdb-config-helper`)
}

export function resolveWechatRuntimeDirectory(): string | null {
  if (!hasMacNativeBundle()) return null
  const manifest =
    findResource(`${RUNTIME_RELATIVE}/runtime-manifest.json`) ||
    (!app.isPackaged ? findResource('runtime/darwin-arm64/runtime-manifest.json') : null)
  return manifest ? path.dirname(manifest) : null
}

export function resolveWechatHost(): string | null {
  const directory = resolveWechatRuntimeDirectory()
  if (!directory) return null
  const candidate = path.join(directory, 'tm-wechat-host')
  return fs.existsSync(candidate) ? candidate : null
}

export function resolveWechatDylib(): string | null {
  const directory = resolveWechatRuntimeDirectory()
  if (!directory) return null
  const candidate = path.join(directory, 'libtmwechat.dylib')
  return fs.existsSync(candidate) ? candidate : null
}

export function resolveWechatRuntimeManifest(): string | null {
  const directory = resolveWechatRuntimeDirectory()
  if (!directory) return null
  const candidate = path.join(directory, 'runtime-manifest.json')
  return fs.existsSync(candidate) ? candidate : null
}
