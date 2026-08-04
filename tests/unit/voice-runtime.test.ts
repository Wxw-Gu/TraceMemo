import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const root = mkdtempSync(join(tmpdir(), 'wxe-voice-runtime-'))

vi.mock('electron', () => ({ app: { getAppPath: () => join(root, 'development-app') } }))
vi.mock('../../src/main/runtime-mode', () => ({ isPackagedRuntime: () => false }))
vi.mock('../../src/main/wcdb4-client', () => ({ Wcdb4Client: class {} }))

import {
  findSilkWasmRuntimeLocation,
  getSilkWasmRuntimeLocations
} from '../../src/main/voice-service'

function writeWasm(packagePath: string): void {
  mkdirSync(join(packagePath, 'lib'), { recursive: true })
  writeFileSync(join(packagePath, 'lib', 'silk.wasm'), Buffer.from([0, 97, 115, 109]))
}

describe('silk-wasm runtime discovery', () => {
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('prefers the unpacked package and still recognizes the legacy asar layout', () => {
    const resourcesPath = join(root, 'Resources')
    const appPath = join(resourcesPath, 'app.asar')
    const asarPackage = join(appPath, 'node_modules', 'silk-wasm')
    writeWasm(asarPackage)

    const locations = getSilkWasmRuntimeLocations({ packaged: true, resourcesPath, appPath })
    expect(findSilkWasmRuntimeLocation(locations)).toMatchObject({ source: 'asar' })

    writeWasm(join(resourcesPath, 'app.asar.unpacked', 'node_modules', 'silk-wasm'))
    expect(findSilkWasmRuntimeLocation(locations)).toMatchObject({ source: 'unpacked' })
  })

  it('uses the regular node_modules package in development', () => {
    const appPath = join(root, 'development-app')
    const locations = getSilkWasmRuntimeLocations({ packaged: false, appPath })

    expect(locations).toEqual([
      expect.objectContaining({
        source: 'development',
        packagePath: join(appPath, 'node_modules', 'silk-wasm')
      })
    ])
  })
})
