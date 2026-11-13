import { promises as fs } from 'node:fs'
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

const MAX_FILES = 2_000
const MAX_TOTAL_BYTES = 50 * 1024 * 1024
const MAX_FILE_BYTES = 20 * 1024 * 1024
const MAX_PACKAGE_BYTES = 100 * 1024 * 1024

export interface InstallOptions {
  /** 应用版本，用于 `minAppVersion` 兼容检查。 */
  appVersion: string
  source?: 'directory' | 'package'
}

export interface InstallOutcome {
  manifest: ExtensionManifest
  installPath: string
  previousVersion?: string
  upgraded: boolean
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
      return await this.finalize(staging, manifest, options.source ?? 'directory')
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
      return await this.finalize(staging, manifest, 'package')
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
    const exists = await fs
      .stat(target)
      .then(() => true)
      .catch(() => false)
    if (exists) {
      await fs.rename(target, trash)
      await fs.rm(trash, { recursive: true, force: true }).catch(() => undefined)
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

  /** 临时目录 → 目标目录的原子替换。升级时保留 registry 里的启用状态与授权。 */
  private async finalize(
    staging: string,
    manifest: ExtensionManifest,
    source: 'directory' | 'package'
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
    if (targetExists) await fs.rm(backup, { recursive: true, force: true }).catch(() => undefined)

    const timestamp = this.now()
    const record: ExtensionRegistryRecord = {
      id: manifest.id,
      version: manifest.version,
      apiVersion: manifest.apiVersion,
      // 升级不改变启用状态：升级后突然开始跑代码是用户没有同意的行为变化。
      enabled: existingRecord?.enabled ?? false,
      grantedPermissions: existingRecord?.grantedPermissions ?? [],
      installedAt: existingRecord?.installedAt ?? timestamp,
      updatedAt: timestamp,
      source
    }
    this.registry.upsert(record)

    return {
      manifest,
      installPath: target,
      ...(existingRecord ? { previousVersion: existingRecord.version } : {}),
      upgraded: Boolean(existingRecord)
    }
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
