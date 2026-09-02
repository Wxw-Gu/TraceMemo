/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { chmodSync, existsSync } = require('node:fs')
const { execFileSync } = require('node:child_process')
const path = require('node:path')
const asar = require('@electron/asar')

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

function normalizeBuilderArch(arch) {
  if (typeof arch === 'string') return arch
  return { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }[arch] || String(arch)
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

exports.default = async function afterPack(context) {
  const runtimeResources = getRuntimeResources(context)
  validateAsarRuntimeDependencies(runtimeResources)
  validateReaderSkillRuntime(runtimeResources)
  validateSilkWasmRuntime(runtimeResources)
  const ffmpegPath = validateFfmpegRuntime(runtimeResources, context.electronPlatformName)
  validateSherpaRuntime(
    runtimeResources,
    context.electronPlatformName,
    normalizeBuilderArch(context.arch)
  )

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
