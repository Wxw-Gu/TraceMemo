const { existsSync, renameSync } = require('node:fs')
const { execFileSync } = require('node:child_process')
const path = require('node:path')

const COMPATIBILITY_NAME = 'Electron'
const HELPER_SUFFIXES = ['', ' (Plugin)', ' (Renderer)', ' (GPU)']

function setPlistValue(plistPath, key, value) {
  execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plistPath])
}

exports.default = async function afterPack(context) {
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
