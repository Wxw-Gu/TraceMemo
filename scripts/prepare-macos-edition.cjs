const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { createGunzip } = require('node:zlib')
const https = require('node:https')
const { pipeline } = require('node:stream/promises')
const { readBinaryArchitectures } = require('./binary-arch.cjs')

const ROOT = path.resolve(__dirname, '..')
const WCDB_DIST_ROOT = resolveWcdbDistRoot()
const NATIVE_DIST_ROOT = process.env.TRACEMEMO_NATIVE_DIST_ROOT ||
  path.resolve(ROOT, '..', 'native-runtime-dist')
const NATIVE_BUNDLE_ROOT = findNativeBundleRoot(NATIVE_DIST_ROOT)
const PUBLIC_FILES = [
  'icon.png',
  'trayTemplate.png',
  'trayTemplate@2x.png',
  'daily_report_templates.html',
  'mobile_daily_report.html',
  'mobile_daily_report_v1.html',
  'mobile_daily_report_v2.html',
  'xkey_helper',
  'xkey_helper_4_1_13'
]
const FFMPEG_LICENSE_FILES = [
  ['LICENSE', 'licenses/ffmpeg-static/LICENSE'],
  ['ffmpeg.LICENSE', 'licenses/ffmpeg-static/FFMPEG-LICENSE.txt'],
  ['ffmpeg.README', 'licenses/ffmpeg-static/FFMPEG-BUILD-INFO.txt']
]
const REQUIRED_NATIVE_SYMBOLS = [
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
const REQUIRED_PUBLIC_SYMBOLS = [
  'wcdb_get_messages',
  'wcdb_get_group_members_batch',
  'wcdb_start_monitor_pipe'
]
const PROTECTED_RESOURCE_PATHS = ['runtime/runtime.zip']

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function resolveWcdbDistRoot() {
  const configured = process.env.TRACEMEMO_WCDB_DIST_ROOT
  const candidates = [
    configured,
    path.resolve(ROOT, '..', 'wcdb-dist', 'build', 'macos-package-universal'),
    path.resolve(ROOT, '..', '..', 'workspace', 'wcdb-dist', 'build', 'macos-package-universal')
  ].filter(Boolean)
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0]
}

function findNativeBundleRoot(root) {
  if (!fs.existsSync(root)) return root
  const pending = [{ directory: root, depth: 0 }]
  while (pending.length) {
    const { directory, depth } = pending.shift()
    const manifest = path.join(directory, 'manifest.json')
    if (fs.existsSync(manifest)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'))
        if (parsed.platform === 'macos' && parsed.architecture === 'arm64' && Array.isArray(parsed.files)) {
          return directory
        }
      } catch {
        // Ignore unrelated manifests while locating the native runtime bundle.
      }
    }
    if (depth >= 3) continue
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) pending.push({ directory: path.join(directory, entry.name), depth: depth + 1 })
    }
  }
  return root
}

function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function binaryArchitectures(filePath) {
  return readBinaryArchitectures(filePath)
}

function exportedSymbols(filePath) {
  return run('/usr/bin/nm', ['-gU', filePath])
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/).pop())
    .filter(Boolean)
    .map((symbol) => symbol.replace(/^_/, ''))
}

function assertArm64(filePath, label) {
  if (!binaryArchitectures(filePath).includes('arm64')) {
    throw new Error(`${label} does not contain arm64: ${filePath}`)
  }
}

function validateWcdbPair(apiPath, dependencyPath, profile) {
  if (!fs.existsSync(apiPath) || !fs.existsSync(dependencyPath)) {
    throw new Error(`Missing ${profile} WCDB library pair: ${apiPath}`)
  }
  assertArm64(apiPath, `${profile} WCDB API`)
  assertArm64(dependencyPath, `${profile} WCDB companion`)
  const symbols = exportedSymbols(apiPath)
  const missing = (profile === 'public' ? REQUIRED_PUBLIC_SYMBOLS : REQUIRED_NATIVE_SYMBOLS).filter(
    (symbol) => !symbols.includes(symbol)
  )
  if (missing.length) throw new Error(`${profile} WCDB API is missing exports: ${missing.join(', ')}`)
  if (profile === 'public' && symbols.some((symbol) => symbol.startsWith('wcdb_msg_insert_'))) {
    throw new Error('Public WCDB API contains native message-insert exports')
  }
  const dependencies = run('/usr/bin/otool', ['-L', apiPath])
  if (!dependencies.includes('@loader_path/libWCDB.dylib')) {
    throw new Error(`${profile} WCDB API does not resolve libWCDB.dylib via @loader_path`)
  }
}

function readAndValidateNativeManifest(bundleRoot) {
  const manifestPath = path.join(bundleRoot, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (manifest.platform !== 'macos' || manifest.architecture !== 'arm64') {
    throw new Error('Native bundle manifest must target macos-arm64')
  }
  if (!Array.isArray(manifest.files) || manifest.files.length !== 6) {
    throw new Error('Native bundle manifest must list exactly six files')
  }
  const normalized = new Set()
  const listedNativePaths = new Set()
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== 'string' || !/^tracememo\/(runtime|wcdb)\//.test(entry.path)) {
      throw new Error('Native bundle manifest contains an unexpected resource path')
    }
    if (normalized.has(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256 || '')) {
      throw new Error(`Invalid native bundle manifest entry: ${String(entry.path)}`)
    }
    normalized.add(entry.path)
    const source = path.join(bundleRoot, entry.path)
    const stat = fs.statSync(source)
    if (!stat.isFile() || stat.size !== entry.bytes || sha256(source) !== entry.sha256) {
      throw new Error(`Native bundle manifest verification failed: ${entry.path}`)
    }
    listedNativePaths.add(entry.path)
    if (/\/runtime\/(tm-wechat-host|libtmwechat\.dylib)$/.test(entry.path)) {
      if (!binaryArchitectures(source).includes('arm64')) {
        throw new Error(`Native runtime binary is not arm64: ${entry.path}`)
      }
    }
    if (/\/wcdb\/(libwcdb_api\.dylib|tm-wcdb-config-helper)$/.test(entry.path)) {
      if (!binaryArchitectures(source).includes('arm64')) {
        throw new Error(`Native WCDB binary is not arm64: ${entry.path}`)
      }
    }
  }
  const expected = [
    'tracememo/runtime/libtmwechat.dylib',
    'tracememo/runtime/runtime-manifest.json',
    'tracememo/runtime/tm-wechat-host',
    'tracememo/wcdb/libWCDB.dylib',
    'tracememo/wcdb/libwcdb_api.dylib',
    'tracememo/wcdb/tm-wcdb-config-helper'
  ]
  if (expected.some((entry) => !normalized.has(entry))) {
    throw new Error('Native bundle manifest file list is incomplete')
  }
  if (listedNativePaths.size !== expected.length) throw new Error('Native bundle manifest has unexpected files')
  return { manifest, files: manifest.files }
}

function validateNativeBundle(bundleRoot, files) {
  const bySuffix = (suffix) => {
    const entry = files.find((file) => file.path.endsWith(suffix))
    if (!entry) throw new Error(`Missing native bundle manifest path: ${suffix}`)
    return path.join(bundleRoot, entry.path)
  }
  const api = bySuffix('/wcdb/libwcdb_api.dylib')
  const companion = bySuffix('/wcdb/libWCDB.dylib')
  const helper = bySuffix('/wcdb/tm-wcdb-config-helper')
  const host = bySuffix('/runtime/tm-wechat-host')
  const runtimeDylib = bySuffix('/runtime/libtmwechat.dylib')
  const runtimeManifestPath = bySuffix('/runtime/runtime-manifest.json')
  validateWcdbPair(api, companion, 'native')
  for (const [binary, label] of [[helper, 'WCDB helper'], [host, 'WeChat host'], [runtimeDylib, 'WeChat runtime']]) {
    assertArm64(binary, label)
  }
  if (!run('/usr/bin/otool', ['-L', helper]).includes('@loader_path/libwcdb_api.dylib')) {
    throw new Error('WCDB helper does not resolve its API dylib via @loader_path')
  }
  const bundleManifest = JSON.parse(fs.readFileSync(path.join(bundleRoot, 'manifest.json'), 'utf8'))
  const runtimeDependencies = run('/usr/bin/otool', ['-L', runtimeDylib])
  if (!bundleManifest.compatibility || bundleManifest.proWcdbAbiVersion !== 1) {
    throw new Error('Native bundle manifest does not declare the expected WCDB ABI')
  }
  const runtimeManifest = JSON.parse(fs.readFileSync(runtimeManifestPath, 'utf8'))
  if (runtimeManifest.platform !== 'darwin-arm64' || runtimeManifest.architecture !== 'arm64' || runtimeManifest.protocolVersion !== 1) {
    throw new Error('Runtime manifest platform, architecture, or protocol is invalid')
  }
  if (runtimeManifest.runtime !== 'tm-wechat-native') throw new Error('Runtime name is invalid')
  if (!Array.isArray(runtimeManifest.supportedWechatVersions) || runtimeManifest.supportedWechatVersions.length === 0) {
    throw new Error('Runtime manifest has no supported WeChat versions')
  }
  for (const capability of ['text', 'image', 'voice']) {
    if (!Array.isArray(runtimeManifest.capabilities) || !runtimeManifest.capabilities.includes(capability)) {
      throw new Error(`Runtime manifest is missing capability: ${capability}`)
    }
  }
  const runtimeBytes = fs.readFileSync(runtimeDylib)
  for (const key of ['tmSendSourceSha256', 'addressProfileSha256']) {
    if (!/^[a-f0-9]{64}$/.test(runtimeManifest[key] || '') || !runtimeBytes.includes(Buffer.from(runtimeManifest[key]))) {
      throw new Error(`Runtime dylib does not contain the manifest ${key}`)
    }
  }
  const apiDependencies = run('/usr/bin/otool', ['-L', api])
  if (!apiDependencies.includes('@loader_path/libWCDB.dylib')) throw new Error('WCDB companion dependency missing')
  if (!run('/usr/bin/otool', ['-L', host]).includes('libSystem')) {
    throw new Error('Host is missing its system runtime dependency')
  }
  if (runtimeDependencies.includes('@rpath/libtmwechat.dylib') && !runtimeDependencies.includes('/usr/lib/libSystem')) {
    throw new Error('Runtime dylib is missing required system dependencies')
  }
}

function assertStagingTargetDoesNotExist(stageRoot, outputRoot) {
  for (const target of [stageRoot, outputRoot]) {
    if (fs.existsSync(target)) throw new Error(`Refusing to overwrite existing build target: ${target}`)
  }
}

function copyPublicResources(sourceResources, destination) {
  for (const relative of PUBLIC_FILES) {
    const source = path.join(sourceResources, relative)
    if (!fs.existsSync(source)) throw new Error(`Missing public resource: ${source}`)
    fs.mkdirSync(path.dirname(path.join(destination, relative)), { recursive: true })
    fs.copyFileSync(source, path.join(destination, relative), fs.constants.COPYFILE_EXCL)
  }
}

function copyFfmpegLicenses(destination) {
  const packageRoot = path.dirname(require.resolve('ffmpeg-static/package.json'))
  for (const [sourceName, destinationRelative] of FFMPEG_LICENSE_FILES) {
    const source = path.join(packageRoot, sourceName)
    if (!fs.existsSync(source)) throw new Error(`Missing FFmpeg license/source notice: ${source}`)
    const target = path.join(destination, destinationRelative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL)
  }
}

function copyNative(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL)
}

async function downloadFfmpegArm64(destination) {
  const url = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-darwin-arm64.gz'
  const archivePath = `${destination}.gz`
  await new Promise((resolve, reject) => {
    const request = (target) => https.get(target, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume()
        request(response.headers.location)
        return
      }
      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error(`FFmpeg download failed with HTTP ${response.statusCode}`))
        return
      }
      const output = fs.createWriteStream(archivePath, { flags: 'wx' })
      pipeline(response, output).then(resolve, reject)
    })
    request(url).on('error', reject)
  })
  await pipeline(fs.createReadStream(archivePath), createGunzip(), fs.createWriteStream(destination, { flags: 'wx' }))
  fs.unlinkSync(archivePath)
  fs.chmodSync(destination, 0o755)
  assertArm64(destination, 'Staged FFmpeg')
}

async function prepareFfmpeg(stagedResources) {
  const destination = path.join(stagedResources, 'ffmpeg', 'ffmpeg')
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  const supplied = process.env.TRACEMEMO_FFMPEG_ARM64_PATH
  if (supplied) {
    assertArm64(supplied, 'Provided FFmpeg')
    copyNative(supplied, destination)
    fs.chmodSync(destination, 0o755)
    return sha256(destination)
  }
  await downloadFfmpegArm64(destination)
  return sha256(destination)
}

function assertNoProtectedInputs(root) {
  for (const relative of ['1.txt']) {
    if (fs.existsSync(path.join(ROOT, relative))) {
      throw new Error(`Protected file must not be used as a build input: ${relative}`)
    }
  }
  for (const relative of PROTECTED_RESOURCE_PATHS) {
    if (fs.existsSync(path.join(root, relative))) {
      throw new Error(`Protected file must not be used as a build input: ${relative}`)
    }
  }
}

async function prepareEdition(edition) {
  if (edition !== 'public' && edition !== 'native') throw new Error('Usage: prepare-macos-edition.cjs <public|native>')
  const stageRoot = path.join(ROOT, 'build', 'mac-staging', edition)
  const outputRoot = path.join(ROOT, 'dist', 'mac', edition)
  assertStagingTargetDoesNotExist(stageRoot, outputRoot)

  const sourceResources = path.join(ROOT, 'resources')
  assertNoProtectedInputs(sourceResources)
  fs.mkdirSync(path.dirname(stageRoot), { recursive: true })
  fs.mkdirSync(stageRoot)
  try {
  const stagedResources = path.join(stageRoot, 'resources')
  fs.mkdirSync(stagedResources, { recursive: true })
  copyPublicResources(sourceResources, stagedResources)
  copyFfmpegLicenses(stagedResources)
  const ffmpegSha256 = await prepareFfmpeg(stagedResources)

  const marker = { profile: edition, appVersion: require(path.join(ROOT, 'package.json')).version, ffmpegSha256 }
  if (edition === 'public') {
    const api = path.join(WCDB_DIST_ROOT, 'libwcdb_api.dylib')
    const companion = path.join(WCDB_DIST_ROOT, 'libWCDB.dylib')
    validateWcdbPair(api, companion, 'public')
    copyNative(api, path.join(stagedResources, 'wcdb', 'macos', 'arm64', 'libwcdb_api.dylib'))
    copyNative(companion, path.join(stagedResources, 'wcdb', 'macos', 'arm64', 'libWCDB.dylib'))
    marker.nativeInput = {
      source: path.relative(ROOT, WCDB_DIST_ROOT),
      libwcdbApiSha256: sha256(api),
      libWCDBSha256: sha256(companion)
    }
  } else {
    const { manifest, files } = readAndValidateNativeManifest(NATIVE_BUNDLE_ROOT)
    validateNativeBundle(NATIVE_BUNDLE_ROOT, files)
    for (const entry of files) {
      const remainder = entry.path.replace(/^tracememo\//, '')
      const relative = remainder.startsWith('runtime/')
        ? path.join(remainder.replace(/^runtime\//, 'runtime/darwin-arm64/'))
        : path.join('wcdb', 'macos', 'arm64', remainder.replace(/^wcdb\//, ''))
      copyNative(path.join(NATIVE_BUNDLE_ROOT, entry.path), path.join(stagedResources, relative))
    }
    marker.nativeInput = {
      bundleVersion: manifest.bundleVersion,
      manifestSha256: sha256(path.join(NATIVE_BUNDLE_ROOT, 'manifest.json')),
      files: files.map(({ path: relative, sha256: digest, bytes }) => ({ path: relative, sha256: digest, bytes }))
    }
  }

  for (const relative of ['1.txt', 'runtime/runtime.zip']) {
    if (fs.existsSync(path.join(stagedResources, relative))) {
      throw new Error(`Protected file leaked into ${edition} staging: ${relative}`)
    }
  }
  fs.writeFileSync(path.join(stagedResources, 'tracememo-build.json'), `${JSON.stringify(marker, null, 2)}\n`, { flag: 'wx' })
  console.log(`[prepare-macos-edition] ${edition} resources staged at ${stagedResources}`)
  } catch (error) {
    fs.rmSync(stageRoot, { recursive: true, force: true })
    throw error
  }
}

function validateStagedEdition(edition) {
  if (edition !== 'public' && edition !== 'native') throw new Error('Usage: validate staged edition <public|native>')
  const resources = path.join(ROOT, 'build', 'mac-staging', edition, 'resources')
  const markerPath = path.join(resources, 'tracememo-build.json')
  if (!fs.existsSync(markerPath)) throw new Error(`Missing staged edition marker: ${markerPath}`)
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'))
  if (marker.profile !== edition || marker.appVersion !== require(path.join(ROOT, 'package.json')).version) {
    throw new Error('Staged edition marker does not match the expected edition/version')
  }
  if (!/^[a-f0-9]{64}$/.test(marker.ffmpegSha256 || '')) throw new Error('Staged FFmpeg hash is invalid')
  const ffmpeg = path.join(resources, 'ffmpeg', 'ffmpeg')
  if (!fs.existsSync(ffmpeg) || sha256(ffmpeg) !== marker.ffmpegSha256) {
    throw new Error('Staged FFmpeg SHA-256 does not match the edition marker')
  }
  assertArm64(ffmpeg, 'Staged FFmpeg')
  const api = path.join(resources, 'wcdb', 'macos', 'arm64', 'libwcdb_api.dylib')
  const companion = path.join(resources, 'wcdb', 'macos', 'arm64', 'libWCDB.dylib')
  validateWcdbPair(api, companion, edition)
  if (marker.nativeInput?.libwcdbApiSha256 && sha256(api) !== marker.nativeInput.libwcdbApiSha256) {
    throw new Error('Staged public WCDB API does not match the recorded input hash')
  }
  if (marker.nativeInput?.libWCDBSha256 && sha256(companion) !== marker.nativeInput.libWCDBSha256) {
    throw new Error('Staged public WCDB companion does not match the recorded input hash')
  }
  if (edition === 'native') {
    const nativeManifest = marker.nativeInput?.files
    if (!Array.isArray(nativeManifest) || nativeManifest.length !== 6) {
      throw new Error('Staged native bundle is missing its verified source manifest')
    }
    for (const item of nativeManifest) {
      const relative = item.path.replace(/^tracememo\//, '')
      const stagedRelative = relative.startsWith('runtime/')
        ? relative.replace(/^runtime\//, 'runtime/darwin-arm64/')
        : path.join('wcdb', 'macos', 'arm64', relative.replace(/^wcdb\//, ''))
      const staged = path.join(resources, stagedRelative)
      if (!fs.existsSync(staged) || fs.statSync(staged).size !== item.bytes || sha256(staged) !== item.sha256) {
        throw new Error(`Staged native artifact hash mismatch: ${item.path}`)
      }
    }
  validateNativeBundleFromStaging(resources)
  }
  for (const relative of ['1.txt', 'runtime/runtime.zip']) {
    if (fs.existsSync(path.join(resources, relative))) throw new Error(`Protected file leaked into staging: ${relative}`)
  }
  return { edition, appVersion: marker.appVersion, apiSha256: sha256(api), companionSha256: sha256(companion), ffmpegSha256: sha256(ffmpeg) }
}

function validateNativeBundleFromStaging(resources) {
  const api = path.join(resources, 'wcdb', 'macos', 'arm64', 'libwcdb_api.dylib')
  const companion = path.join(resources, 'wcdb', 'macos', 'arm64', 'libWCDB.dylib')
  const helper = path.join(resources, 'wcdb', 'macos', 'arm64', 'tm-wcdb-config-helper')
  const host = path.join(resources, 'runtime', 'darwin-arm64', 'tm-wechat-host')
  const runtimeDylib = path.join(resources, 'runtime', 'darwin-arm64', 'libtmwechat.dylib')
  const runtimeManifestPath = path.join(resources, 'runtime', 'darwin-arm64', 'runtime-manifest.json')
  const symbols = exportedSymbols(api)
  const missing = REQUIRED_NATIVE_SYMBOLS.filter((symbol) => !symbols.includes(symbol))
  if (missing.length) throw new Error(`Staged native WCDB ABI is missing: ${missing.join(', ')}`)
  for (const [binary, label] of [[companion, 'WCDB companion'], [helper, 'WCDB helper'], [host, 'Host'], [runtimeDylib, 'Runtime dylib']]) {
    assertArm64(binary, label)
  }
  if (!run('/usr/bin/otool', ['-L', helper]).includes('@loader_path/libwcdb_api.dylib')) {
    throw new Error('Staged helper lost its @loader_path WCDB dependency')
  }
  const runtimeManifest = JSON.parse(fs.readFileSync(runtimeManifestPath, 'utf8'))
  const runtimeBytes = fs.readFileSync(runtimeDylib)
  if (runtimeManifest.runtime !== 'tm-wechat-native' || runtimeManifest.platform !== 'darwin-arm64' || runtimeManifest.architecture !== 'arm64' || runtimeManifest.protocolVersion !== 1) {
    throw new Error('Staged Runtime Manifest identity is invalid')
  }
  for (const key of ['tmSendSourceSha256', 'addressProfileSha256']) {
    if (!/^[a-f0-9]{64}$/.test(runtimeManifest[key] || '') || !runtimeBytes.includes(Buffer.from(runtimeManifest[key]))) {
      throw new Error(`Staged runtime hash verification failed: ${key}`)
    }
  }
}

if (require.main === module) {
  try {
  prepareEdition(process.argv[2]).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

module.exports = {
  assertNoProtectedInputs,
  assertStagingTargetDoesNotExist,
  copyPublicResources,
  copyFfmpegLicenses,
  downloadFfmpegArm64,
  prepareFfmpeg,
  prepareEdition,
  validateNativeBundleFromStaging,
  validateStagedEdition,
  readAndValidateNativeManifest,
  validateNativeBundle,
  validateWcdbPair
}
