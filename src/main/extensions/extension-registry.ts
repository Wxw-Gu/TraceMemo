import fs from 'fs-extra'
import path from 'node:path'
import {
  normalizeExtensionPermissions,
  type ExtensionPermission
} from '../../shared/extensions/permissions'
import { EXTENSION_API_VERSION } from '../../shared/extensions/manifest'

/**
 * 宿主侧的扩展安装状态。
 *
 * **manifest 不是状态的一部分**：它以扩展目录里的 `manifest.json` 为准，
 * 升级扩展只替换目录、不动这里的启用状态与权限授予。
 */
export interface ExtensionRegistryRecord {
  id: string
  version: string
  apiVersion: string
  enabled: boolean
  grantedPermissions: ExtensionPermission[]
  installedAt: number
  updatedAt: number
  source: 'directory' | 'package'
}

interface RegistryFile {
  version: number
  extensions: ExtensionRegistryRecord[]
}

const REGISTRY_VERSION = 1

function normalizeRecord(value: unknown): ExtensionRegistryRecord | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<ExtensionRegistryRecord>
  const id = String(raw.id || '').trim()
  if (!id) return null
  const installedAt = Number(raw.installedAt) || 0
  return {
    id,
    version: String(raw.version || '0.0.0'),
    apiVersion: String(raw.apiVersion || EXTENSION_API_VERSION),
    // 缺字段一律视为未启用：不能因为文件被手工改坏就自动跑任意代码。
    enabled: raw.enabled === true,
    grantedPermissions: normalizeExtensionPermissions(raw.grantedPermissions),
    installedAt,
    updatedAt: Number(raw.updatedAt) || installedAt,
    source: raw.source === 'package' ? 'package' : 'directory'
  }
}

export interface ExtensionRegistryDependencies {
  registryFile: string
  now?: () => number
}

export class ExtensionRegistry {
  private readonly registryFile: string
  private readonly now: () => number
  private state: RegistryFile = { version: REGISTRY_VERSION, extensions: [] }
  private loaded = false

  constructor(dependencies: ExtensionRegistryDependencies) {
    this.registryFile = dependencies.registryFile
    this.now = dependencies.now ?? (() => Date.now())
  }

  list(): ExtensionRegistryRecord[] {
    this.ensureLoaded()
    return this.state.extensions.map((record) => ({
      ...record,
      grantedPermissions: [...record.grantedPermissions]
    }))
  }

  get(id: string): ExtensionRegistryRecord | undefined {
    const key = String(id || '').trim()
    if (!key) return undefined
    return this.list().find((record) => record.id === key)
  }

  upsert(record: ExtensionRegistryRecord): ExtensionRegistryRecord {
    this.ensureLoaded()
    const exists = this.state.extensions.some((item) => item.id === record.id)
    const next = exists
      ? this.state.extensions.map((item) => (item.id === record.id ? record : item))
      : [...this.state.extensions, record]
    this.commit(next)
    return { ...record, grantedPermissions: [...record.grantedPermissions] }
  }

  remove(id: string): boolean {
    this.ensureLoaded()
    const next = this.state.extensions.filter((item) => item.id !== id)
    if (next.length === this.state.extensions.length) return false
    this.commit(next)
    return true
  }

  setEnabled(id: string, enabled: boolean): ExtensionRegistryRecord | undefined {
    const current = this.get(id)
    if (!current) return undefined
    return this.upsert({ ...current, enabled, updatedAt: this.now() })
  }

  setGrantedPermissions(
    id: string,
    permissions: ExtensionPermission[]
  ): ExtensionRegistryRecord | undefined {
    const current = this.get(id)
    if (!current) return undefined
    return this.upsert({
      ...current,
      grantedPermissions: normalizeExtensionPermissions(permissions),
      updatedAt: this.now()
    })
  }

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = fs.readJsonSync(this.registryFile) as unknown
      if (!raw || typeof raw !== 'object') return
      const list = (raw as { extensions?: unknown }).extensions
      if (!Array.isArray(list)) return
      this.state = {
        version: REGISTRY_VERSION,
        extensions: list
          .map((item) => normalizeRecord(item))
          .filter((item): item is ExtensionRegistryRecord => item !== null)
      }
    } catch {
      // 文件不存在 / 损坏都按「没有装过扩展」处理，不阻塞应用启动。
    }
  }

  private commit(extensions: ExtensionRegistryRecord[]): void {
    const previous = this.state
    this.state = { version: REGISTRY_VERSION, extensions }
    try {
      this.persist()
    } catch (error) {
      this.state = previous
      throw error
    }
  }

  private persist(): void {
    fs.ensureDirSync(path.dirname(this.registryFile))
    const temporary = `${this.registryFile}.tmp`
    fs.writeJsonSync(temporary, this.state, { spaces: 2 })
    fs.moveSync(temporary, this.registryFile, { overwrite: true })
  }
}
