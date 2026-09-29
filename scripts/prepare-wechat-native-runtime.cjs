#!/usr/bin/env node

/* eslint-disable @typescript-eslint/explicit-function-return-type */
/* eslint-disable @typescript-eslint/no-require-imports */
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const REQUIRED_FILES = ['tm-wechat-host', 'libtmwechat.dylib', 'runtime-manifest.json']

function parseArgs(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--source' || value === '--target') {
      if (!argv[index + 1]) throw new Error(`${value} requires a path`)
      result[value.slice(2)] = argv[index + 1]
      index += 1
    } else {
      throw new Error(`Unknown option: ${value}`)
    }
  }
  return result
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function listFiles(root) {
  const files = []
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(absolute)
      else if (entry.isFile()) files.push(path.relative(root, absolute))
    }
  }
  visit(root)
  return files.sort()
}

function assertMachOArm64(filePath, label) {
  const buffer = fs.readFileSync(filePath)
  if (buffer.length < 8 || buffer.readUInt32LE(0) !== 0xfeedfacf) {
    throw new Error(`${label} is not a 64-bit Mach-O binary: ${filePath}`)
  }
  if (buffer.readUInt32LE(4) !== 0x0100000c) {
    throw new Error(`${label} is not arm64: ${filePath}`)
  }
}

function readAndValidateArtifact(sourceDir) {
  if (!fs.existsSync(sourceDir)) {
    throw new Error('native runtime artifact not found: build the macOS runtime artifact first')
  }

  const actualFiles = listFiles(sourceDir)
  const expectedFiles = [...REQUIRED_FILES].sort()
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(`native runtime artifact has an unexpected tree: ${actualFiles.join(', ')}`)
  }

  const manifestPath = path.join(sourceDir, 'runtime-manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (manifest.runtime !== 'tm-wechat-native') throw new Error('Unexpected runtime name')
  if (manifest.platform !== 'darwin-arm64') throw new Error('Runtime platform must be darwin-arm64')
  if (manifest.architecture !== 'arm64') throw new Error('Runtime architecture must be arm64')
  if (manifest.protocolVersion !== 1) throw new Error('Unsupported runtime protocolVersion')
  if (!/^[a-f0-9]{64}$/.test(manifest.tmSendSourceSha256 || '')) {
    throw new Error('Runtime manifest has no valid tmSendSourceSha256')
  }
  if (!/^[a-f0-9]{64}$/.test(manifest.addressProfileSha256 || '')) {
    throw new Error('Runtime manifest has no valid addressProfileSha256')
  }
  const capabilities = new Set(manifest.capabilities || [])
  for (const capability of ['text', 'image', 'voice']) {
    if (!capabilities.has(capability)) throw new Error(`Runtime capability missing: ${capability}`)
  }
  if (
    !Array.isArray(manifest.supportedWechatVersions) ||
    manifest.supportedWechatVersions.length === 0
  ) {
    throw new Error('Runtime manifest has no supportedWechatVersions')
  }

  for (const relative of REQUIRED_FILES) {
    const absolute = path.join(sourceDir, relative)
    if (!fs.statSync(absolute).isFile()) throw new Error(`Runtime file missing: ${relative}`)
  }
  const hostPath = path.join(sourceDir, 'tm-wechat-host')
  const dylibPath = path.join(sourceDir, 'libtmwechat.dylib')
  assertMachOArm64(hostPath, 'tm-wechat-host')
  assertMachOArm64(dylibPath, 'libtmwechat.dylib')
  if (!fs.readFileSync(dylibPath).includes(Buffer.from(manifest.tmSendSourceSha256, 'utf8'))) {
    throw new Error('Embedded agent hash is not present in libtmwechat.dylib')
  }
  if (!fs.readFileSync(dylibPath).includes(Buffer.from(manifest.addressProfileSha256, 'utf8'))) {
    throw new Error('Embedded address profile hash is not present in libtmwechat.dylib')
  }

  return {
    manifest,
    hashes: Object.fromEntries(
      REQUIRED_FILES.map((file) => [file, sha256(path.join(sourceDir, file))])
    )
  }
}

function syncArtifact(sourceDir, targetDir) {
  const source = readAndValidateArtifact(sourceDir)
  const parent = path.dirname(targetDir)
  const name = path.basename(targetDir)
  const staging = path.join(parent, `.${name}.prepare-${process.pid}`)
  const backup = path.join(parent, `.${name}.backup-${process.pid}`)

  fs.mkdirSync(parent, { recursive: true })
  fs.rmSync(staging, { recursive: true, force: true })
  fs.rmSync(backup, { recursive: true, force: true })
  fs.mkdirSync(staging, { recursive: true })

  try {
    for (const relative of REQUIRED_FILES) {
      const destination = path.join(staging, relative)
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      fs.copyFileSync(path.join(sourceDir, relative), destination)
    }
    fs.chmodSync(path.join(staging, 'tm-wechat-host'), 0o755)

    const staged = readAndValidateArtifact(staging)
    for (const relative of REQUIRED_FILES) {
      if (source.hashes[relative] !== staged.hashes[relative]) {
        throw new Error(`Packaged runtime hash mismatch: ${relative}`)
      }
    }

    if (fs.existsSync(targetDir)) fs.renameSync(targetDir, backup)
    try {
      fs.renameSync(staging, targetDir)
    } catch (error) {
      if (fs.existsSync(backup)) fs.renameSync(backup, targetDir)
      throw error
    }
    fs.rmSync(backup, { recursive: true, force: true })
    return staged
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}

function resolveSource(explicit) {
  if (explicit) return path.resolve(explicit)
  const fromEnv = String(process.env.TM_NATIVE_RUNTIME_DIR || '').trim()
  if (fromEnv) return path.resolve(fromEnv)
  // 本机路径写在这里即可，该文件不进仓库。
  const localConfig = path.join(__dirname, '..', '.native-runtime-source')
  if (fs.existsSync(localConfig)) {
    const configured = fs.readFileSync(localConfig, 'utf8').trim()
    if (configured) return path.resolve(configured)
  }
  throw new Error(
    'runtime artifact source is required: pass --source <dir>, set TM_NATIVE_RUNTIME_DIR, ' +
      'or write the path into .native-runtime-source'
  )
}

function main() {
  const projectRoot = path.resolve(__dirname, '..')
  const args = parseArgs(process.argv.slice(2))
  const sourceDir = resolveSource(args.source)
  const targetDir = path.resolve(
    args.target || path.join(projectRoot, 'resources', 'runtime', 'darwin-arm64')
  )
  const result = syncArtifact(sourceDir, targetDir)
  console.log(`[prepare-wechat-native] source: ${sourceDir}`)
  console.log(`[prepare-wechat-native] target: ${targetDir}`)
  console.log(
    `[prepare-wechat-native] runtime: ${result.manifest.runtime}/${result.manifest.version}`
  )
  console.log(`[prepare-wechat-native] agent: ${result.manifest.tmSendSourceSha256}`)
  console.log(`[prepare-wechat-native] address profile: ${result.manifest.addressProfileSha256}`)
  console.log('[prepare-wechat-native] files: 3')
}

module.exports = {
  REQUIRED_FILES,
  assertMachOArm64,
  readAndValidateArtifact,
  syncArtifact
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(
      `[prepare-wechat-native] ${error instanceof Error ? error.message : String(error)}`
    )
    process.exitCode = 1
  }
}
