import crypto from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { Open } from 'unzipper'
import { parseFragment } from 'parse5'
import * as csstree from 'css-tree'
import { app } from 'electron'
import {
  DEFAULT_REPORT_TEMPLATE,
  REPORT_TEMPLATES,
  type ReportTemplateDefinition
} from '../shared/report-templates'
import {
  REPORT_TEMPLATE_ALLOWED_ASSET_EXTENSIONS,
  REPORT_TEMPLATE_ALLOWED_ATTRS,
  REPORT_TEMPLATE_ALLOWED_TAGS,
  REPORT_TEMPLATE_INTERFACE_VERSION,
  REPORT_TEMPLATE_LIMITS,
  REPORT_TEMPLATE_PACKAGE_PROTOCOL_VERSION,
  REPORT_TEMPLATE_PLACEHOLDERS,
  type InstalledReportTemplate,
  type ReportTemplateManifest,
  type ReportTemplateRef,
  ReportTemplateError
} from '../shared/report-template-package'

const INDEX_FILE = 'index.json'
const INSTALLED_DIR = 'installed'
const STAGING_DIR = 'staging'
const SAFE_ID = /^community\.github\.[a-z0-9][a-z0-9-]{0,38}\.[a-z0-9][a-z0-9-]{0,63}$/
const SAFE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/
const SAFE_RELATIVE_PATH = /^[^\\/][^:]*$/

interface TemplateIndex {
  version: 1
  templates: InstalledReportTemplate[]
}

interface EntryInfo {
  path: string
  type: 'file' | 'directory'
  size: number
  entry: Awaited<ReturnType<typeof Open.file>>['files'][number]
}

function rootPath(): string {
  return path.join(app.getPath('userData'), 'report-templates')
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function validateRelativePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || !SAFE_RELATIVE_PATH.test(value)) {
    throw new ReportTemplateError('invalid_path', `${label} 必须是包内相对路径`)
  }
  const normalized = path.posix.normalize(value.replace(/\\/g, '/'))
  if (normalized === '.' || normalized.startsWith('../') || normalized.includes('/../') || path.posix.isAbsolute(normalized)) {
    throw new ReportTemplateError('invalid_path', `${label} 不能越出模板包目录`)
  }
  return normalized
}

function parseManifest(value: unknown): ReportTemplateManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ReportTemplateError('invalid_manifest', 'manifest.json 必须是对象')
  }
  const manifest = value as Record<string, unknown>
  const author = manifest.author as Record<string, unknown> | undefined
  const capture = manifest.capture as Record<string, unknown> | undefined
  const license = manifest.license as Record<string, unknown> | undefined
  if (manifest.protocolVersion !== REPORT_TEMPLATE_PACKAGE_PROTOCOL_VERSION) {
    throw new ReportTemplateError('unsupported_protocol', '模板包协议版本不受支持')
  }
  if (manifest.kind !== 'daily-report' || typeof manifest.id !== 'string' || !SAFE_ID.test(manifest.id)) {
    throw new ReportTemplateError('invalid_manifest', '模板类型或 ID 无效')
  }
  if (typeof manifest.name !== 'string' || !manifest.name.trim() || !author || typeof author.name !== 'string') {
    throw new ReportTemplateError('invalid_manifest', '模板名称和作者不能为空')
  }
  if (typeof manifest.templateVersion !== 'string' || !SAFE_VERSION.test(manifest.templateVersion)) {
    throw new ReportTemplateError('invalid_version', 'templateVersion 必须是 semver')
  }
  if (manifest.interfaceVersion !== REPORT_TEMPLATE_INTERFACE_VERSION) {
    throw new ReportTemplateError('unsupported_interface', '占位符接口版本不受支持')
  }
  const entry = validateRelativePath(manifest.entry, 'entry')
  const preview = manifest.preview === undefined ? undefined : validateRelativePath(manifest.preview, 'preview')
  const captureWidth = capture?.width
  const captureMaxWidth = capture?.maxWidth
  const captureMaxHeight = capture?.maxHeight
  if (!capture || !Number.isInteger(captureWidth) || !Number.isInteger(captureMaxWidth) || !Number.isInteger(captureMaxHeight)) {
    throw new ReportTemplateError('invalid_manifest', 'capture 尺寸无效')
  }
  if ((captureWidth as number) < 320 || (captureWidth as number) > 1920 || (captureMaxWidth as number) < (captureWidth as number) || (captureMaxWidth as number) > 1920 || (captureMaxHeight as number) < 800 || (captureMaxHeight as number) > 20000) {
    throw new ReportTemplateError('invalid_manifest', 'capture 尺寸超出允许范围')
  }
  if (!license || typeof license.spdx !== 'string' || !license.spdx.trim()) {
    throw new ReportTemplateError('invalid_manifest', '必须声明 license.spdx')
  }
  return {
    protocolVersion: manifest.protocolVersion,
    kind: 'daily-report',
    id: manifest.id,
    name: manifest.name.trim(),
    author: { name: author.name.trim(), ...(typeof author.homepage === 'string' ? { homepage: author.homepage } : {}) },
    templateVersion: manifest.templateVersion,
    interfaceVersion: manifest.interfaceVersion,
    entry,
    ...(preview ? { preview } : {}),
    capture: { width: captureWidth as number, maxWidth: captureMaxWidth as number, maxHeight: captureMaxHeight as number },
    license: { spdx: license.spdx.trim(), ...(typeof license.notice === 'string' ? { notice: license.notice } : {}) },
    ...(typeof manifest.minAppVersion === 'string' ? { minAppVersion: manifest.minAppVersion } : {}),
    ...(manifest.platform === 'mobile' || manifest.platform === 'desktop' || manifest.platform === 'default' ? { platform: manifest.platform } : {})
  }
}

function validateCss(css: string, fileName: string): void {
  if (Buffer.byteLength(css, 'utf8') > REPORT_TEMPLATE_LIMITS.maxCssBytes) {
    throw new ReportTemplateError('file_too_large', `${fileName} 超过 CSS 大小限制`)
  }
  let ast: csstree.CssNode
  try {
    ast = csstree.parse(css, { positions: false })
  } catch (error) {
    throw new ReportTemplateError('invalid_css', `${fileName} CSS 解析失败：${String(error)}`)
  }
  csstree.walk(ast, (node) => {
    if (node.type === 'Atrule' && node.name.toLowerCase() === 'import') {
      throw new ReportTemplateError('unsafe_css', `${fileName} 不允许 @import`)
    }
    if (node.type === 'Url' || (node.type === 'Function' && node.name.toLowerCase() === 'url')) {
      const raw = csstree.generate(node)
      if (/^(?:url\()?\s*(?:https?:|file:|data:|javascript:)/i.test(raw.trim())) {
        throw new ReportTemplateError('unsafe_url', `${fileName} 包含危险资源 URL`)
      }
    }
  })
}

export function validateReportTemplateHtml(html: string, fileName = 'template.html'): void {
  if (Buffer.byteLength(html, 'utf8') > REPORT_TEMPLATE_LIMITS.maxHtmlBytes) {
    throw new ReportTemplateError('file_too_large', `${fileName} 超过 HTML 大小限制`)
  }
  const placeholders = [...html.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map((match) => match[1])
  for (const key of placeholders) {
    if (!REPORT_TEMPLATE_PLACEHOLDERS[key]) throw new ReportTemplateError('unknown_placeholder', `不支持占位符 {{${key}}}`)
  }
  const fragment = parseFragment(html)
  const visit = (node: { nodeName: string; attrs?: Array<{ name: string; value: string }>; childNodes?: unknown[] }): void => {
    const tag = node.nodeName.toLowerCase()
    if (tag === '#text' || tag === '#comment' || tag === '#document-fragment') {
      for (const child of (node.childNodes || []) as Array<{ nodeName: string; attrs?: Array<{ name: string; value: string }>; childNodes?: unknown[] }>) visit(child)
      return
    }
    if (!REPORT_TEMPLATE_ALLOWED_TAGS.has(tag)) throw new ReportTemplateError('unsafe_html', `${fileName} 不允许标签 <${tag}>`)
    for (const attr of node.attrs || []) {
      const name = attr.name.toLowerCase()
      if (!REPORT_TEMPLATE_ALLOWED_ATTRS.has(name) || name.startsWith('on')) throw new ReportTemplateError('unsafe_html', `${fileName} 不允许属性 ${attr.name}`)
      if (/\{\{[A-Z0-9_]+\}\}/.test(attr.value)) {
        const keys = [...attr.value.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map((match) => match[1])
        if (name !== 'class' || keys.some((key) => REPORT_TEMPLATE_PLACEHOLDERS[key] !== 'class')) {
          throw new ReportTemplateError('invalid_placeholder_context', `占位符不能出现在 ${name} 属性中`)
        }
      }
      if (name === 'src') {
        const assetPath = path.posix.normalize(attr.value.replace(/\\/g, '/'))
        if (!assetPath.startsWith('assets/') || !REPORT_TEMPLATE_ALLOWED_ASSET_EXTENSIONS.has(path.posix.extname(assetPath).toLowerCase())) {
          throw new ReportTemplateError('unsafe_url', `${fileName} 只允许 assets/ 下的图片资源`)
        }
      }
      if (['href', 'action', 'poster'].includes(name)) throw new ReportTemplateError('unsafe_url', `${fileName} 不允许 URL 属性`)
    }
    if (tag === 'style') {
      const text = (node.childNodes || []).map((child) => (child as { value?: string }).value || '').join('')
      if (/\{\{[A-Z0-9_]+\}\}/.test(text)) throw new ReportTemplateError('invalid_placeholder_context', '占位符不能出现在 style 中')
      validateCss(text, fileName)
    }
    for (const child of (node.childNodes || []) as Array<{ nodeName: string; attrs?: Array<{ name: string; value: string }>; childNodes?: unknown[] }>) visit(child)
  }
  visit(fragment)
}

function collectTemplateAssetRefs(html: string): string[] {
  const refs: string[] = []
  const fragment = parseFragment(html)
  const visit = (node: { nodeName: string; attrs?: Array<{ name: string; value: string }>; childNodes?: unknown[] }): void => {
    if (node.nodeName.toLowerCase() === 'img') {
      const src = node.attrs?.find((attr) => attr.name.toLowerCase() === 'src')?.value
      if (src) refs.push(path.posix.normalize(src.replace(/\\/g, '/')))
    }
    for (const child of (node.childNodes || []) as Array<{ nodeName: string; attrs?: Array<{ name: string; value: string }>; childNodes?: unknown[] }>) visit(child)
  }
  visit(fragment)
  return refs
}

async function readIndex(directory: string): Promise<TemplateIndex> {
  try {
    const value = JSON.parse(await fs.readFile(path.join(directory, INDEX_FILE), 'utf8')) as Partial<TemplateIndex>
    if (value.version !== 1 || !Array.isArray(value.templates)) throw new Error('invalid index')
    return { version: 1, templates: value.templates }
  } catch {
    return { version: 1, templates: [] }
  }
}

async function writeIndex(directory: string, index: TemplateIndex): Promise<void> {
  const temporary = `${path.join(directory, INDEX_FILE)}.tmp-${process.pid}-${Date.now()}`
  await fs.writeFile(temporary, JSON.stringify(index, null, 2), 'utf8')
  await fs.rename(temporary, path.join(directory, INDEX_FILE))
}

function builtInTemplate(template: ReportTemplateDefinition): InstalledReportTemplate {
  const resourceRoot = path.join(process.resourcesPath || process.cwd(), 'resources')
  const entryPath = path.join(resourceRoot, template.resourceFile)
  return {
    id: template.id,
    version: 'builtin',
    interfaceVersion: REPORT_TEMPLATE_INTERFACE_VERSION,
    source: 'builtin',
    name: template.name,
    author: 'TraceMemo',
    entryPath,
    capture: { width: template.captureWidth, maxWidth: template.maxCaptureWidth, maxHeight: 20000 },
    license: { spdx: 'NOASSERTION' }
  }
}

export class ReportTemplateService {
  private readonly directory = rootPath()

  async list(): Promise<InstalledReportTemplate[]> {
    await fs.mkdir(path.join(this.directory, INSTALLED_DIR), { recursive: true })
    const index = await readIndex(this.directory)
    return [builtInTemplate(DEFAULT_REPORT_TEMPLATE), ...REPORT_TEMPLATES.map(builtInTemplate), ...index.templates]
  }

  async resolve(ref: ReportTemplateRef): Promise<InstalledReportTemplate> {
    const id = String(ref?.id || '').trim()
    if (!id) throw new ReportTemplateError('missing_template', '缺少模板 ID')
    const templates = await this.list()
    const candidates = templates.filter((template) => template.id === id)
    if (!candidates.length) throw new ReportTemplateError('template_not_found', `模板不存在：${id}`)
    if (candidates[0].source === 'builtin') {
      throw new ReportTemplateError('builtin_template_ref', `外部模板引用不能使用内置模板：${id}`)
    }
    const found = ref.version ? candidates.find((template) => template.version === ref.version) : candidates.sort((a, b) => b.version.localeCompare(a.version))[0]
    if (!found) throw new ReportTemplateError('template_version_not_found', `模板版本不存在：${id}@${ref.version}`)
    if (found.interfaceVersion !== REPORT_TEMPLATE_INTERFACE_VERSION) throw new ReportTemplateError('unsupported_interface', `模板接口版本不兼容：${found.interfaceVersion}`)
    return found
  }

  async install(packagePath: string, expectedRef?: ReportTemplateRef): Promise<InstalledReportTemplate> {
    const stat = await fs.stat(packagePath)
    if (!stat.isFile() || stat.size > REPORT_TEMPLATE_LIMITS.maxCompressedBytes) throw new ReportTemplateError('package_too_large', '模板 ZIP 超过大小限制')
    const archive = await Open.file(packagePath)
    if (archive.files.length === 0 || archive.files.length > REPORT_TEMPLATE_LIMITS.maxFiles) throw new ReportTemplateError('too_many_files', '模板包文件数量无效')
    const seen = new Set<string>()
    const entries: EntryInfo[] = []
    let declaredTotal = 0
    for (const entry of archive.files) {
      const normalized = validateRelativePath(entry.path, 'ZIP 条目')
      const collisionKey = normalized.toLowerCase()
      if (seen.has(collisionKey)) throw new ReportTemplateError('duplicate_entry', `ZIP 条目规范化后重复：${normalized}`)
      seen.add(collisionKey)
      if (entry.type !== 'Directory' && entry.type !== 'File') throw new ReportTemplateError('unsafe_entry', `ZIP 条目类型不受支持：${normalized}`)
      const type = entry.type === 'Directory' ? 'directory' : 'file'
      const size = Number(entry.uncompressedSize || 0)
      if (type === 'file' && size > REPORT_TEMPLATE_LIMITS.maxFileBytes) throw new ReportTemplateError('file_too_large', `ZIP 条目过大：${normalized}`)
      if (type === 'file') declaredTotal += size
      if (declaredTotal > REPORT_TEMPLATE_LIMITS.maxExtractedBytes) throw new ReportTemplateError('package_too_large', '模板包解压体积超过限制')
      if (type === 'file' && (normalized.endsWith('.html') || normalized.endsWith('.css')) && size > REPORT_TEMPLATE_LIMITS.maxHtmlBytes) throw new ReportTemplateError('file_too_large', `模板文件过大：${normalized}`)
      entries.push({ path: normalized, type, size, entry })
    }
    const manifestEntry = entries.find((entry) => entry.path === 'manifest.json' && entry.type === 'file')
    if (!manifestEntry) throw new ReportTemplateError('invalid_manifest', '模板包缺少 manifest.json')
    const manifest = parseManifest(JSON.parse((await manifestEntry.entry.buffer()).toString('utf8')))
    if (manifest.id.startsWith('builtin.')) throw new ReportTemplateError('reserved_id', '外部模板不能使用内置命名空间')
    if (
      expectedRef &&
      (manifest.id !== expectedRef.id || manifest.templateVersion !== expectedRef.version)
    ) {
      throw new ReportTemplateError(
        'catalog_manifest_mismatch',
        `模板包 manifest 与目录条目不一致：${manifest.id}@${manifest.templateVersion}`
      )
    }
    const entry = entries.find((item) => item.path === manifest.entry && item.type === 'file')
    if (!entry) throw new ReportTemplateError('missing_entry', 'manifest.entry 文件不存在')
    const html = (await entry.entry.buffer()).toString('utf8')
    validateReportTemplateHtml(html, manifest.entry)
    const assetPaths = new Set(entries.filter((item) => item.type === 'file').map((item) => item.path))
    for (const asset of collectTemplateAssetRefs(html)) {
      if (!assetPaths.has(asset)) throw new ReportTemplateError('missing_asset', `模板图片资源不存在：${asset}`)
    }
    const preview = manifest.preview ? entries.find((item) => item.path === manifest.preview && item.type === 'file') : undefined
    if (manifest.preview && !preview) throw new ReportTemplateError('missing_preview', 'manifest.preview 文件不存在')
    for (const item of entries.filter((candidate) => candidate.type === 'file')) {
      const ext = path.extname(item.path).toLowerCase()
      if (item.path !== 'manifest.json' && item.path !== manifest.entry && item.path !== manifest.preview && !REPORT_TEMPLATE_ALLOWED_ASSET_EXTENSIONS.has(ext)) {
        throw new ReportTemplateError('unsupported_resource', `不支持的模板资源：${item.path}`)
      }
    }
    const staging = path.join(this.directory, STAGING_DIR, `${process.pid}-${Date.now()}-${crypto.randomUUID()}`)
    await fs.mkdir(staging, { recursive: true })
    try {
      let actualTotal = 0
      for (const item of entries) {
        const destination = path.resolve(staging, item.path)
        if (!isWithin(staging, destination)) throw new ReportTemplateError('invalid_path', `ZIP 条目越界：${item.path}`)
        if (item.type === 'directory') {
          await fs.mkdir(destination, { recursive: true })
          continue
        }
        await fs.mkdir(path.dirname(destination), { recursive: true })
        const stream = item.entry.stream()
        const chunks: Buffer[] = []
        for await (const chunk of stream) {
          const buffer = Buffer.from(chunk as Uint8Array)
          actualTotal += buffer.length
          if (actualTotal > REPORT_TEMPLATE_LIMITS.maxExtractedBytes || buffer.length > REPORT_TEMPLATE_LIMITS.maxFileBytes) throw new ReportTemplateError('package_too_large', '模板包实际解压体积超过限制')
          chunks.push(buffer)
        }
        await fs.writeFile(destination, Buffer.concat(chunks))
        const fileStat = await fs.lstat(destination)
        if (!fileStat.isFile()) throw new ReportTemplateError('invalid_file', `模板文件类型无效：${item.path}`)
      }
      const target = path.join(this.directory, INSTALLED_DIR, manifest.id, manifest.templateVersion)
      const existingIndex = await readIndex(this.directory)
      const existing = existingIndex.templates.find((item) => item.id === manifest.id && item.version === manifest.templateVersion)
      const digest = crypto.createHash('sha256').update(await fs.readFile(packagePath)).digest('hex')
      if (existing) {
        if (existing.sha256 !== digest) throw new ReportTemplateError('version_conflict', `模板版本已存在但内容不同：${manifest.id}@${manifest.templateVersion}`)
        return existing
      }
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.rename(staging, target)
      const installed: InstalledReportTemplate = {
        id: manifest.id, version: manifest.templateVersion, interfaceVersion: manifest.interfaceVersion,
        source: 'installed', name: manifest.name, author: manifest.author.name,
        entryPath: path.join(target, manifest.entry), ...(manifest.preview ? { previewPath: path.join(target, manifest.preview) } : {}),
        capture: manifest.capture, license: manifest.license, packagePath, sha256: digest, installedAt: new Date().toISOString()
      }
      existingIndex.templates = [...existingIndex.templates.filter((item) => !(item.id === installed.id && item.version === installed.version)), installed]
      await writeIndex(this.directory, existingIndex)
      return installed
    } finally {
      // 同版本幂等返回也必须清理 staging，避免重复安装逐渐堆积临时目录。
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  async uninstall(id: string, version: string): Promise<void> {
    if (!SAFE_ID.test(id) || !SAFE_VERSION.test(version)) {
      throw new ReportTemplateError('invalid_template_ref', '模板 ID 或版本无效')
    }
    const index = await readIndex(this.directory)
    const target = index.templates.find((item) => item.id === id && item.version === version)
    if (!target) throw new ReportTemplateError('template_not_found', `模板版本不存在：${id}@${version}`)
    await fs.rm(path.join(this.directory, INSTALLED_DIR, id, version), { recursive: true, force: true })
    index.templates = index.templates.filter((item) => item !== target)
    await writeIndex(this.directory, index)
  }

  async recover(): Promise<void> {
    const installedRoot = path.join(this.directory, INSTALLED_DIR)
    await fs.mkdir(installedRoot, { recursive: true })
    const previous = await readIndex(this.directory)
    const recovered: InstalledReportTemplate[] = []
    for (const id of await fs.readdir(installedRoot)) {
      for (const version of await fs.readdir(path.join(installedRoot, id))) {
        const entryPath = path.join(installedRoot, id, version)
        try {
          const manifest = parseManifest(JSON.parse(await fs.readFile(path.join(entryPath, 'manifest.json'), 'utf8')))
          const recoveredEntryPath = path.join(entryPath, manifest.entry)
          const entryStat = await fs.lstat(recoveredEntryPath)
          if (!entryStat.isFile()) continue
          const candidate = previous.templates.find((item) => item.id === manifest.id && item.version === manifest.templateVersion)
          recovered.push(candidate && candidate.source === 'installed'
            ? { ...candidate, entryPath: recoveredEntryPath, previewPath: manifest.preview ? path.join(entryPath, manifest.preview) : undefined }
            : {
                id: manifest.id,
                version: manifest.templateVersion,
                interfaceVersion: manifest.interfaceVersion,
                source: 'installed',
                name: manifest.name,
                author: manifest.author.name,
                entryPath: recoveredEntryPath,
                ...(manifest.preview ? { previewPath: path.join(entryPath, manifest.preview) } : {}),
                capture: manifest.capture,
                license: manifest.license
              })
        } catch { /* 忽略损坏的安装目录，保留其他模板 */ }
      }
    }
    await writeIndex(this.directory, { version: 1, templates: recovered })
  }
}

export const reportTemplateService = new ReportTemplateService()
