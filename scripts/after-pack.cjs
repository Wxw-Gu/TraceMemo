/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { chmodSync, existsSync, readdirSync, rmSync } = require('node:fs')
const { execFileSync } = require('node:child_process')
const path = require('node:path')
const asar = require('@electron/asar')
const { readBinaryArchitectures } = require('./binary-arch.cjs')

const REQUIRED_RUNTIME_PACKAGES = [
  '@electron-toolkit/preload',
  '@electron-toolkit/utils',
  'archiver',
  'electron-updater',
  'ffmpeg-static',
  'fs-extra',
  'jsonrepair',
  'koffi'
]

function getRuntimeResources(context) {
  const productName = context.packager.appInfo.productFilename
  return context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${productName}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources')
}

function validateSilkWasmRuntime(runtimeResources) {
  const packagePath = path.join(runtimeResources, 'app.asar.unpacked', 'node_modules', 'silk-wasm')
  const requiredFiles = [
    path.join(packagePath, 'package.json'),
    path.join(packagePath, 'lib', 'index.cjs'),
    path.join(packagePath, 'lib', 'silk.wasm')
  ]
  const missingFiles = requiredFiles.filter((filePath) => !existsSync(filePath))
  if (missingFiles.length > 0) {
    throw new Error(`Missing unpacked silk-wasm runtime: ${missingFiles.join(', ')}`)
  }
}

function validateFfmpegRuntime(runtimeResources, platform = process.platform) {
  const executable = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const ffmpegPath = path.join(
    runtimeResources,
    'app.asar.unpacked',
    'node_modules',
    'ffmpeg-static',
    executable
  )
  if (!existsSync(ffmpegPath)) {
    throw new Error(`Missing unpacked ffmpeg-static runtime: ${ffmpegPath}`)
  }
  if (platform !== 'win32') chmodSync(ffmpegPath, 0o755)
  return ffmpegPath
}

function validateSherpaRuntime(runtimeResources, platform, arch) {
  const platformName = platform === 'win32' ? 'win' : platform
  const basePath = path.join(
    runtimeResources,
    'app.asar.unpacked',
    'node_modules',
    'sherpa-onnx-node'
  )
  const nativePath = path.join(
    runtimeResources,
    'app.asar.unpacked',
    'node_modules',
    `sherpa-onnx-${platformName}-${arch}`
  )
  const requiredFiles = [
    path.join(basePath, 'package.json'),
    path.join(basePath, 'sherpa-onnx.js'),
    path.join(nativePath, 'package.json'),
    path.join(nativePath, 'sherpa-onnx.node')
  ]
  const missingFiles = requiredFiles.filter((filePath) => !existsSync(filePath))
  if (missingFiles.length > 0) {
    throw new Error(`Missing unpacked sherpa-onnx runtime: ${missingFiles.join(', ')}`)
  }
}

/**
 * System OCR 用 native package（@napi-rs/system-ocr）。它是 external + asarUnpack，
 * 打包后必须以 unpacked 形式存在，否则运行时会 MODULE_NOT_FOUND / native binding missing。
 * 本轮只有 Windows 是 supported target，所以只在 Windows 上做硬校验。
 */
function systemOcrTarget(platform, arch) {
  return platform === 'win32' ? `${platform}-${arch}-msvc` : `${platform}-${arch}`
}

function validateSystemOcrRuntime(runtimeResources, platform, arch) {
  if (platform !== 'win32') return
  const target = systemOcrTarget(platform, arch)
  const basePath = path.join(
    runtimeResources,
    'app.asar.unpacked',
    'node_modules',
    '@napi-rs',
    'system-ocr'
  )
  const nativePath = path.join(
    runtimeResources,
    'app.asar.unpacked',
    'node_modules',
    '@napi-rs',
    `system-ocr-${target}`
  )
  const requiredFiles = [
    path.join(basePath, 'package.json'),
    path.join(basePath, 'index.js'),
    path.join(nativePath, 'package.json'),
    path.join(nativePath, `system-ocr.${target}.node`)
  ]
  const missingFiles = requiredFiles.filter((filePath) => !existsSync(filePath))
  if (missingFiles.length > 0) {
    throw new Error(`Missing unpacked System OCR runtime: ${missingFiles.join(', ')}`)
  }
}

function normalizeBuilderArch(arch) {
  if (typeof arch === 'string') return arch
  return { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }[arch] || String(arch)
}

/**
 * A foreign-architecture binary only fails once the user touches the feature
 * that needs it, so verify the ones whose filename is shared across
 * architectures (ffmpeg-static keeps a single "ffmpeg" per platform) and fail
 * the build instead of shipping a broken bundle.
 */
function validateRuntimeBinaryArchitecture(filePath, platform, arch, label) {
  if (platform !== 'darwin' && platform !== 'win32') return
  if (arch === 'universal') return
  const architectures = readBinaryArchitectures(filePath)
  if (!architectures.length || architectures.includes(arch)) return
  throw new Error(
    `${label} is ${architectures.join('/')} but this bundle targets ${arch}: ${filePath}`
  )
}

/**
 * The Intel Mac key helper is an x86_64 executable that only the x64 (or
 * universal) macOS bundle can run. Every other target — Apple Silicon macOS,
 * Windows, Linux — would otherwise ship a ~34MB binary it can never execute,
 * so it is dropped from those bundles. x64/universal builds fail fast instead
 * of silently shipping an Intel Mac app that cannot read keys.
 */
function pruneIntelMacKeyTool(runtimeResources, platform, arch) {
  const keyToolDirectory = path.join(runtimeResources, 'resources', 'macos-key-tool')
  const usable = platform === 'darwin' && (arch === 'x64' || arch === 'universal')
  if (!usable) {
    rmSync(keyToolDirectory, { recursive: true, force: true })
    return null
  }
  const helperPath = path.join(keyToolDirectory, 'intel_mac_key_helper')
  if (!existsSync(helperPath)) {
    throw new Error(`Missing Intel Mac key helper in a ${arch} bundle: ${helperPath}`)
  }
  return helperPath
}

function validateAsarRuntimeDependencies(runtimeResources) {
  const asarPath = path.join(runtimeResources, 'app.asar')
  if (!existsSync(asarPath)) throw new Error(`Missing packaged application archive: ${asarPath}`)

  // @electron/asar returns platform-native separators. Normalize to POSIX
  // paths so validation behaves consistently on Windows and macOS/Linux.
  const entries = new Set(asar.listPackage(asarPath).map((entry) => entry.replaceAll('\\', '/')))
  const missingPackages = REQUIRED_RUNTIME_PACKAGES.filter(
    (packageName) => !entries.has(`/node_modules/${packageName}/package.json`)
  )
  if (missingPackages.length > 0) {
    throw new Error(
      `Missing packaged runtime dependencies: ${missingPackages.join(', ')}. ` +
        'Use pnpm 7.33.7 so electron-builder can read pnpm-lock.yaml.'
    )
  }
}
function validateReaderSkillRuntime(runtimeResources) {
  const skillPath = path.join(runtimeResources, 'skill', 'tracememo-reader', 'SKILL.md')
  if (!existsSync(skillPath)) {
    throw new Error(`Missing bundled TraceMemo Reader Skill: ${skillPath}`)
  }
  return skillPath
}

/**
 * Native runtime packages are published once per platform-arch pair, and pnpm
 * installs all of them, so every bundle ends up carrying the native libraries
 * of every platform (measured: ~129MB of speech models plus ~16MB of koffi).
 * The loaders pick their package from process.platform/arch, so the siblings
 * are dead weight — drop them.
 */
// 每个条目返回 platform package 的**完整后缀**（不含 package 前缀与连字符）。
const NATIVE_RUNTIME_PACKAGES = [
  {
    modules: [],
    prefix: 'sherpa-onnx',
    platformName: (platform, arch) => `${platform === 'win32' ? 'win' : platform}-${arch}`
  },
  {
    modules: ['@koromix'],
    prefix: 'koffi',
    platformName: (platform, arch) => `${platform}-${arch}`
  },
  {
    // @napi-rs 的 platform package 目录名带 -msvc 后缀（win32-x64-msvc）。
    modules: ['@napi-rs'],
    prefix: 'system-ocr',
    platformName: (platform, arch) => systemOcrTarget(platform, arch),
    foreignPattern: /^system-ocr-[a-z0-9]+-(arm64|x64|ia32|loong64|riscv64)(-msvc)?$/
  }
]

function pruneForeignArchNativeRuntimes(runtimeResources, platform, arch) {
  if (arch === 'universal') return []
  const unpackedRoot = path.join(runtimeResources, 'app.asar.unpacked', 'node_modules')
  if (!existsSync(unpackedRoot)) return []
  const removed = []
  for (const runtime of NATIVE_RUNTIME_PACKAGES) {
    const modulesRoot = path.join(unpackedRoot, ...runtime.modules)
    if (!existsSync(modulesRoot)) continue
    const expected = `${runtime.prefix}-${runtime.platformName(platform, arch)}`
    const foreign =
      runtime.foreignPattern ||
      new RegExp(`^${runtime.prefix}-[a-z0-9]+-(arm64|x64|ia32|loong64|riscv64)$`)
    for (const entry of readdirSync(modulesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === expected || !foreign.test(entry.name)) continue
      rmSync(path.join(modulesRoot, entry.name), { recursive: true, force: true })
      removed.push(runtime.modules.length ? `${runtime.modules.join('/')}/${entry.name}` : entry.name)
    }
  }
  return removed
}

/**
 * Bundled native directories under resources/connectors are named
 * "<platform>-<arch>". Cross-building both macOS architectures leaves both on
 * disk, but a bundle can only execute its own, so drop the foreign ones
 * instead of shipping every connector twice.
 */
function pruneForeignArchConnectors(runtimeResources, platform, arch) {
  if (arch === 'universal') return []
  const connectorsRoot = path.join(runtimeResources, 'resources', 'connectors')
  if (!existsSync(connectorsRoot)) return []
  const expected = `${platform}-${arch}`
  const removed = []
  for (const packageEntry of readdirSync(connectorsRoot, { withFileTypes: true })) {
    if (!packageEntry.isDirectory()) continue
    const packageRoot = path.join(connectorsRoot, packageEntry.name)
    for (const targetEntry of readdirSync(packageRoot, { withFileTypes: true })) {
      if (!targetEntry.isDirectory() || targetEntry.name === expected) continue
      if (!/^[a-z0-9]+-(arm64|x64|ia32)$/.test(targetEntry.name)) continue
      rmSync(path.join(packageRoot, targetEntry.name), { recursive: true, force: true })
      removed.push(`${packageEntry.name}/${targetEntry.name}`)
    }
  }
  return removed
}

exports.default = async function afterPack(context) {
  const runtimeResources = getRuntimeResources(context)
  const arch = normalizeBuilderArch(context.arch)
  validateAsarRuntimeDependencies(runtimeResources)
  validateReaderSkillRuntime(runtimeResources)
  validateSilkWasmRuntime(runtimeResources)
  const ffmpegPath = validateFfmpegRuntime(runtimeResources, context.electronPlatformName)
  validateRuntimeBinaryArchitecture(
    ffmpegPath,
    context.electronPlatformName,
    arch,
    'Bundled ffmpeg'
  )
  validateSherpaRuntime(runtimeResources, context.electronPlatformName, arch)
  validateSystemOcrRuntime(runtimeResources, context.electronPlatformName, arch)
  pruneIntelMacKeyTool(runtimeResources, context.electronPlatformName, arch)
  pruneForeignArchConnectors(runtimeResources, context.electronPlatformName, arch)
  pruneForeignArchNativeRuntimes(runtimeResources, context.electronPlatformName, arch)

  if (context.electronPlatformName === 'darwin') {
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', ffmpegPath], {
      stdio: 'ignore'
    })
  }

  if (context.electronPlatformName === 'win32') {
    const koffiNative = path.join(
      context.appOutDir,
      'resources',
      'app.asar.unpacked',
      'node_modules',
      '@koromix',
      'koffi-win32-x64',
      'win32_x64',
      'koffi.node'
    )
    if (!existsSync(koffiNative)) {
      throw new Error(`Missing Windows Koffi native module: ${koffiNative}`)
    }
    return
  }

}

exports.getRuntimeResources = getRuntimeResources
exports.validateAsarRuntimeDependencies = validateAsarRuntimeDependencies
exports.validateReaderSkillRuntime = validateReaderSkillRuntime
exports.validateFfmpegRuntime = validateFfmpegRuntime
exports.validateSilkWasmRuntime = validateSilkWasmRuntime
exports.validateSherpaRuntime = validateSherpaRuntime
exports.validateSystemOcrRuntime = validateSystemOcrRuntime
exports.pruneIntelMacKeyTool = pruneIntelMacKeyTool
exports.pruneForeignArchConnectors = pruneForeignArchConnectors
exports.pruneForeignArchNativeRuntimes = pruneForeignArchNativeRuntimes
exports.validateRuntimeBinaryArchitecture = validateRuntimeBinaryArchitecture
