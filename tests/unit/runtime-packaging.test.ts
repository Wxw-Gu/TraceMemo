import { createRequire } from 'module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { afterAll, describe, expect, it } from 'vitest'

const nodeRequire = createRequire(import.meta.url)
const { validateFfmpegRuntime, validateSherpaRuntime, validateSilkWasmRuntime } = nodeRequire(
  '../../scripts/after-pack.cjs'
) as {
  validateFfmpegRuntime: (runtimeResources: string, platform?: NodeJS.Platform) => void
  validateSherpaRuntime: (runtimeResources: string, platform: NodeJS.Platform, arch: string) => void
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

  it('requires the matching Windows and macOS sherpa native runtime', () => {
    const resources = join(root, 'sherpa-resources')
    const unpacked = join(resources, 'app.asar.unpacked', 'node_modules')
    const base = join(unpacked, 'sherpa-onnx-node')
    mkdirSync(base, { recursive: true })
    writeFileSync(join(base, 'package.json'), '{}')
    writeFileSync(join(base, 'sherpa-onnx.js'), 'module.exports = {}')

    expect(() => validateSherpaRuntime(resources, 'win32', 'x64')).toThrow(/win-x64/)
    const windows = join(unpacked, 'sherpa-onnx-win-x64')
    mkdirSync(windows, { recursive: true })
    writeFileSync(join(windows, 'package.json'), '{}')
    writeFileSync(join(windows, 'sherpa-onnx.node'), 'fixture')
    expect(() => validateSherpaRuntime(resources, 'win32', 'x64')).not.toThrow()

    expect(() => validateSherpaRuntime(resources, 'darwin', 'arm64')).toThrow(/darwin-arm64/)
    const mac = join(unpacked, 'sherpa-onnx-darwin-arm64')
    mkdirSync(mac, { recursive: true })
    writeFileSync(join(mac, 'package.json'), '{}')
    writeFileSync(join(mac, 'sherpa-onnx.node'), 'fixture')
    expect(() => validateSherpaRuntime(resources, 'darwin', 'arm64')).not.toThrow()

    const config = readFileSync(resolve(__dirname, '../../electron-builder.yml'), 'utf8')
    expect(config).toContain('node_modules/sherpa-onnx-node/**')
    expect(config).toContain('node_modules/sherpa-onnx-*/**')
  })
})
