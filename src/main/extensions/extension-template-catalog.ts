import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { ExtensionError } from '../../shared/extensions/errors'
import { compareSemver } from '../../shared/extensions/manifest'
import type { ExtensionRegistryRecord } from './extension-registry'
import { normalizeExtensionPermissions } from '../../shared/extensions/permissions'

import type {
  ExtensionTemplateEntry,
  ExtensionTemplateRequirement,
  ExtensionTemplateStatus,
  TemplateDependencyCheck
} from '../../shared/extensions/templates'

export type {
  ExtensionTemplateEntry,
  ExtensionTemplateRequirement,
  ExtensionTemplateState,
  ExtensionTemplateStatus,
  TemplateDependencyCheck
} from '../../shared/extensions/templates'

export interface ExtensionTemplateCatalogDependencies {
  /** 模板资源根目录；打包后是 `<resources>/extension-templates`。 */
  templateRoot: string
  getRecord: (extensionId: string) => ExtensionRegistryRecord | undefined
  /** 已安装扩展的代码目录；用来看依赖脚本在不在。 */
  resolveInstallDir: (extensionId: string) => string
  platform?: NodeJS.Platform
  /** 测试注入点：默认用真实文件系统。 */
  exists?: (filePath: string) => boolean
  readFile?: (filePath: string) => Promise<Buffer>
  /** 依赖探测注入点：默认读本机 PATH 与常见安装位置。 */
  probePython?: () => string | null
  probeChrome?: () => string | null
}

const INDEX_FILE = 'index.json'
const SUPPORTED_INDEX_VERSION = 1

interface TemplateIndexFile {
  version: number
  templates: unknown[]
}

function parseRequirement(input: unknown): ExtensionTemplateRequirement {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  const raw = input as Record<string, unknown>
  const result: ExtensionTemplateRequirement = {}
  for (const key of ['python', 'chrome', 'externalScript'] as const) {
    const value = raw[key]
    if (value === true || value === false) {
      result[key] = value as never
      continue
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const item = value as Record<string, unknown>
      const required = item.required === true
      if (key === 'externalScript') {
        const scriptPath = typeof item.path === 'string' ? item.path.trim() : ''
        if (!scriptPath) continue
        result.externalScript = {
          required,
          path: scriptPath,
          ...(typeof item.reason === 'string' ? { reason: item.reason.slice(0, 200) } : {})
        }
        continue
      }
      if (key === 'python') {
        result.python = {
          required,
          ...(typeof item.minVersion === 'string' ? { minVersion: item.minVersion } : {}),
          ...(typeof item.reason === 'string' ? { reason: item.reason.slice(0, 200) } : {})
        }
        continue
      }
      result.chrome = {
        required,
        ...(typeof item.reason === 'string' ? { reason: item.reason.slice(0, 200) } : {})
      }
    }
  }
  return result
}

function parseEntry(input: unknown): ExtensionTemplateEntry | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const raw = input as Record<string, unknown>
  const templateId = String(raw.templateId ?? '').trim()
  const extensionId = String(raw.extensionId ?? '').trim()
  const name = String(raw.name ?? '').trim()
  const version = String(raw.version ?? '').trim()
  const file = String(raw.file ?? '').trim()
  const sha256 = String(raw.sha256 ?? '').trim()
  if (!templateId || !extensionId || !name || !version || !file || !sha256) return null
  // 索引来自资源目录，但依然不接受任何路径片段：读取时只拼在模板根目录下。
  if (file.includes('/') || file.includes('\\') || file.includes('..')) return null
  if (!/^[a-f0-9]{64}$/.test(sha256)) return null
  const platforms = Array.isArray(raw.platforms)
    ? raw.platforms.filter((item): item is NodeJS.Platform => typeof item === 'string')
    : []
  return {
    templateId,
    extensionId,
    name,
    version,
    ...(typeof raw.description === 'string' ? { description: raw.description.slice(0, 500) } : {}),
    permissions: normalizeExtensionPermissions(raw.permissions),
    file,
    sha256,
    bytes: Number(raw.bytes) || 0,
    fileCount: Number(raw.fileCount) || 0,
    platforms,
    requires: parseRequirement(raw.requires)
  }
}

/**
 * 官方模板目录。
 *
 * 只做三件事：读索引、校验资源、把模板与已安装状态对上。
 * 安装动作本身不在这里——它由 `ExtensionManager` 走统一的安装器，
 * 避免出现第二套 ZIP 解压逻辑。
 */
export class ExtensionTemplateCatalog {
  private readonly dependencies: ExtensionTemplateCatalogDependencies
  private readonly platform: NodeJS.Platform
  private cachedIndex: ExtensionTemplateEntry[] | null = null

  constructor(dependencies: ExtensionTemplateCatalogDependencies) {
    this.dependencies = dependencies
    this.platform = dependencies.platform ?? process.platform
  }

  /** 索引读取失败时返回空列表：模板资源缺失不应该让扩展中心整页崩掉。 */
  async list(): Promise<ExtensionTemplateStatus[]> {
    const entries = await this.loadIndex()
    const result: ExtensionTemplateStatus[] = []
    for (const template of entries) {
      result.push(await this.describe(template))
    }
    return result.sort((left, right) =>
      left.template.templateId.localeCompare(right.template.templateId)
    )
  }

  get(templateId: string): ExtensionTemplateEntry | undefined {
    return this.cachedIndex?.find((item) => item.templateId === templateId)
  }

  /**
   * 取模板 ZIP 的绝对路径，并校验内容哈希。
   *
   * 这一步是安装前的最后一道闸：索引与 ZIP 若被单独替换，哈希就对不上，
   * 直接拒绝安装而不是把未知内容装进用户目录。
   */
  async resolveZip(
    templateId: string
  ): Promise<{ path: string; template: ExtensionTemplateEntry }> {
    const entries = await this.loadIndex()
    const template = entries.find((item) => item.templateId === templateId)
    if (!template) {
      throw new ExtensionError('EXTENSION_NOT_FOUND', `找不到模板：${templateId}`)
    }
    const zipPath = path.join(this.dependencies.templateRoot, template.file)
    const exists = this.dependencies.exists ?? defaultExists
    if (!exists(zipPath)) {
      throw new ExtensionError('EXTENSION_INSTALL_FAILED', `模板资源缺失：${template.file}`)
    }
    const readFile = this.dependencies.readFile ?? fs.readFile
    let buffer: Buffer
    try {
      buffer = await readFile(zipPath)
    } catch {
      throw new ExtensionError('EXTENSION_INSTALL_FAILED', `模板资源不可读：${template.file}`)
    }
    const digest = createHash('sha256').update(buffer).digest('hex')
    if (digest !== template.sha256) {
      throw new ExtensionError(
        'EXTENSION_INSTALL_FAILED',
        '模板资源校验失败：文件内容与索引不一致，已拒绝安装'
      )
    }
    return { path: zipPath, template }
  }

  private async loadIndex(): Promise<ExtensionTemplateEntry[]> {
    if (this.cachedIndex) return this.cachedIndex
    const indexPath = path.join(this.dependencies.templateRoot, INDEX_FILE)
    const readFile = this.dependencies.readFile ?? fs.readFile
    let parsed: TemplateIndexFile
    try {
      const text = await readFile(indexPath)
      parsed = JSON.parse(text.toString('utf8')) as TemplateIndexFile
    } catch {
      this.cachedIndex = []
      return this.cachedIndex
    }
    if (
      !parsed ||
      Number(parsed.version) !== SUPPORTED_INDEX_VERSION ||
      !Array.isArray(parsed.templates)
    ) {
      this.cachedIndex = []
      return this.cachedIndex
    }
    const entries: ExtensionTemplateEntry[] = []
    const seen = new Set<string>()
    for (const item of parsed.templates) {
      const entry = parseEntry(item)
      if (!entry) continue
      if (seen.has(entry.templateId)) continue
      seen.add(entry.templateId)
      entries.push(entry)
    }
    this.cachedIndex = entries
    return entries
  }

  private async describe(template: ExtensionTemplateEntry): Promise<ExtensionTemplateStatus> {
    const record = this.dependencies.getRecord(template.extensionId)
    const dependencies = await this.checkDependencies(template, record)
    const base = {
      template,
      ...(record ? { installedVersion: record.version, installedSource: record.source } : {}),
      dependencies
    }

    if (template.platforms.length > 0 && !template.platforms.includes(this.platform)) {
      return {
        ...base,
        state: 'unsupported',
        message: `当前平台（${this.platform}）不在模板支持范围内`
      }
    }

    const damaged = await this.isDamaged(template)
    if (damaged) {
      return { ...base, state: 'damaged', message: '模板资源缺失或校验失败，请重新安装 TraceMemo' }
    }

    if (!record) return { ...base, state: 'not-installed' }

    // 同 id 但不是这个模板装的：不能静默接管用户自己的扩展。
    if (record.source !== 'template' || record.templateId !== template.templateId) {
      return {
        ...base,
        state: 'conflict',
        message: '已安装同 ID 的非官方扩展，不会自动替换'
      }
    }

    const compared = compareSemver(template.version, record.version)
    if (compared !== null && compared > 0) {
      return { ...base, state: 'update-available' }
    }
    return { ...base, state: 'installed' }
  }

  private async isDamaged(template: ExtensionTemplateEntry): Promise<boolean> {
    const zipPath = path.join(this.dependencies.templateRoot, template.file)
    const exists = this.dependencies.exists ?? defaultExists
    if (!exists(zipPath)) return true
    const readFile = this.dependencies.readFile ?? fs.readFile
    try {
      const buffer = await readFile(zipPath)
      if (template.bytes > 0 && buffer.length !== template.bytes) return true
      return createHash('sha256').update(buffer).digest('hex') !== template.sha256
    } catch {
      return true
    }
  }

  /**
   * 依赖检测只做本地文件探测：不执行脚本、不访问网络、不触发解析。
   *
   * `externalScript` 只在扩展已安装后才能判断——安装前它一定不存在，
   * 报「缺失」只会让用户以为模板坏了。
   */
  private async checkDependencies(
    template: ExtensionTemplateEntry,
    record: ExtensionRegistryRecord | undefined
  ): Promise<ExtensionTemplateStatus['dependencies']> {
    const checks: TemplateDependencyCheck[] = []
    const requires = template.requires

    const python = requires.python
    if (python) {
      const required = typeof python === 'boolean' ? python : python.required
      const executable = (this.dependencies.probePython ?? (() => findPython(this.platform)))()
      checks.push({
        id: 'python',
        label: 'Python',
        ok: Boolean(executable),
        blocking: required,
        ...(executable
          ? { detail: '已找到可执行文件' }
          : {
              detail:
                typeof python === 'object' && python.reason
                  ? python.reason
                  : '未在 PATH 中找到 Python'
            })
      })
    }

    const chrome = requires.chrome
    if (chrome) {
      const required = typeof chrome === 'boolean' ? chrome : chrome.required
      const found = (this.dependencies.probeChrome ?? (() => findChrome(this.platform)))()
      checks.push({
        id: 'chrome',
        label: 'Chrome',
        ok: Boolean(found),
        blocking: required,
        ...(found
          ? { detail: '已找到 Chrome' }
          : {
              detail: typeof chrome === 'object' && chrome.reason ? chrome.reason : '未找到 Chrome'
            })
      })
    }

    const externalScript = requires.externalScript
    if (externalScript) {
      const spec = typeof externalScript === 'object' ? externalScript : null
      const relative = spec?.path ?? 'scripts/douyin.py'
      if (!record) {
        checks.push({
          id: 'externalScript',
          label: '解析脚本',
          ok: false,
          blocking: false,
          detail: '安装后检测；该脚本不随应用分发'
        })
      } else {
        const scriptPath = path.join(
          this.dependencies.resolveInstallDir(template.extensionId),
          relative
        )
        const exists = this.dependencies.exists ?? defaultExists
        checks.push({
          id: 'externalScript',
          label: '解析脚本',
          ok: exists(scriptPath),
          blocking: spec?.required !== false,
          detail: exists(scriptPath)
            ? '已找到解析脚本'
            : spec?.reason || '缺少解析脚本，模板暂时无法处理视频'
        })
      }
    }

    const blockingMissing = checks.some((check) => check.blocking && !check.ok)
    return { ready: !blockingMissing, checks }
  }
}

function defaultExists(filePath: string): boolean {
  // 只查存在性，不读内容：检测阶段不触碰文件内容。
  return existsSync(filePath)
}

/** 只在 PATH 里找可执行文件，**不执行**它——检测阶段不能启动任何外部进程。 */
function findPython(platform: NodeJS.Platform): string | null {
  const names =
    platform === 'win32' ? ['python.exe', 'python3.exe', 'py.exe'] : ['python3', 'python']
  return findOnPath(names, platform)
}

function findChrome(platform: NodeJS.Platform): string | null {
  const candidates: string[] = []
  if (platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(
        process.env.HOME || '',
        'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      )
    )
  } else if (platform === 'win32') {
    for (const root of [
      process.env['PROGRAMFILES'] || '',
      process.env['PROGRAMFILES(X86)'] || '',
      process.env['LOCALAPPDATA'] || ''
    ]) {
      if (!root) continue
      candidates.push(path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    }
  }
  return candidates.find((candidate) => defaultExists(candidate)) || null
}

function findOnPath(names: string[], platform: NodeJS.Platform): string | null {
  const separator = platform === 'win32' ? ';' : ':'
  const directories = String(process.env.PATH || '')
    .split(separator)
    .filter(Boolean)
  for (const name of names) {
    for (const directory of directories) {
      const candidate = path.join(directory, name)
      if (defaultExists(candidate)) return candidate
    }
  }
  return null
}
