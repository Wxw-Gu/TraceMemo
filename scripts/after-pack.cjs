/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { chmodSync, existsSync, renameSync } = require('node:fs')
const { execFileSync } = require('node:child_process')
const path = require('node:path')
const asar = require('@electron/asar')

const COMPATIBILITY_NAME = 'Electron'
const HELPER_SUFFIXES = ['', ' (Plugin)', ' (Renderer)', ' (GPU)']
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

function validateAsarRuntimeDependencies(runtimeResources) {
  const asarPath = path.join(runtimeResources, 'app.asar')
  if (!existsSync(asarPath)) throw new Error(`Missing packaged application archive: ${asarPath}`)

  const entries = new Set(asar.listPackage(asarPath))
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

function setPlistValue(plistPath, key, value) {
  execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plistPath])
}

exports.default = async function afterPack(context) {
  const runtimeResources = getRuntimeResources(context)
  validateAsarRuntimeDependencies(runtimeResources)
  validateSilkWasmRuntime(runtimeResources)
  const ffmpegPath = validateFfmpegRuntime(runtimeResources, context.electronPlatformName)

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

  if (context.electronPlatformName !== 'darwin') return

  const productName = context.packager.appInfo.productFilename
  const appPath = path.join(context.appOutDir, `${productName}.app`)
  const contentsPath = path.join(appPath, 'Contents')
  const sourceExecutable = path.join(contentsPath, 'MacOS', productName)
  const targetExecutable = path.join(contentsPath, 'MacOS', COMPATIBILITY_NAME)

  if (existsSync(sourceExecutable)) renameSync(sourceExecutable, targetExecutable)
  if (!existsSync(targetExecutable)) {
    throw new Error(`Missing Electron main executable: ${sourceExecutable}`)
  }

  const appPlistPath = path.join(contentsPath, 'Info.plist')
  setPlistValue(appPlistPath, 'CFBundleExecutable', COMPATIBILITY_NAME)
  setPlistValue(appPlistPath, 'CFBundleName', COMPATIBILITY_NAME)

  const frameworksPath = path.join(contentsPath, 'Frameworks')

  for (const suffix of HELPER_SUFFIXES) {
    const sourceName = `${productName} Helper${suffix}`
    const targetName = `${COMPATIBILITY_NAME} Helper${suffix}`
    const sourceBundle = path.join(frameworksPath, `${sourceName}.app`)
    const targetBundle = path.join(frameworksPath, `${targetName}.app`)

    if (existsSync(sourceBundle)) renameSync(sourceBundle, targetBundle)
    if (!existsSync(targetBundle)) {
      throw new Error(`Missing Electron helper bundle: ${sourceBundle}`)
    }

    const sourceExecutable = path.join(targetBundle, 'Contents', 'MacOS', sourceName)
    const targetExecutable = path.join(targetBundle, 'Contents', 'MacOS', targetName)
    if (existsSync(sourceExecutable)) renameSync(sourceExecutable, targetExecutable)
    if (!existsSync(targetExecutable)) {
      throw new Error(`Missing Electron helper executable: ${sourceExecutable}`)
    }

    const plistPath = path.join(targetBundle, 'Contents', 'Info.plist')
    setPlistValue(plistPath, 'CFBundleExecutable', targetName)
    setPlistValue(plistPath, 'CFBundleName', targetName)
  }
}

exports.getRuntimeResources = getRuntimeResources
exports.validateAsarRuntimeDependencies = validateAsarRuntimeDependencies
exports.validateFfmpegRuntime = validateFfmpegRuntime
exports.validateSilkWasmRuntime = validateSilkWasmRuntime
