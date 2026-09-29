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

// electron-builder 26 skips macOS signing entirely when no Developer ID
// identity is configured, so an unpacked bundle can ship without a usable
// signature. macOS kills a helper whose code or signature is missing or
// modified even when SIP is disabled, which is what customers hit on newer
// macOS releases. Ad-hoc re-sign the runtime helpers and the outer bundle so
// every Mach-O verifies strictly; spctl still rejects ad-hoc code, which is
// acceptable for the SIP-disabled customer workflow.
const MACOS_HELPER_NAMES = ['xkey_helper', 'xkey_helper_4_1_13']

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
 * Windows 与 macOS 都是 supported target，都要做硬校验（Linux 不是）。
 */
function systemOcrTarget(platform, arch) {
  return platform === 'win32' ? `${platform}-${arch}-msvc` : `${platform}-${arch}`
}

function validateSystemOcrRuntime(runtimeResources, platform, arch) {
  if (platform !== 'win32' && platform !== 'darwin') return
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

/**
 * koffi 运行期按 `${process.platform}-${process.arch}` 拼出原生包目录名
 * （node_modules/koffi/src/koffi/index.cjs:153/175），找不到就直接抛
 * "Cannot find the native Koffi module; did you bundle it correctly?"。
 * pnpm 7 不支持 supportedArchitectures，会静默跳过外平台可选依赖，所以每个目标平台的
 * koffi 原生包都必须在 package.json 里显式声明；这里再兜一层，缺了就让构建失败，
 * 而不是发出一个装得上、却打不开 WCDB 的包。
 */
function koffiNativeTarget(platform, arch) {
  if (platform === 'win32') {
    return arch === 'x64'
      ? { label: 'Windows', segments: ['@koromix', 'koffi-win32-x64', 'win32_x64', 'koffi.node'] }
      : null
  }
  if (platform === 'darwin' && (arch === 'x64' || arch === 'arm64')) {
    return {
      label: 'macOS',
      segments: ['@koromix', `koffi-darwin-${arch}`, `darwin_${arch}`, 'koffi.node']
    }
  }
  return null
}

function validateKoffiRuntime(runtimeResources, platform, arch) {
  const target = koffiNativeTarget(platform, arch)
  if (!target) return
  const nativePath = path.join(
    runtimeResources,
    'app.asar.unpacked',
    'node_modules',
    ...target.segments
  )
  if (!existsSync(nativePath)) {
    throw new Error(`Missing ${target.label} Koffi native module: ${nativePath}`)
  }
}

function normalizeBuilderArch(arch) {
  if (typeof arch === 'string') return arch
  return { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }[arch] || String(arch)
}

function runCodesign(args) {
  try {
    execFileSync('/usr/bin/codesign', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (error) {
    const stderr =
      error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : ''
    if (stderr.trim() && error instanceof Error) {
      error.message += `\n${stderr.trim()}`
    }
    throw error
  }
}

function isMacosCodeValid(targetPath, run = runCodesign) {
  try {
    run(['--verify', '--strict', targetPath])
    return true
  } catch {
    return false
  }
}

function findMacosHelperPaths(runtimeResources) {
  return MACOS_HELPER_NAMES.map((name) => path.join(runtimeResources, 'resources', name)).filter(
    (helperPath) => existsSync(helperPath)
  )
}

function signMacosHelpers(runtimeResources, run = runCodesign) {
  const helperPaths = findMacosHelperPaths(runtimeResources)
  for (const helperPath of helperPaths) {
    chmodSync(helperPath, 0o755)
    if (!isMacosCodeValid(helperPath, run)) {
      run(['--force', '--sign', '-', helperPath])
    }
    for (const arch of ['arm64', 'x86_64']) {
      try {
        run(['--verify', '--strict', '--arch', arch, helperPath])
      } catch (error) {
        throw new Error(
          'macOS helper signature verification failed: ' +
            path.basename(helperPath) +
            ' (' +
            arch +
            ')',
          { cause: error }
        )
      }
    }
  }
  return helperPaths
}

/**
 * codesign 只把这些位置当作「嵌套代码」并要求它们先各自签好，才肯签外层 app。
 * 只遍历这一组根目录，而不是整个 bundle：Contents/Resources 下的
 * app.asar.unpacked 里成千上万个原生文件不属于嵌套代码，逐个签既慢又无意义。
 */
const MACOS_CODE_LOCATIONS = [
  'Frameworks',
  'MacOS',
  'PlugIns',
  'XPCServices',
  'Helpers',
  'Library/LoginItems'
]

function collectNestedMacosCode(dir, depth, targets) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name)
    // framework 里的 Mantle -> Versions/Current/Mantle 这类符号链接指向真实文件，
    // 真实文件会在更深的层级被走到；这里跳过以免重复签名。
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      if (/\.(app|framework|xpc)$/.test(entry.name)) {
        targets.push({ path: entryPath, depth, bundle: true })
      }
      collectNestedMacosCode(entryPath, depth + 1, targets)
      continue
    }
    if (!entry.isFile()) continue
    if (readBinaryArchitectures(entryPath).length === 0) continue
    targets.push({ path: entryPath, depth, bundle: false })
  }
}

/**
 * 返回嵌套代码的签名顺序：深度大的先签（framework 内部的 dylib、无扩展名的
 * crashpad handler 先于 framework 本身，helper 的可执行文件先于 helper app），
 * 同深度时文件先于 bundle。
 */
function findNestedMacosCodePaths(appBundlePath) {
  const targets = []
  for (const location of MACOS_CODE_LOCATIONS) {
    const root = path.join(appBundlePath, 'Contents', ...location.split('/'))
    if (existsSync(root)) collectNestedMacosCode(root, 1, targets)
  }
  return targets
    .map((target, index) => ({ ...target, index }))
    .sort((a, b) => {
      if (a.depth !== b.depth) return b.depth - a.depth
      if (a.bundle !== b.bundle) return a.bundle ? 1 : -1
      return a.index - b.index
    })
    .map((target) => target.path)
}

/**
 * Electron 43.1.0 的 darwin-x64 官方 zip（sha256 与上游 SHASUMS256.txt 一致）
 * 里所有嵌套 Mach-O 都是未签名状态，darwin-arm64 那份则是 linker-signed。
 * codesign 签外层 bundle 时要求子组件已签，否则直接报
 * "code object is not signed at all" + "In subcomponent: ..."，
 * 所以 x64 出包时只签外层必然失败，必须先由内向外补签一遍。
 *
 * 这里不采用 `--deep`（Apple 已标记 deprecated）：它会把外层的签名选项套用到
 * 所有子组件上，将来接上 Developer ID + entitlements 时会把 app 的 entitlements
 * 一并套到 helper 上，属于已知的坑。
 */
function signMacosAppBundle(appBundlePath, run = runCodesign) {
  if (isMacosCodeValid(appBundlePath, run)) return appBundlePath
  for (const nestedPath of findNestedMacosCodePaths(appBundlePath)) {
    try {
      run(['--force', '--sign', '-', nestedPath])
    } catch (error) {
      throw new Error(
        'macOS nested code signing failed: ' + path.relative(appBundlePath, nestedPath),
        { cause: error }
      )
    }
  }
  run(['--force', '--sign', '-', appBundlePath])
  try {
    run(['--verify', '--strict', appBundlePath])
  } catch (error) {
    throw new Error('macOS app bundle signature verification failed: ' + appBundlePath, {
      cause: error
    })
  }
  return appBundlePath
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
      removed.push(
        runtime.modules.length ? `${runtime.modules.join('/')}/${entry.name}` : entry.name
      )
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

/**
 * 微信发送运行时打包边界
 */
const SEND_RUNTIME_RELATIVE = ['resources', 'runtime', 'darwin-arm64']
const SEND_RUNTIME_ENTRY = 'tm-wechat-host'

function sendRuntimeLocations(runtimeResources) {
  return [
    path.join(runtimeResources, ...SEND_RUNTIME_RELATIVE),
    path.join(runtimeResources, 'app.asar.unpacked', ...SEND_RUNTIME_RELATIVE)
  ]
}

function findSendRuntime(runtimeResources) {
  return (
    sendRuntimeLocations(runtimeResources).find((directory) =>
      existsSync(path.join(directory, SEND_RUNTIME_ENTRY))
    ) || null
  )
}

function isSendRuntimeBuild() {
  return process.env.TM_SEND_RUNTIME_BUILD === '1'
}

function enforceSendRuntimeBoundary(
  runtimeResources,
  platform,
  bundlesSendRuntime = isSendRuntimeBuild()
) {
  if (platform !== 'darwin') return null
  const found = findSendRuntime(runtimeResources)
  if (bundlesSendRuntime) {
    if (!found) {
      throw new Error(
        'This macOS build requires the WeChat send runtime but resources/runtime/darwin-arm64 is missing. ' +
          'Run `pnpm prepare:wechat-native` first, or point TM_NATIVE_RUNTIME_DIR at the artifact.'
      )
    }
    return found
  }
  if (found) {
    throw new Error(
      'macOS bundle must not include the WeChat send runtime: ' +
        found +
        '. Build with `pnpm build:mac:arm64:send-runtime` (TM_SEND_RUNTIME_BUILD=1) when it is required, ' +
        'or fix the resources filter in electron-builder.yml.'
    )
  }
  return null
}

exports.default = async function afterPack(context) {
  const runtimeResources = getRuntimeResources(context)
  const arch = normalizeBuilderArch(context.arch)
  // 边界先判，越早失败越好。
  const sendRuntime = enforceSendRuntimeBoundary(runtimeResources, context.electronPlatformName)
  if (context.electronPlatformName === 'darwin') {
    console.log(
      sendRuntime
        ? `[afterPack] send runtime bundled at ${sendRuntime}`
        : '[afterPack] send runtime excluded'
    )
  }
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
  validateKoffiRuntime(runtimeResources, context.electronPlatformName, arch)
  pruneIntelMacKeyTool(runtimeResources, context.electronPlatformName, arch)
  pruneForeignArchConnectors(runtimeResources, context.electronPlatformName, arch)
  pruneForeignArchNativeRuntimes(runtimeResources, context.electronPlatformName, arch)

  if (context.electronPlatformName === 'darwin') {
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', ffmpegPath], {
      stdio: 'ignore'
    })
    signMacosHelpers(runtimeResources)
    const productName = context.packager.appInfo.productFilename
    signMacosAppBundle(path.join(context.appOutDir, productName + '.app'))
  }
}

exports.getRuntimeResources = getRuntimeResources
exports.validateAsarRuntimeDependencies = validateAsarRuntimeDependencies
exports.validateReaderSkillRuntime = validateReaderSkillRuntime
exports.validateFfmpegRuntime = validateFfmpegRuntime
exports.validateSilkWasmRuntime = validateSilkWasmRuntime
exports.validateSherpaRuntime = validateSherpaRuntime
exports.validateSystemOcrRuntime = validateSystemOcrRuntime
exports.validateKoffiRuntime = validateKoffiRuntime
exports.pruneIntelMacKeyTool = pruneIntelMacKeyTool
exports.pruneForeignArchConnectors = pruneForeignArchConnectors
exports.pruneForeignArchNativeRuntimes = pruneForeignArchNativeRuntimes
exports.validateRuntimeBinaryArchitecture = validateRuntimeBinaryArchitecture
exports.findMacosHelperPaths = findMacosHelperPaths
exports.isMacosCodeValid = isMacosCodeValid
exports.signMacosHelpers = signMacosHelpers
exports.signMacosAppBundle = signMacosAppBundle
exports.findNestedMacosCodePaths = findNestedMacosCodePaths
exports.sendRuntimeLocations = sendRuntimeLocations
exports.findSendRuntime = findSendRuntime
exports.enforceSendRuntimeBoundary = enforceSendRuntimeBoundary
