#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
/** 把官方模板打成确定性 ZIP 并生成索引；手写 ZIP 才能固定时间戳、权限与条目顺序。 */
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const crypto = require('node:crypto')

const ROOT = path.resolve(__dirname, '..')
const SOURCE_ROOT = path.join(ROOT, 'examples', 'extensions')
const OUTPUT_DIR = path.join(ROOT, 'build', 'extension-templates')
const LOCK_FILE = path.join(SOURCE_ROOT, 'template-lock.json')

/** 模板白名单：只有显式登记的目录才进包，避免新增目录被静默发布。 */
const TEMPLATE_SPECS = [
  {
    id: 'keyword-bot',
    dir: 'keyword-bot',
    requires: {
      python: false,
      chrome: false,
      externalScript: false
    },
    platforms: ['darwin', 'win32']
  },
  {
    id: 'group-chat-bot',
    dir: 'group-chat-bot',
    requires: {
      python: false,
      chrome: false,
      externalScript: false
    },
    platforms: ['darwin', 'win32']
  },
  {
    id: 'douyin-sender',
    dir: 'douyin-sender',
    requires: {
      python: { required: true, minVersion: '3.10', reason: '解析与下载依赖本机 Python 脚本' },
      chrome: { required: true, reason: '解析脚本通过本机 Chrome 读取页面' },
      externalScript: {
        required: true,
        path: 'scripts/douyin.py',
        reason: '解析脚本不随应用分发，需用户自行提供后才能处理视频'
      }
    },
    platforms: ['darwin', 'win32']
  }
]

/** 与安装器保持同一套路径规则：任何一段越界或不合法都会让安装失败。 */
const SAFE_SEGMENT = /^[A-Za-z0-9._@+\- ]+$/
const RESERVED_SEGMENT = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i

const EXCLUDED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  'tests',
  'coverage'
])
const EXCLUDED_FILES = new Set(['.DS_Store', 'Thumbs.db'])
/** 即使本机存在也不进包：来源与分发许可未确认，或属于本机私有脚本。 */
const EXCLUDED_RELATIVE_PATHS = new Set(['scripts/douyin.py', 'lib/bot-engine.js'])
const EXCLUDED_EXTENSIONS = new Set(['.pyc', '.log', '.env', '.local'])

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function isSafeRelativePath(value) {
  if (typeof value !== 'string' || !value || value.length > 240) return false
  if (value.includes('\0')) return false
  const segments = value.split('/')
  if (segments.length > 10) return false
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') return false
    if (segment.length > 64) return false
    if (!SAFE_SEGMENT.test(segment)) return false
    if (/[. ]$/.test(segment)) return false
    if (RESERVED_SEGMENT.test(segment)) return false
  }
  return true
}

/** 收集模板文件。 */
function collectTemplateFiles(spec, sourceRoot = SOURCE_ROOT) {
  const root = path.join(sourceRoot, spec.dir)
  if (!fs.existsSync(root)) {
    throw new Error(`模板目录不存在：${spec.dir}`)
  }
  const files = []
  const walk = (directory, prefix) => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) {
        throw new Error(`模板目录不能包含符号链接：${prefix}${entry.name}`)
      }
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.has(entry.name)) continue
        walk(path.join(directory, entry.name), `${prefix}${entry.name}/`)
        continue
      }
      if (!entry.isFile()) continue
      if (EXCLUDED_FILES.has(entry.name)) continue
      if (EXCLUDED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue
      const relative = `${prefix}${entry.name}`
      if (EXCLUDED_RELATIVE_PATHS.has(relative)) continue
      if (!isSafeRelativePath(relative)) {
        throw new Error(`模板内文件路径不合法：${spec.dir}/${relative}`)
      }
      files.push({ path: relative, data: fs.readFileSync(path.join(directory, entry.name)) })
    }
  }
  walk(root, '')
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

function validateManifest(spec, files) {
  const manifestFile = files.find((file) => file.path === 'manifest.json')
  if (!manifestFile) throw new Error(`模板 ${spec.id} 缺少 manifest.json`)
  let manifest
  try {
    manifest = JSON.parse(manifestFile.data.toString('utf8'))
  } catch {
    throw new Error(`模板 ${spec.id} 的 manifest.json 不是合法 JSON`)
  }
  const idPattern =
    /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?)+$/
  if (manifest.manifestVersion !== 1) throw new Error(`模板 ${spec.id} 的 manifestVersion 必须是 1`)
  if (!idPattern.test(String(manifest.id || ''))) {
    throw new Error(`模板 ${spec.id} 的 id 不是反向域名格式`)
  }
  if (
    !/^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.-]{1,40})?$/.test(String(manifest.version || ''))
  ) {
    throw new Error(`模板 ${spec.id} 的 version 不是 x.y.z 格式`)
  }
  const names = new Set(files.map((file) => file.path))
  const entrypoints = manifest.entrypoints || {}
  for (const [key, value] of Object.entries(entrypoints)) {
    if (!value) continue
    if (!names.has(value)) {
      throw new Error(`模板 ${spec.id} 的入口 ${key} 指向不存在的文件：${value}`)
    }
  }
  if (!entrypoints.page && !entrypoints.background) {
    throw new Error(`模板 ${spec.id} 至少需要一个页面或后台入口`)
  }
  return manifest
}

/** 固定时间戳（1980-01-01 00:00）与权限，保证相同内容得到相同字节。 */
const DOS_TIME = 0
const DOS_DATE = 0x21

function buildZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8')
    const data = entry.data
    const compressed = zlib.deflateRawSync(data, { level: 9 })
    const checksum = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 文件名
    local.writeUInt16LE(8, 8) // deflate
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += local.length + name.length + compressed.length
  }

  const centralBuffer = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuffer, end])
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function readLock(lockFile = LOCK_FILE) {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return { version: 1, templates: {} }
    return { version: 1, templates: parsed.templates || {} }
  } catch {
    return { version: 1, templates: {} }
  }
}

function writeLock(lock, lockFile = LOCK_FILE) {
  const sorted = { version: 1, templates: {} }
  for (const key of Object.keys(lock.templates).sort()) {
    sorted.templates[key] = lock.templates[key]
  }
  fs.writeFileSync(lockFile, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8')
}

/** 构建入口。 */
function buildTemplates(options = {}) {
  const updateLock = options.updateLock === true
  const checkOnly = options.check === true
  const sourceRoot = options.sourceRoot || SOURCE_ROOT
  const outputDir = options.outputDir || OUTPUT_DIR
  const lockFile = options.lockFile || LOCK_FILE
  const specs = options.specs || TEMPLATE_SPECS
  const lock = readLock(lockFile)
  const templates = []
  const warnings = []
  const seenIds = new Set()
  const seenTemplateIds = new Set()

  for (const spec of specs) {
    if (seenTemplateIds.has(spec.id)) {
      throw new Error(`模板 id 重复：${spec.id}`)
    }
    seenTemplateIds.add(spec.id)

    const files = collectTemplateFiles(spec, sourceRoot)
    if (!files.length) throw new Error(`模板 ${spec.id} 没有任何文件`)
    const manifest = validateManifest(spec, files)
    if (seenIds.has(manifest.id)) {
      throw new Error(`模板扩展 id 重复：${manifest.id}`)
    }
    seenIds.add(manifest.id)

    const zip = buildZip(files)
    const digest = sha256(zip)
    const fileName = `${spec.id}-${manifest.version}.zip`
    const lockKey = `${spec.id}@${manifest.version}`
    const previous = lock.templates[lockKey]

    if (previous && previous.sha256 !== digest && !updateLock) {
      throw new Error(
        `模板 ${spec.id} 的版本仍为 ${manifest.version}，但内容已变化。` +
          `请升级 manifest.version，或确认后用 --update-lock 更新基线。`
      )
    }
    if (!previous) {
      // 新版本（或首次构建）：允许，并把基线更新到当前内容。
      lock.templates[lockKey] = { sha256: digest, bytes: zip.length }
    } else if (updateLock) {
      lock.templates[lockKey] = { sha256: digest, bytes: zip.length }
    }

    // 缺少外部脚本的模板必须显式标记，不能对外宣称开箱即用。
    const externalScript = spec.requires.externalScript
    if (externalScript && externalScript.required) {
      const present = files.some((file) => file.path === externalScript.path)
      if (present) {
        warnings.push(
          `模板 ${spec.id} 的依赖脚本 ${externalScript.path} 意外进入了发布包，请检查排除规则`
        )
      }
    }

    templates.push({
      templateId: spec.id,
      extensionId: manifest.id,
      name: String(manifest.name || spec.id),
      version: String(manifest.version),
      ...(manifest.description ? { description: String(manifest.description) } : {}),
      permissions: Array.isArray(manifest.permissions) ? manifest.permissions : [],
      file: fileName,
      sha256: digest,
      bytes: zip.length,
      fileCount: files.length,
      platforms: spec.platforms,
      requires: spec.requires,
      zip
    })
  }

  if (!checkOnly) {
    fs.mkdirSync(outputDir, { recursive: true })
    // 删掉不属于本次产物的旧 ZIP，避免「旧版本文件还在、索引却指向新版本」。
    const keep = new Set(templates.map((template) => template.file))
    for (const name of fs.readdirSync(outputDir)) {
      if (!name.endsWith('.zip')) continue
      if (keep.has(name)) continue
      fs.unlinkSync(path.join(outputDir, name))
    }
    for (const template of templates) {
      fs.writeFileSync(path.join(outputDir, template.file), template.zip)
    }
    const index = {
      version: 1,
      templates: templates.map((template) => {
        const copy = { ...template }
        delete copy.zip
        return copy
      })
    }
    fs.writeFileSync(
      path.join(outputDir, 'index.json'),
      `${JSON.stringify(index, null, 2)}\n`,
      'utf8'
    )
    writeLock(lock, lockFile)
  }

  return {
    templates: templates.map((template) => {
      const copy = { ...template }
      delete copy.zip
      return copy
    }),
    warnings
  }
}

function main() {
  const argv = process.argv.slice(2)
  const updateLock = argv.includes('--update-lock')
  const checkOnly = argv.includes('--check')
  try {
    const result = buildTemplates({ updateLock, checkOnly })
    for (const template of result.templates) {
      console.log(
        `[templates] ${template.templateId} ${template.version} ` +
          `${template.fileCount} files ${(template.bytes / 1024).toFixed(1)}KB ${template.sha256.slice(0, 12)}`
      )
    }
    for (const warning of result.warnings) {
      console.error(`[templates] WARN ${warning}`)
    }
    console.log(`[templates] 输出目录 ${path.relative(ROOT, OUTPUT_DIR)}`)
  } catch (error) {
    console.error(`[templates] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

if (require.main === module) main()

module.exports = {
  buildTemplates,
  buildZip,
  collectTemplateFiles,
  TEMPLATE_SPECS,
  OUTPUT_DIR,
  LOCK_FILE
}
