import { promises as fs } from 'node:fs'
import * as nodeFs from 'node:fs'
import path from 'node:path'
import { Open } from 'unzipper'
import { ExtensionError } from '../../shared/extensions/errors'
import {
  isSafeRelativeEntryPath,
  parseExtensionManifest,
  type ExtensionManifest
} from '../../shared/extensions/manifest'
import type { ExtensionRegistry, ExtensionRegistryRecord } from './extension-registry'
import { isPathInside, type ExtensionPaths } from './extension-paths'
import type { ExtensionSource } from '../../shared/extensions/source'
import { computeDirectoryDigest } from './extension-code-digest'

const MAX_FILES = 2_000
const MAX_TOTAL_BYTES = 50 * 1024 * 1024
const MAX_FILE_BYTES = 20 * 1024 * 1024
const MAX_PACKAGE_BYTES = 100 * 1024 * 1024

/** 从「文件夹安装」时跳过的目录名；与打包脚本的白名单保持同一套判断。 */
const EXCLUDED_SOURCE_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv'
])

export interface InstallOptions {
  /** 应用版本，用于 `minAppVersion` 兼容检查。 */
  appVersion: string
  source?: ExtensionSource
  /** 模板安装时由可信入口填入；普通 ZIP/目录安装不得携带。 */
  template?: { id: string; version: string }
  /**
   * 代码被替换之前的最后一步：用于停止旧的 Host。
   *
   * 抛错表示「不能安全替换」，安装整体中止，磁盘保持原样。
   */
  beforeReplace?: (
    manifest: ExtensionManifest,
    previous: ExtensionRegistryRecord | undefined
  ) => Promise<void>
}

export interface InstallOutcome {
  manifest: ExtensionManifest
  installPath: string
  previousVersion?: string
  /** 安装前的 Registry 记录；首次安装时为 undefined。 */
  previousRecord?: ExtensionRegistryRecord
  upgraded: boolean
  /**
   * 把磁盘与 Registry 一起恢复到本次安装之前。
   *
   * 只在新版本启动失败时调用；调用后 `cleanup` 失效。
   */
  rollback: () => Promise<void>
  /**
   * 删除旧版本的过渡备份。
   *
   * 新版本确认可用后调用；调用后 `rollback` 失效。
   */
  cleanup: () => Promise<void>
}

export interface ExtensionInstallerDependencies {
  paths: ExtensionPaths
  registry: ExtensionRegistry
  now?: () => number
}

interface TreeEntry {
  relativePath: string
  type: 'file' | 'directory'
  size: number
}

/**
 * 扩展安装 / 升级 / 卸载。
 *
 * 写入顺序固定为「临时目录 → 校验 → 原子改名」：任何一步失败都不会留下
 * 半装目录；升级失败时旧版本仍在原位。
 */
export class ExtensionInstaller {
  private readonly paths: ExtensionPaths
  private readonly registry: ExtensionRegistry
  private readonly now: () => number

  constructor(dependencies: ExtensionInstallerDependencies) {
    this.paths = dependencies.paths
    this.registry = dependencies.registry
    this.now = dependencies.now ?? (() => Date.now())
  }

  async installFromDirectory(sourceDir: string, options: InstallOptions): Promise<InstallOutcome> {
    const root = path.resolve(sourceDir)
    const stat = await fs.stat(root).catch(() => null)
    if (!stat || !stat.isDirectory()) {
      throw new ExtensionError('EXTENSION_INSTALL_FAILED', '选择的路径不是目录')
    }
    const manifest = await this.readManifest(root, options.appVersion)
    const entries = await this.collectTree(root)
    this.assertEntrypointsPresent(entries, manifest)

    const staging = this.paths.stagingPath('dir')
    await fs.mkdir(staging, { recursive: true })
    try {
      await copyTree(root, staging, entries)
      return await this.finalize(staging, manifest, options.source ?? 'directory', options)
    } finally {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  async installFromPackage(packagePath: string, options: InstallOptions): Promise<InstallOutcome> {
    const stat = await fs.stat(packagePath).catch(() => null)
    if (!stat || !stat.isFile()) {
      throw new ExtensionError('EXTENSION_INSTALL_FAILED', '选择的扩展包不存在')
    }
    if (stat.size > MAX_PACKAGE_BYTES) {
      throw new ExtensionError('EXTENSION_INSTALL_FAILED', '扩展包超过大小限制')
    }

    const archive = await Open.file(packagePath)
    if (!archive.files.length || archive.files.length > MAX_FILES) {
      throw new ExtensionError('EXTENSION_INSTALL_FAILED', '扩展包文件数量不合法')
    }

    const seen = new Set<string>()
    let declaredTotal = 0
    const entries: Array<{
      relativePath: string
      directory: boolean
      size: number
      entry: (typeof archive.files)[number]
    }> = []
    for (const entry of archive.files) {
      const normalized = normalizeZipPath(entry.path)
      const collisionKey = normalized.toLowerCase()
      if (seen.has(collisionKey)) {
        throw new ExtensionError('EXTENSION_INSTALL_FAILED', `扩展包内路径重复：${normalized}`)
      }
      seen.add(collisionKey)
      if (entry.type !== 'File' && entry.type !== 'Directory') {
        throw new ExtensionError(
          'EXTENSION_INSTALL_FAILED',
          `扩展包条目类型不受支持：${normalized}`
        )
      }
      const directory = entry.type === 'Directory'
      const size = Number(entry.uncompressedSize || 0)
      if (!directory && size > MAX_FILE_BYTES) {
        throw new ExtensionError('EXTENSION_INSTALL_FAILED', `扩展包内文件过大：${normalized}`)
      }
      declaredTotal += size
      if (declaredTotal > MAX_TOTAL_BYTES) {
        throw new ExtensionError('EXTENSION_INSTALL_FAILED', '扩展包解压后体积超过限制')
      }
      entries.push({ relativePath: normalized, directory, size, entry })
    }

    const manifestFile = entries.find(
      (item) => item.relativePath === 'manifest.json' && !item.directory
    )
    if (!manifestFile)
      throw new ExtensionError('EXTENSION_INVALID_MANIFEST', '扩展包缺少 manifest.json')
    const manifest = this.parseManifestText(
      (await manifestFile.entry.buffer()).toString('utf8'),
      options.appVersion
    )
    this.assertEntrypointsPresent(
      entries.map((item) => ({
        relativePath: item.relativePath,
        type: item.directory ? 'directory' : 'file',
        size: item.size
      })),
      manifest
    )

    const staging = this.paths.stagingPath('zip')
    await fs.mkdir(staging, { recursive: true })
    try {
      let actualTotal = 0
      for (const item of entries) {
        const destination = path.resolve(staging, item.relativePath)
        if (!isPathInside(staging, destination)) {
          throw new ExtensionError('EXTENSION_INVALID_PATH', `扩展包条目越界：${item.relativePath}`)
        }
        if (item.directory) {
          await fs.mkdir(destination, { recursive: true })
          continue
        }
        await fs.mkdir(path.dirname(destination), { recursive: true })
        const chunks: Buffer[] = []
        for await (const chunk of item.entry.stream()) {
          const buffer = Buffer.from(chunk as Uint8Array)
          actualTotal += buffer.length
          if (actualTotal > MAX_TOTAL_BYTES || buffer.length > MAX_FILE_BYTES) {
            throw new ExtensionError('EXTENSION_INSTALL_FAILED', '扩展包实际解压体积超过限制')
          }
          chunks.push(buffer)
        }
        await fs.writeFile(destination, Buffer.concat(chunks))
        const fileStat = await fs.lstat(destination)
        if (!fileStat.isFile()) {
          throw new ExtensionError(
            'EXTENSION_INVALID_PATH',
            `扩展包条目不是普通文件：${item.relativePath}`
          )
        }
      }
      return await this.finalize(staging, manifest, options.source ?? 'package', options)
    } finally {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /**
   * 卸载扩展。
   *
   * `keepData` 为 true 时**只**删除代码目录，用户配置保留在
   * `extensions-data/<id>`，同名扩展重新安装后能读回。
   */
  async uninstall(extensionId: string, options: { keepData: boolean }): Promise<void> {
    const target = this.paths.installDir(extensionId)
    if (!isPathInside(this.paths.extensionsDir, target)) {
      throw new ExtensionError('EXTENSION_INVALID_PATH', '扩展安装路径越界')
    }
    const trash = `${target}.removed-${this.now()}`
    // lstat 不跟随符号链接：目标断链时也要把链接本身清掉，否则会留下悬空目录项。
    const exists = await fs
      .lstat(target)
      .then(() => true)
      .catch(() => false)
    if (exists) {
      await fs.rename(target, trash)
      const trashStat = await fs.lstat(trash).catch(() => null)
      if (trashStat?.isSymbolicLink()) {
        // 只删链接本身；递归删除可能跟随链接进入用户自己的目录。
        await fs.unlink(trash).catch(() => undefined)
      } else {
        await fs.rm(trash, { recursive: true, force: true }).catch(() => undefined)
      }
    }
    if (!options.keepData) {
      await fs
        .rm(this.paths.extensionDataDir(extensionId), { recursive: true, force: true })
        .catch(() => undefined)
    }
    this.registry.remove(extensionId)
  }

  private async readManifest(root: string, appVersion: string): Promise<ExtensionManifest> {
    const manifestPath = path.join(root, 'manifest.json')
    const text = await fs.readFile(manifestPath, 'utf8').catch(() => '')
    if (!text) throw new ExtensionError('EXTENSION_INVALID_MANIFEST', '扩展目录缺少 manifest.json')
    return this.parseManifestText(text, appVersion)
  }

  private parseManifestText(text: string, appVersion: string): ExtensionManifest {
    const result = parseExtensionManifestJsonWithDetail(text, appVersion)
    if (!result.ok || !result.manifest) {
      throw new ExtensionError(
        result.code === 'EXTENSION_INCOMPATIBLE'
          ? 'EXTENSION_INCOMPATIBLE'
          : 'EXTENSION_INVALID_MANIFEST',
        result.message || '扩展 manifest 不合法'
      )
    }
    return result.manifest
  }

  private assertEntrypointsPresent(entries: TreeEntry[], manifest: ExtensionManifest): void {
    const files = new Set(
      entries.filter((entry) => entry.type === 'file').map((entry) => entry.relativePath)
    )
    for (const [key, value] of Object.entries(manifest.entrypoints)) {
      if (!value) continue
      if (!files.has(value)) {
        throw new ExtensionError(
          'EXTENSION_INVALID_MANIFEST',
          `entrypoints.${key} 指向的文件不存在：${value}`
        )
      }
    }
    for (const page of manifest.contributions.pages) {
      const entry = page.entry || manifest.entrypoints.page
      if (!entry || !files.has(entry)) {
        throw new ExtensionError('EXTENSION_INVALID_MANIFEST', `页面 ${page.id} 的入口文件不存在`)
      }
    }
  }

  private async collectTree(root: string): Promise<TreeEntry[]> {
    const entries: TreeEntry[] = []
    let total = 0
    const walk = async (directory: string, prefix: string): Promise<void> => {
      const items = await fs.readdir(directory, { withFileTypes: true })
      for (const item of items) {
        // 版本库与依赖目录不属于扩展产物：复制它们既超体积上限，
        // 也会把提交历史带进用户数据目录。
        if (item.isDirectory() && EXCLUDED_SOURCE_DIRECTORIES.has(item.name)) continue
        const relativePath = prefix ? `${prefix}/${item.name}` : item.name
        if (!isSafeRelativeEntryPath(relativePath)) {
          throw new ExtensionError('EXTENSION_INVALID_PATH', `文件名不受支持：${relativePath}`)
        }
        const absolute = path.join(directory, item.name)
        const stat = await fs.lstat(absolute)
        if (stat.isSymbolicLink()) {
          throw new ExtensionError(
            'EXTENSION_INVALID_PATH',
            `扩展目录不能包含符号链接：${relativePath}`
          )
        }
        if (stat.isDirectory()) {
          entries.push({ relativePath, type: 'directory', size: 0 })
          await walk(absolute, relativePath)
          continue
        }
        if (!stat.isFile()) {
          throw new ExtensionError('EXTENSION_INVALID_PATH', `不支持的文件类型：${relativePath}`)
        }
        if (stat.size > MAX_FILE_BYTES) {
          throw new ExtensionError('EXTENSION_INSTALL_FAILED', `文件过大：${relativePath}`)
        }
        total += stat.size
        if (total > MAX_TOTAL_BYTES) {
          throw new ExtensionError('EXTENSION_INSTALL_FAILED', '扩展体积超过限制')
        }
        entries.push({ relativePath, type: 'file', size: stat.size })
        if (entries.length > MAX_FILES) {
          throw new ExtensionError('EXTENSION_INSTALL_FAILED', '扩展文件数量超过限制')
        }
      }
    }
    await walk(root, '')
    return entries
  }

  /**
   * 临时目录 → 目标目录的原子替换。升级时保留 registry 里的启用状态与授权。
   *
   * 事务边界（只覆盖「同一文件系统内的目录改名 + 一次 JSON 写入」）：
   * - 改名前先停旧 Host：Windows 上被进程占用的目录无法改名，且旧进程
   *   继续运行会读到已被替换的代码。
   * - 旧目录保留为 `.backup-<ts>`，由调用方在新版本确认可用后清理；
   *   启动失败时用 `rollback()` 换回来。
   * - Registry 写入失败时当场回滚目录，不把「代码已换、状态未换」留给上层。
   *
   * 不保证跨进程的强原子性：如果进程在 rename 之后、Registry 写入之前被杀，
   * 磁盘上是新代码配旧记录；下次启动会以 manifest 为准做兼容性检查。
   */
  private async finalize(
    staging: string,
    manifest: ExtensionManifest,
    source: ExtensionSource,
    options: InstallOptions
  ): Promise<InstallOutcome> {
    const target = this.paths.installDir(manifest.id)
    if (!isPathInside(this.paths.extensionsDir, target)) {
      throw new ExtensionError('EXTENSION_INVALID_PATH', '扩展安装路径越界')
    }
    await fs.mkdir(this.paths.extensionsDir, { recursive: true })

    const existingRecord = this.registry.get(manifest.id)
    const backup = `${target}.backup-${this.now()}`
    const targetExists = await fs
      .stat(target)
      .then(() => true)
      .catch(() => false)

    // 旧 Host 必须在代码被替换之前停下；这一步失败则不触碰磁盘。
    await options.beforeReplace?.(manifest, existingRecord)

    if (targetExists) await fs.rename(target, backup)
    try {
      await fs.rename(staging, target)
    } catch (error) {
      if (targetExists) await fs.rename(backup, target).catch(() => undefined)
      throw new ExtensionError(
        'EXTENSION_INSTALL_FAILED',
        error instanceof Error ? error.message : '安装目录替换失败'
      )
    }

    const timestamp = this.now()
    const record: ExtensionRegistryRecord = {
      id: manifest.id,
      version: manifest.version,
      apiVersion: manifest.apiVersion,
      // 升级不改变启用状态：升级后突然开始跑代码是用户没有同意的行为变化。
      enabled: existingRecord?.enabled ?? false,
      // 只保留新 manifest 仍声明的授权：被删掉的权限必须立刻失效。
      grantedPermissions: (existingRecord?.grantedPermissions ?? []).filter((permission) =>
        manifest.permissions.includes(permission)
      ),
      installedAt: existingRecord?.installedAt ?? timestamp,
      updatedAt: timestamp,
      source,
      // 安装完成后立刻记录基线：之后判断「用户改没改」全靠它。
      installedCodeDigest: computeDirectoryDigest(target),
      ...(options.template
        ? { templateId: options.template.id, templateVersion: options.template.version }
        : existingRecord?.templateId
          ? {
              templateId: existingRecord.templateId,
              ...(existingRecord.templateVersion
                ? { templateVersion: existingRecord.templateVersion }
                : {})
            }
          : {})
    }

    try {
      this.registry.upsert(record)
    } catch (error) {
      // 代码已经换进去了，但状态没写成：必须把磁盘也退回去，否则用户会看到
      // 「旧版本号 + 新代码」。新目录直接删除，内容仍在安装源里。
      await fs.rm(target, { recursive: true, force: true }).catch(() => undefined)
      if (targetExists) await fs.rename(backup, target).catch(() => undefined)
      if (existingRecord) {
        await Promise.resolve(this.registry.upsert(existingRecord)).catch(() => undefined)
      }
      throw new ExtensionError(
        'EXTENSION_INSTALL_FAILED',
        error instanceof Error
          ? `扩展状态写入失败，已回滚：${error.message}`
          : '扩展状态写入失败，已回滚'
      )
    }

    let settled = false
    return {
      manifest,
      installPath: target,
      previousRecord: existingRecord,
      ...(existingRecord ? { previousVersion: existingRecord.version } : {}),
      upgraded: Boolean(existingRecord),
      rollback: async () => {
        if (settled) {
          throw new ExtensionError('EXTENSION_INSTALL_FAILED', '该安装结果已完成清理，无法回滚')
        }
        settled = true
        await fs.rm(target, { recursive: true, force: true }).catch(() => undefined)
        if (targetExists) await fs.rename(backup, target).catch(() => undefined)
        if (existingRecord) this.registry.upsert(existingRecord)
        else this.registry.remove(manifest.id)
      },
      cleanup: async () => {
        if (settled) return
        settled = true
        if (targetExists) {
          await fs.rm(backup, { recursive: true, force: true }).catch(() => undefined)
        }
      }
    }
  }

  /**
   * 把最近一次升级留下的过渡备份换回原位。
   *
   * 只在「新代码启动失败或状态不一致」时由用户显式触发；备份目录本身不删除，
   * 换回来的旧目录会被移到 `.failed-<ts>` 后清理，留下的是可运行的旧版本。
   */
  async restoreLatestBackup(
    extensionId: string
  ): Promise<{ restored: boolean; manifest?: ExtensionManifest }> {
    const target = this.paths.installDir(extensionId)
    if (!isPathInside(this.paths.extensionsDir, target)) {
      throw new ExtensionError('EXTENSION_INVALID_PATH', '扩展安装路径越界')
    }
    let backups: string[] = []
    try {
      backups = (await fs.readdir(this.paths.extensionsDir))
        .filter((name) => name.startsWith(`${extensionId}.backup-`))
        .sort()
    } catch {
      return { restored: false }
    }
    if (!backups.length) return { restored: false }

    const latest = path.join(this.paths.extensionsDir, backups[backups.length - 1])
    // 空 appVersion = 跳过兼容性拦截：用户要的是「回到能跑的那个版本」。
    const manifest = await this.readManifest(latest, '')
    const failed = `${target}.failed-${this.now()}`
    const targetExists = await fs
      .lstat(target)
      .then(() => true)
      .catch(() => false)
    if (targetExists) await fs.rename(target, failed)
    try {
      await fs.rename(latest, target)
    } catch (error) {
      if (targetExists) await fs.rename(failed, target).catch(() => undefined)
      throw new ExtensionError(
        'EXTENSION_INSTALL_FAILED',
        error instanceof Error ? error.message : '恢复备份失败'
      )
    }
    if (targetExists) {
      await fs.rm(failed, { recursive: true, force: true }).catch(() => undefined)
    }
    return { restored: true, manifest }
  }

  /**
   * 扫描已安装目录，重建最小 Registry 记录。
   *
   * 只读取 manifest 的**身份字段**，不继承启用状态与授权：磁盘上有代码，
   * 不等于用户同意运行它。manifest 无法解析的目录被跳过。
   *
   * 同步实现：Registry 的加载是同步的，恢复入口不能引入异步间隙。
   */
  recoverFromDisk(): ExtensionRegistryRecord[] {
    const records: ExtensionRegistryRecord[] = []
    let entries: nodeFs.Dirent[] = []
    try {
      entries = nodeFs.readdirSync(this.paths.extensionsDir, { withFileTypes: true })
    } catch {
      return records
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.includes('.backup-') || entry.name.includes('.removed')) continue
      const root = path.join(this.paths.extensionsDir, entry.name)
      try {
        const raw = JSON.parse(
          nodeFs.readFileSync(path.join(root, 'manifest.json'), 'utf8')
        ) as unknown
        const parsed = parseExtensionManifest(raw)
        if (!parsed.ok || !parsed.manifest) continue
        const stat = nodeFs.statSync(root)
        records.push({
          id: parsed.manifest.id,
          version: parsed.manifest.version,
          apiVersion: parsed.manifest.apiVersion,
          enabled: false,
          grantedPermissions: [],
          installedAt: Math.round(stat.birthtimeMs || stat.mtimeMs || 0),
          updatedAt: Math.round(stat.mtimeMs || 0),
          source: 'directory'
        })
      } catch {
        // 单个目录损坏不影响其余扩展的恢复。
      }
    }
    return records
  }
}

function normalizeZipPath(value: string): string {
  const normalized = String(value || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
  if (!isSafeRelativeEntryPath(normalized)) {
    throw new ExtensionError('EXTENSION_INVALID_PATH', `扩展包内路径不合法：${value}`)
  }
  return normalized
}

async function copyTree(root: string, destination: string, entries: TreeEntry[]): Promise<void> {
  for (const entry of entries) {
    const from = path.join(root, entry.relativePath)
    const to = path.resolve(destination, entry.relativePath)
    if (!isPathInside(destination, to)) {
      throw new ExtensionError('EXTENSION_INVALID_PATH', `复制路径越界：${entry.relativePath}`)
    }
    if (entry.type === 'directory') {
      await fs.mkdir(to, { recursive: true })
      continue
    }
    await fs.mkdir(path.dirname(to), { recursive: true })
    await fs.copyFile(from, to)
  }
}

/**
 * 与 shared 的 `parseExtensionManifestJson` 同构，但把「兼容性」与「格式」区分开，
 * 好让安装界面给出可操作的提示（升级 TraceMemo vs 修 manifest）。
 */
function parseExtensionManifestJsonWithDetail(
  text: string,
  appVersion: string
): ReturnType<typeof parseExtensionManifest> {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { ok: false, code: 'EXTENSION_INVALID_MANIFEST', message: 'manifest.json 不是合法 JSON' }
  }
  return parseExtensionManifest(value, { appVersion })
}
