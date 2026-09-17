import { createRequire } from 'module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { afterAll, describe, expect, it } from 'vitest'

const nodeRequire = createRequire(import.meta.url)
const asar = nodeRequire('@electron/asar') as {
  createPackage: (source: string, destination: string) => Promise<void>
}
const { hasWindowsSherpaRuntime } = nodeRequire('../../scripts/prepare-win-runtime.cjs') as {
  hasWindowsSherpaRuntime: (runtimeRoot: string) => boolean
}
const {
  validateAsarRuntimeDependencies,
  validateFfmpegRuntime,
  validateReaderSkillRuntime,
  validateSherpaRuntime,
  validateSilkWasmRuntime
} = nodeRequire('../../scripts/after-pack.cjs') as {
  validateAsarRuntimeDependencies: (runtimeResources: string) => void
  validateFfmpegRuntime: (runtimeResources: string, platform?: NodeJS.Platform) => void
  validateReaderSkillRuntime: (runtimeResources: string) => string
  validateSherpaRuntime: (runtimeResources: string, platform: NodeJS.Platform, arch: string) => void
  validateSilkWasmRuntime: (runtimeResources: string) => void
}
const root = mkdtempSync(join(tmpdir(), 'wxe-runtime-package-'))

const {
  pruneIntelMacKeyTool,
  pruneForeignArchConnectors,
  pruneForeignArchNativeRuntimes,
  validateRuntimeBinaryArchitecture
} = nodeRequire('../../scripts/after-pack.cjs') as {
  pruneIntelMacKeyTool: (
    runtimeResources: string,
    platform: NodeJS.Platform,
    arch: string
  ) => string | null
  pruneForeignArchConnectors: (
    runtimeResources: string,
    platform: NodeJS.Platform,
    arch: string
  ) => string[]
  pruneForeignArchNativeRuntimes: (
    runtimeResources: string,
    platform: NodeJS.Platform,
    arch: string
  ) => string[]
  validateRuntimeBinaryArchitecture: (
    filePath: string,
    platform: NodeJS.Platform,
    arch: string,
    label: string
  ) => void
}
const { readBinaryArchitectures } = nodeRequire('../../scripts/binary-arch.cjs') as {
  readBinaryArchitectures: (filePath: string) => string[]
}

const CPU_TYPE_X86_64 = 0x01000007
const CPU_TYPE_ARM64 = 0x0100000c

function writeThinMachO(filePath: string, cpuType: number): void {
  const buffer = Buffer.alloc(32)
  buffer.writeUInt32LE(0xfeedfacf, 0)
  buffer.writeUInt32LE(cpuType, 4)
  writeFileSync(filePath, buffer)
}

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

  it('requires the bundled Reader Skill declared by extraResources', () => {
    const resources = join(root, 'reader-skill-resources')
    const skillPath = join(resources, 'skill', 'tracememo-reader', 'SKILL.md')
    const config = readFileSync(resolve(__dirname, '../../electron-builder.yml'), 'utf8')

    expect(config).toContain('docs/skill/tracememo-reader')
    expect(config).toContain('to: skill/tracememo-reader')
    expect(() => validateReaderSkillRuntime(resources)).toThrow(
      /Missing bundled TraceMemo Reader Skill/
    )

    mkdirSync(dirname(skillPath), { recursive: true })
    writeFileSync(skillPath, '# TraceMemo Reader\n')
    expect(validateReaderSkillRuntime(resources)).toBe(skillPath)
  })

  it('keeps silk-wasm in electron-builder asarUnpack', () => {
    const config = readFileSync(resolve(__dirname, '../../electron-builder.yml'), 'utf8')
    expect(config).toContain('node_modules/silk-wasm/**')
  })

  it('uses a Windows x64-only resource set', () => {
    const config = readFileSync(resolve(__dirname, '../../electron-builder.win.yml'), 'utf8')
    expect(config).toContain('key/win32/x64/**')
    expect(config).toContain('wcdb/win32/x64/**')
    expect(config).toContain('electronLanguages:')
    expect(config).not.toContain('win32-arm64')
    expect(config).not.toContain('macos/')
  })

  it('installs cross-platform optional dependencies before Windows packaging', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(__dirname, '../../package.json'), 'utf8')
    ) as { scripts: Record<string, string> }

    expect(packageJson.scripts['prepare:win-runtime']).toBe(
      'node scripts/prepare-win-runtime.cjs && npm run prepare:ffmpeg:win'
    )
    expect(packageJson.scripts['build:win']).toContain('npm run prepare:win-runtime')
    expect(packageJson.scripts['release:win']).toContain('npm run prepare:win-runtime')
  })

  it('detects an incomplete Windows sherpa runtime before invoking pnpm', () => {
    const runtimeRoot = join(root, 'win-sherpa-runtime')
    mkdirSync(runtimeRoot, { recursive: true })
    expect(hasWindowsSherpaRuntime(runtimeRoot)).toBe(false)

    writeFileSync(join(runtimeRoot, 'package.json'), '{}')
    expect(hasWindowsSherpaRuntime(runtimeRoot)).toBe(false)

    writeFileSync(join(runtimeRoot, 'sherpa-onnx.node'), 'fixture')
    expect(hasWindowsSherpaRuntime(runtimeRoot)).toBe(true)
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

  it('accepts runtime dependencies when asar uses Windows path separators', async () => {
    const resources = join(root, 'asar-complete-resources')
    const source = join(root, 'asar-complete-source')
    const packages = [
      '@electron-toolkit/preload',
      '@electron-toolkit/utils',
      'archiver',
      'electron-updater',
      'ffmpeg-static',
      'fs-extra',
      'jsonrepair',
      'koffi'
    ]
    for (const packageName of packages) {
      const packagePath = join(source, 'node_modules', ...packageName.split('/'))
      mkdirSync(packagePath, { recursive: true })
      writeFileSync(join(packagePath, 'package.json'), '{}')
    }
    mkdirSync(resources, { recursive: true })
    await asar.createPackage(source, join(resources, 'app.asar'))

    expect(() => validateAsarRuntimeDependencies(resources)).not.toThrow()
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

describe('per-architecture macOS packaging', () => {
  const archRoot = mkdtempSync(join(tmpdir(), 'wxe-runtime-arch-'))
  afterAll(() => rmSync(archRoot, { recursive: true, force: true }))

  it('reads architectures out of Mach-O and PE binaries', () => {
    const x64 = join(archRoot, 'fixture-x64')
    const arm64 = join(archRoot, 'fixture-arm64')
    writeThinMachO(x64, CPU_TYPE_X86_64)
    writeThinMachO(arm64, CPU_TYPE_ARM64)

    expect(readBinaryArchitectures(x64)).toEqual(['x64'])
    expect(readBinaryArchitectures(arm64)).toEqual(['arm64'])
    expect(readBinaryArchitectures(resolve(__dirname, 'runtime-packaging.test.ts'))).toEqual([])
  })

  it('keeps the Intel Mac key helper only in x64 macOS bundles', () => {
    const resources = join(archRoot, 'key-tool', 'Contents', 'Resources')
    const keyToolDirectory = join(resources, 'resources', 'macos-key-tool')
    const helper = join(keyToolDirectory, 'intel_mac_key_helper')
    mkdirSync(keyToolDirectory, { recursive: true })
    writeFileSync(helper, 'fixture')

    expect(pruneIntelMacKeyTool(resources, 'darwin', 'x64')).toBe(helper)
    expect(existsSync(helper)).toBe(true)

    expect(pruneIntelMacKeyTool(resources, 'darwin', 'arm64')).toBeNull()
    expect(existsSync(keyToolDirectory)).toBe(false)
  })

  it('fails an x64 bundle that lost the Intel Mac key helper', () => {
    const resources = join(archRoot, 'key-tool-missing', 'Contents', 'Resources')
    mkdirSync(resources, { recursive: true })

    expect(() => pruneIntelMacKeyTool(resources, 'darwin', 'x64')).toThrow(/macos-key-tool/)
    expect(pruneIntelMacKeyTool(resources, 'win32', 'x64')).toBeNull()
  })

  it('drops bundled connectors built for another architecture', () => {
    const resources = join(archRoot, 'connectors', 'Contents', 'Resources')
    const foreign = join(resources, 'resources', 'connectors', 'wechat', 'darwin-arm64')
    const matching = join(resources, 'resources', 'connectors', 'wechat', 'darwin-x64')
    mkdirSync(foreign, { recursive: true })
    mkdirSync(matching, { recursive: true })

    expect(pruneForeignArchConnectors(resources, 'darwin', 'x64')).toEqual(['wechat/darwin-arm64'])
    expect(existsSync(foreign)).toBe(false)
    expect(existsSync(matching)).toBe(true)

    expect(pruneForeignArchConnectors(resources, 'darwin', 'universal')).toEqual([])
    expect(existsSync(matching)).toBe(true)
  })

  it('drops native runtime packages built for other platforms', () => {
    const resources = join(archRoot, 'native-runtimes', 'Contents', 'Resources')
    const modules = join(resources, 'app.asar.unpacked', 'node_modules')
    for (const name of [
      'sherpa-onnx-darwin-x64',
      'sherpa-onnx-darwin-arm64',
      'sherpa-onnx-linux-x64',
      'sherpa-onnx-node'
    ]) {
      mkdirSync(join(modules, name), { recursive: true })
    }
    for (const name of ['koffi-darwin-x64', 'koffi-win32-x64']) {
      mkdirSync(join(modules, '@koromix', name), { recursive: true })
    }

    expect(pruneForeignArchNativeRuntimes(resources, 'darwin', 'x64').sort()).toEqual([
      '@koromix/koffi-win32-x64',
      'sherpa-onnx-darwin-arm64',
      'sherpa-onnx-linux-x64'
    ])
    expect(existsSync(join(modules, 'sherpa-onnx-darwin-x64'))).toBe(true)
    expect(existsSync(join(modules, 'sherpa-onnx-node'))).toBe(true)
    expect(existsSync(join(modules, '@koromix', 'koffi-darwin-x64'))).toBe(true)
    expect(existsSync(join(modules, '@koromix', 'koffi-win32-x64'))).toBe(false)

    expect(pruneForeignArchNativeRuntimes(resources, 'darwin', 'universal')).toEqual([])
    expect(existsSync(join(modules, 'sherpa-onnx-darwin-x64'))).toBe(true)
  })

  it('rejects a bundled binary built for another architecture', () => {
    const binary = join(archRoot, 'bundled-arm64')
    writeThinMachO(binary, CPU_TYPE_ARM64)

    expect(() =>
      validateRuntimeBinaryArchitecture(binary, 'darwin', 'x64', 'Bundled ffmpeg')
    ).toThrow(/arm64 but this bundle targets x64/)
    expect(() =>
      validateRuntimeBinaryArchitecture(binary, 'darwin', 'arm64', 'Bundled ffmpeg')
    ).not.toThrow()
  })
})

describe('release publishing policy', () => {
  it('uploads GitHub releases as drafts until the notes are reviewed', () => {
    for (const configFile of ['electron-builder.yml', 'electron-builder.win.yml']) {
      const config = readFileSync(resolve(__dirname, `../../${configFile}`), 'utf8')
      expect(config).toContain('releaseType: draft')
      expect(config).not.toContain('releaseType: release')
    }
  })
})
