const { cpSync, existsSync, renameSync, rmSync } = require('node:fs')
const { execFileSync } = require('node:child_process')
const { listPackage } = require('@electron/asar')
const path = require('node:path')

const COMPATIBILITY_NAME = 'Electron'
const HELPER_SUFFIXES = ['', ' (Plugin)', ' (Renderer)', ' (GPU)']
const REQUIRED_RUNTIME_PACKAGES = [
  '@electron-toolkit/preload',
  '@electron-toolkit/utils',
  'electron-updater',
  'ffmpeg-static',
  'fs-extra',
  'jsonrepair',
  'koffi'
]

function setPlistValue(plistPath, key, value) {
  execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plistPath])
}

function validateRuntimeDependencies(runtimeResources) {
  const appAsar = path.join(runtimeResources, 'app.asar')
  if (!existsSync(appAsar)) throw new Error(`Missing packaged application archive: ${appAsar}`)

  const packagedFiles = new Set(listPackage(appAsar))
  const missingPackages = REQUIRED_RUNTIME_PACKAGES.filter(
    (packageName) => !packagedFiles.has(`/node_modules/${packageName}/package.json`)
  )
  if (missingPackages.length > 0) {
    throw new Error(
      `Missing packaged runtime dependencies: ${missingPackages.join(', ')}. ` +
        'Install dependencies with the repository node-linker setting before packaging.'
    )
  }
}

exports.default = async function afterPack(context) {
  const productName = context.packager.appInfo.productFilename
  const runtimeResources =
    context.electronPlatformName === 'darwin'
      ? path.join(context.appOutDir, `${productName}.app`, 'Contents', 'Resources')
      : path.join(context.appOutDir, 'resources')
  const silkWasmSource = path.join(context.packager.projectDir, 'node_modules', 'silk-wasm')
  const silkWasmTarget = path.join(
    runtimeResources,
    'app.asar.unpacked',
    'node_modules',
    'silk-wasm'
  )
  if (!existsSync(silkWasmSource)) {
    throw new Error(`Missing silk-wasm dependency: ${silkWasmSource}`)
  }
  rmSync(silkWasmTarget, { recursive: true, force: true })
  cpSync(silkWasmSource, silkWasmTarget, { recursive: true, dereference: true })
  const silkWasm = path.join(silkWasmTarget, 'lib', 'silk.wasm')
  if (!existsSync(silkWasm)) {
    throw new Error(`Missing unpacked silk-wasm runtime: ${silkWasm}`)
  }
  validateRuntimeDependencies(runtimeResources)
  const ffmpegName = context.electronPlatformName === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const ffmpegPath = path.join(
    runtimeResources,
    'app.asar.unpacked',
    'node_modules',
    'ffmpeg-static',
    ffmpegName
  )
  if (!existsSync(ffmpegPath)) throw new Error(`Missing unpacked ffmpeg runtime: ${ffmpegPath}`)

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
