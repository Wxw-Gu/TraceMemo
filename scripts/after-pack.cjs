/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { chmodSync, existsSync, readFileSync, readdirSync, rmSync } = require('node:fs')
const { createHash } = require('node:crypto')
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
const MACOS_EDITION_CODE_PATHS = [
  ['wcdb', 'macos', 'arm64', 'libwcdb_api.dylib'],
  ['wcdb', 'macos', 'arm64', 'libWCDB.dylib'],
  ['wcdb', 'macos', 'arm64', 'tm-wcdb-config-helper'],
  ['runtime', 'darwin-arm64', 'tm-wechat-host'],
  ['runtime', 'darwin-arm64', 'libtmwechat.dylib']
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

function validateFfmpegRuntime(
  runtimeResources,
  platform = process.platform,
  edition = process.env.TRACEMEMO_EDITION
) {
  if (platform === 'darwin' && edition) {
    const editionFfmpeg = path.join(runtimeResources, 'resources', 'ffmpeg', 'ffmpeg')
    if (!existsSync(editionFfmpeg)) throw new Error(`Missing staged macOS ffmpeg: ${editionFfmpeg}`)
    const sharedBinary = path.join(
      runtimeResources,
      'app.asar.unpacked',
      'node_modules',
      'ffmpeg-static',
      'ffmpeg'
    )
    rmSync(sharedBinary, { force: true })
    chmodSync(editionFfmpeg, 0o755)
    return editionFfmpeg
  }
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

function validateMacEditionResources(runtimeResources, edition, platform) {
  if (platform !== 'darwin') return
  const resources = path.join(runtimeResources, 'resources')
  const markerPath = path.join(resources, 'tracememo-build.json')
  if (!existsSync(markerPath)) throw new Error(`Missing macOS edition marker: ${markerPath}`)
  const marker = JSON.parse(readFileSync(markerPath, 'utf8'))
  if (marker.profile !== edition) throw new Error(`Expected ${edition} bundle, found ${String(marker.profile)}`)
  const wcdb = path.join(resources, 'wcdb', 'macos', 'arm64')
  const api = path.join(wcdb, 'libwcdb_api.dylib')
  const companion = path.join(wcdb, 'libWCDB.dylib')
  const helper = path.join(wcdb, 'tm-wcdb-config-helper')
  const runtime = path.join(resources, 'runtime', 'darwin-arm64')
  const host = path.join(runtime, 'tm-wechat-host')
  const runtimeDylib = path.join(runtime, 'libtmwechat.dylib')
  const runtimeManifest = path.join(runtime, 'runtime-manifest.json')
  const nativeArtifacts = [helper, host, runtimeDylib, runtimeManifest]
  const presentNativeArtifacts = nativeArtifacts.filter(existsSync)
  if (edition === 'public' && presentNativeArtifacts.length) {
    throw new Error(`Public bundle contains native artifacts: ${presentNativeArtifacts.join(', ')}`)
  }
  if (edition === 'native' && presentNativeArtifacts.length !== nativeArtifacts.length) {
    throw new Error('Native bundle is missing WCDB helper or WeChat runtime files')
  }
  for (const protectedPath of [path.join(resources, '1.txt'), path.join(resources, 'runtime', 'runtime.zip')]) {
    if (existsSync(protectedPath)) throw new Error(`Protected file leaked into macOS bundle: ${protectedPath}`)
  }
  if (!existsSync(api) || !existsSync(companion)) throw new Error('macOS bundle is missing WCDB files')
  if (!readBinaryArchitectures(api).includes('arm64')) throw new Error('Bundled WCDB API is not arm64')
  if (!readBinaryArchitectures(companion).includes('arm64')) throw new Error('Bundled WCDB companion is not arm64')
  const apiDependencies = execFileSync('/usr/bin/otool', ['-L', api], { encoding: 'utf8' })
  if (!apiDependencies.includes('@loader_path/libWCDB.dylib')) {
    throw new Error('Bundled WCDB API is missing its @loader_path companion dependency')
  }
  const symbols = execFileSync('/usr/bin/nm', ['-gU', api], { encoding: 'utf8' })
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/).pop() || '')
    .map((symbol) => symbol.replace(/^_/, ''))
  const hasNativeAbi = symbols.some((symbol) => symbol.startsWith('wcdb_msg_insert_'))
  if ((edition === 'public' && hasNativeAbi) || (edition === 'native' && !hasNativeAbi)) {
    throw new Error(`Bundled WCDB API has the wrong ${edition} ABI`)
  }
  const nativeInput = marker.nativeInput || {}
  if (edition === 'public') {
    if (nativeInput.libwcdbApiSha256 && createHash('sha256').update(readFileSync(api)).digest('hex') !== nativeInput.libwcdbApiSha256) {
      throw new Error('Packaged public WCDB API does not match the recorded WCDB input hash')
    }
    if (nativeInput.libWCDBSha256 && createHash('sha256').update(readFileSync(companion)).digest('hex') !== nativeInput.libWCDBSha256) {
      throw new Error('Packaged public WCDB companion does not match the recorded WCDB input hash')
    }
  }
  const requiredSymbols = [
    'wcdb_get_messages',
    'wcdb_get_group_members_batch',
    'wcdb_start_monitor_pipe',
    ...(edition === 'native'
      ? [
          'wcdb_msg_insert_set_switch',
          'wcdb_msg_insert_get_switches',
          'wcdb_msg_insert_list_shard_catalog',
          'wcdb_msg_insert_ensure_rooms_rules',
          'wcdb_msg_insert_get_rooms_status',
          'wcdb_msg_insert_inspect_shard',
          'wcdb_msg_insert_insert_local_notice',
          'wcdb_msg_insert_insert_local_notice_ex',
          'wcdb_msg_insert_sync_display_names'
        ]
      : [])
  ]
  const missingSymbols = requiredSymbols.filter((symbol) => !symbols.includes(symbol))
  if (missingSymbols.length) throw new Error(`${edition} WCDB API is missing exports: ${missingSymbols.join(', ')}`)
  const ffmpeg = path.join(resources, 'ffmpeg', 'ffmpeg')
  if (!existsSync(ffmpeg) || !readBinaryArchitectures(ffmpeg).includes('arm64')) {
    throw new Error(`macOS arm64 FFmpeg is missing or wrong architecture: ${ffmpeg}`)
  }
  if (marker.ffmpegSha256 && createHash('sha256').update(readFileSync(ffmpeg)).digest('hex') !== marker.ffmpegSha256) {
    throw new Error('Packaged FFmpeg does not match its recorded staged hash')
  }
  for (const relative of [
    'licenses/ffmpeg-static/LICENSE',
    'licenses/ffmpeg-static/FFMPEG-LICENSE.txt',
    'licenses/ffmpeg-static/FFMPEG-BUILD-INFO.txt'
  ]) {
    if (!existsSync(path.join(resources, relative))) {
      throw new Error(`Missing FFmpeg license/build notice: ${relative}`)
    }
  }
  if (edition === 'native') {
    for (const binary of [helper, host, runtimeDylib]) {
      if (!readBinaryArchitectures(binary).includes('arm64')) {
        throw new Error(`Native binary lacks arm64 architecture: ${binary}`)
      }
    }
    const manifest = JSON.parse(readFileSync(runtimeManifest, 'utf8'))
    if (manifest.runtime !== 'tm-wechat-native') throw new Error('Runtime Manifest runtime name is invalid')
    if (manifest.platform !== 'darwin-arm64' || manifest.architecture !== 'arm64' || manifest.protocolVersion !== 1) {
      throw new Error('Runtime Manifest platform, architecture, or protocol is invalid')
    }
    for (const capability of ['text', 'image', 'voice']) {
      if (!Array.isArray(manifest.capabilities) || !manifest.capabilities.includes(capability)) {
        throw new Error(`Runtime Manifest is missing capability: ${capability}`)
      }
    }
    if (!Array.isArray(manifest.supportedWechatVersions) || manifest.supportedWechatVersions.length === 0) {
      throw new Error('Runtime Manifest has no supported WeChat versions')
    }
    const dylib = readFileSync(runtimeDylib)
    for (const key of ['tmSendSourceSha256', 'addressProfileSha256']) {
      if (!/^[a-f0-9]{64}$/.test(manifest[key] || '') || !dylib.includes(Buffer.from(manifest[key]))) {
        throw new Error(`Runtime embedded hash mismatch: ${key}`)
      }
    }
    if (!execFileSync('/usr/bin/otool', ['-L', helper], { encoding: 'utf8' }).includes('@loader_path/libwcdb_api.dylib')) {
      throw new Error('Native helper is missing its @loader_path WCDB API dependency')
    }
    const actualRuntimeManifest = JSON.parse(readFileSync(runtimeManifest, 'utf8'))
    if (actualRuntimeManifest.runtime !== 'tm-wechat-native' ||
      actualRuntimeManifest.platform !== 'darwin-arm64' ||
      actualRuntimeManifest.architecture !== 'arm64' ||
      actualRuntimeManifest.protocolVersion !== 1 ||
      !Array.isArray(actualRuntimeManifest.supportedWechatVersions) ||
      actualRuntimeManifest.supportedWechatVersions.length === 0) {
      throw new Error('Runtime Manifest failed application compatibility checks')
    }
    for (const key of ['tmSendSourceSha256', 'addressProfileSha256']) {
      if (!/^[a-f0-9]{64}$/.test(actualRuntimeManifest[key] || '')) {
        throw new Error(`Runtime Manifest has invalid ${key}`)
      }
    }
    const stagedFiles = marker.nativeInput?.files
    if (!Array.isArray(stagedFiles) || stagedFiles.length !== 6) {
      throw new Error('Native build marker is missing its source Bundle file hashes')
    }
    for (const entry of stagedFiles) {
      const remainder = entry.path.replace(/^tracememo\//, '')
      const relative = remainder.startsWith('runtime/')
        ? remainder.replace(/^runtime\//, 'runtime/darwin-arm64/')
        : path.join('wcdb', 'macos', 'arm64', remainder.replace(/^wcdb\//, ''))
      const binary = path.join(resources, relative)
      if (!existsSync(binary) || readFileSync(binary).length !== entry.bytes) {
        throw new Error(`Native packaged artifact size mismatch: ${entry.path}`)
      }
      const digest = createHash('sha256').update(readFileSync(binary)).digest('hex')
      if (digest !== entry.sha256) throw new Error(`Native packaged artifact SHA-256 mismatch: ${entry.path}`)
    }
  }
}

function validateMacEditionProtectedFiles(runtimeResources) {
  const asarPath = path.join(runtimeResources, 'app.asar')
  if (!existsSync(asarPath)) throw new Error(`Missing packaged application archive: ${asarPath}`)
  const entries = asar.listPackage(asarPath).map((entry) => entry.replaceAll('\\', '/'))
  const leaked = entries.filter((entry) =>
    /(^|\/)1\.txt$/i.test(entry) ||
    /(^|\/)runtime\.zip$/i.test(entry) ||
    /(^|\/)\.env(?:\.|$)/i.test(entry) ||
    /\.(?:db|sqlite)(?:3)?$/i.test(entry) ||
    /\.log$/i.test(entry)
  )
  if (leaked.length) throw new Error(`Sensitive file(s) leaked into app.asar: ${leaked.join(', ')}`)
  for (const relative of ['1.txt', 'runtime/runtime.zip']) {
    const candidate = path.join(runtimeResources, 'resources', relative)
    if (existsSync(candidate)) throw new Error(`Protected file leaked into packaged resources: ${candidate}`)
  }
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
  const paths = MACOS_HELPER_NAMES.map((name) => path.join(runtimeResources, 'resources', name))
  if (process.env.TRACEMEMO_EDITION) {
    paths.push(...MACOS_EDITION_CODE_PATHS.map((segments) => path.join(runtimeResources, 'resources', ...segments)))
  }
  return paths.filter((helperPath) => existsSync(helperPath))
}

function signMacosHelpers(runtimeResources, run = runCodesign) {
  const helperPaths = findMacosHelperPaths(runtimeResources)
  for (const helperPath of helperPaths) {
    if (!helperPath.endsWith('.dylib')) chmodSync(helperPath, 0o755)
    if (!isMacosCodeValid(helperPath, run)) {
      run(['--force', '--sign', '-', helperPath])
    }
    const architectures = readBinaryArchitectures(helperPath)
    if (architectures.length === 0 && process.env.TRACEMEMO_EDITION) {
      throw new Error(`macOS edition helper is not a supported Mach-O: ${helperPath}`)
    }
    const verificationArchitectures = architectures.length
      ? architectures.map((arch) => (arch === 'x64' ? 'x86_64' : arch))
      : ['arm64', 'x86_64']
    for (const arch of verificationArchitectures) {
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
  bundlesSendRuntime =
    process.env.TRACEMEMO_EDITION === 'native'
      ? true
      : process.env.TRACEMEMO_EDITION === 'public'
        ? false
        : isSendRuntimeBuild()
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
  if (context.electronPlatformName === 'darwin' && process.env.TRACEMEMO_EDITION) {
    validateMacEditionResources(runtimeResources, process.env.TRACEMEMO_EDITION, context.electronPlatformName)
    validateMacEditionProtectedFiles(runtimeResources)
    if (process.env.TRACEMEMO_EDITION === 'public' && sendRuntime) {
      throw new Error('Public edition unexpectedly includes a WeChat Runtime')
    }
    if (process.env.TRACEMEMO_EDITION === 'native' && !sendRuntime) {
      throw new Error('Native edition is missing its WeChat Runtime')
    }
    if (sendRuntime) {
      for (const runtimeFile of ['tm-wechat-host', 'libtmwechat.dylib', 'runtime-manifest.json']) {
        if (!existsSync(path.join(sendRuntime, runtimeFile))) {
        throw new Error(`Runtime file missing after packaging: ${runtimeFile}`)
        }
      }
    }
  }
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
exports.validateMacEditionResources = validateMacEditionResources
exports.validateMacEditionProtectedFiles = validateMacEditionProtectedFiles
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
