import { createRequire } from 'module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { afterAll, describe, expect, it } from 'vitest'

const nodeRequire = createRequire(import.meta.url)
const asar = nodeRequire('@electron/asar') as {
  createPackage: (source: string, destination: string) => Promise<void>
}
const { validateAsarRuntimeDependencies, validateFfmpegRuntime, validateSilkWasmRuntime } =
  nodeRequire('../../scripts/after-pack.cjs') as {
    validateAsarRuntimeDependencies: (runtimeResources: string) => void
    validateFfmpegRuntime: (runtimeResources: string, platform?: NodeJS.Platform) => void
    validateSilkWasmRuntime: (runtimeResources: string) => void
  }
const root = mkdtempSync(join(tmpdir(), 'wxe-runtime-package-'))

describe('production runtime packaging', () => {
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('requires the complete unpacked silk-wasm runtime', () => {
    const packagePath = join(root, 'resources', 'app.asar.unpacked', 'node_modules', 'silk-wasm')
    mkdirSync(join(packagePath, 'lib'), { recursive: true })
    writeFileSync(join(packagePath, 'package.json'), '{}')
    writeFileSync(join(packagePath, 'lib', 'index.cjs'), 'module.exports = {}')

    expect(() => validateSilkWasmRuntime(join(root, 'resources'))).toThrow(/silk\.wasm/)
    writeFileSync(join(packagePath, 'lib', 'silk.wasm'), Buffer.from([0, 97, 115, 109]))
    expect(() => validateSilkWasmRuntime(join(root, 'resources'))).not.toThrow()
  })

  it('keeps silk-wasm in electron-builder asarUnpack', () => {
    const config = readFileSync(resolve(__dirname, '../../electron-builder.yml'), 'utf8')
    expect(config).toContain('node_modules/silk-wasm/**')
  })

  it('rejects an app archive with missing runtime dependencies', async () => {
    const resources = join(root, 'asar-resources')
    const source = join(root, 'asar-source')
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, 'package.json'), '{}')
    mkdirSync(resources, { recursive: true })
    await asar.createPackage(source, join(resources, 'app.asar'))

    expect(() => validateAsarRuntimeDependencies(resources)).toThrow(
      /Missing packaged runtime dependencies:.*@electron-toolkit\/utils/
    )
  })

  it('requires and unpacks the bundled ffmpeg-static executable', () => {
    const resources = join(root, 'ffmpeg-resources')
    const ffmpegPath = join(
      resources,
      'app.asar.unpacked',
      'node_modules',
      'ffmpeg-static',
      'ffmpeg'
    )
    expect(() => validateFfmpegRuntime(resources, 'darwin')).toThrow(/ffmpeg-static/)
    mkdirSync(dirname(ffmpegPath), { recursive: true })
    writeFileSync(ffmpegPath, 'fixture')
    expect(() => validateFfmpegRuntime(resources, 'darwin')).not.toThrow()

    const config = readFileSync(resolve(__dirname, '../../electron-builder.yml'), 'utf8')
    expect(config).toContain('node_modules/ffmpeg-static/**')
  })
})
