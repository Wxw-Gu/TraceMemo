import fs from 'fs-extra'
import path from 'node:path'
import {
  normalizeExtensionPermissions,
  type ExtensionPermission
} from '../../shared/extensions/permissions'
import { EXTENSION_API_VERSION, isValidExtensionId } from '../../shared/extensions/manifest'
import { ExtensionError } from '../../shared/extensions/errors'
import { normalizeExtensionSource, type ExtensionSource } from '../../shared/extensions/source'

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
  source: ExtensionSource
  /** 来源为 `template` 时，记录是哪个官方模板装入的。 */
  templateId?: string
  templateVersion?: string
  /**
   * 来源为 `development` 时的外部源码目录（本机绝对路径）。
   *
   * 只属于这台机器的安装状态，不随扩展源码分发；换机器要重新链接。
   */
  developmentSourcePath?: string
  /**
   * 安装时的代码指纹；用于判断用户是否改过 `extensions/<id>` 里的副本。
   * 缺失表示无法判断（旧版本安装或指纹计算失败），更新时必须保守处理。
   */
  installedCodeDigest?: string
}

/**
 * 一次恢复的记录。
 *
 * 写进状态文件而不是只放在内存里：用户看到「状态曾损坏」之后重启，
 * 提示必须还在，否则他永远不知道自己的启用状态被重置过。
 */
export interface ExtensionRegistryRecovery {
  at: number
  kind: 'backup' | 'scan'
  /** 损坏现场的**文件名**（不含目录）。 */
  corruptFile?: string
}

interface RegistryFile {
  version: number
  extensions: ExtensionRegistryRecord[]
  recovery?: ExtensionRegistryRecovery
}

const REGISTRY_VERSION = 1
/** 损坏现场最多保留的份数；超出时删除最旧的一份。 */
const CORRUPT_KEEP_LIMIT = 3

/**
 * 状态文件的可信度。
 *
 * - `ok`：主文件有效，或文件不存在（全新安装，属于合法空状态）。
 * - `recovered-from-backup`：主文件损坏，用 `.bak` 重建过；记录已降级。
 * - `recovered-by-scan`：主文件与备份都不可用，由调用方扫描扩展目录重建；
 *   记录一律降级为「未启用 + 无授权」。
 * - `unreadable`：无法读取且无法重建。此状态下**拒绝任何写入**，
 *   否则会用空状态覆盖唯一可能人工抢救的现场。
 */
export type ExtensionRegistryHealthState =
  | 'ok'
  | 'recovered-from-backup'
  | 'recovered-by-scan'
  | 'unreadable'

export interface ExtensionRegistryHealth {
  state: ExtensionRegistryHealthState
  at: number
  /** 损坏现场的**文件名**（不含目录）；用于日志与排查，不渲染绝对路径。 */
  corruptFile?: string
  message?: string
}

export interface ExtensionRegistryDependencies {
  registryFile: string
  now?: () => number
  /**
   * 主文件与备份均不可用时的重建来源。
   *
   * 返回的记录会被强制改写为 `enabled: false`、`grantedPermissions: []`：
   * 扫描到磁盘上有代码，不等于用户同意运行它。
   */
  recover?: () => ExtensionRegistryRecord[]
}

type ParseResult =
  | { ok: true; extensions: ExtensionRegistryRecord[]; recovery?: ExtensionRegistryRecovery }
  | { ok: false; reason: string }

function parseRegistryText(text: string): ParseResult {
  if (!text.trim()) return { ok: false, reason: '状态文件为空' }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, reason: '状态文件不是合法 JSON' }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: '状态文件顶层不是对象' }
  }
  const version = Number((raw as { version?: unknown }).version)
  if (!Number.isInteger(version) || version < 1 || version > REGISTRY_VERSION) {
    return { ok: false, reason: '状态文件版本不受支持' }
  }
  const list = (raw as { extensions?: unknown }).extensions
  if (!Array.isArray(list)) return { ok: false, reason: 'extensions 不是数组' }

  const extensions: ExtensionRegistryRecord[] = []
  const seen = new Set<string>()
  for (const [index, item] of list.entries()) {
    const parsed = parseRecord(item)
    if (!parsed) return { ok: false, reason: `第 ${index + 1} 条扩展记录不合法` }
    if (seen.has(parsed.id)) return { ok: false, reason: `扩展 id 重复：${parsed.id}` }
    seen.add(parsed.id)
    extensions.push(parsed)
  }
  return { ok: true, extensions, recovery: parseRecovery((raw as { recovery?: unknown }).recovery) }
}

function parseRecovery(value: unknown): ExtensionRegistryRecovery | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const at = Number(raw.at)
  if (!Number.isFinite(at) || at <= 0) return undefined
  const kind = raw.kind === 'backup' ? 'backup' : raw.kind === 'scan' ? 'scan' : null
  if (!kind) return undefined
  const corruptFile =
    typeof raw.corruptFile === 'string' && raw.corruptFile.trim()
      ? raw.corruptFile.trim().slice(0, 200)
      : undefined
  return { at, kind, ...(corruptFile ? { corruptFile } : {}) }
}

/**
 * 单条记录的严格解析。
 *
 * 与「尽量兼容」相反：字段类型明显不对时整份文件判为损坏，由上层进入恢复流程。
 * 静默丢弃单条记录等于「部分数据丢失且不告知用户」。
 */
function parseRecord(value: unknown): ExtensionRegistryRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const id = String(raw.id ?? '').trim()
  if (!isValidExtensionId(id)) return null
  if (typeof raw.version !== 'string' || !raw.version.trim()) return null

  const installedAt = Number(raw.installedAt)
  const updatedAt = Number(raw.updatedAt)
  const templateId =
    typeof raw.templateId === 'string' && raw.templateId.trim()
      ? raw.templateId.trim().slice(0, 64)
      : undefined
  const templateVersion =
    typeof raw.templateVersion === 'string' && raw.templateVersion.trim()
      ? raw.templateVersion.trim().slice(0, 32)
      : undefined
  const developmentSourcePath =
    typeof raw.developmentSourcePath === 'string' && raw.developmentSourcePath.trim()
      ? raw.developmentSourcePath.trim().slice(0, 1024)
      : undefined
  const installedCodeDigest =
    typeof raw.installedCodeDigest === 'string' && /^[a-f0-9]{64}$/.test(raw.installedCodeDigest)
      ? raw.installedCodeDigest
      : undefined
  return {
    id,
    version: raw.version.trim().slice(0, 32),
    apiVersion:
      typeof raw.apiVersion === 'string' && raw.apiVersion.trim()
        ? raw.apiVersion.trim().slice(0, 16)
        : EXTENSION_API_VERSION,
    // 缺字段一律视为未启用：不能因为文件被手工改坏就自动跑任意代码。
    enabled: raw.enabled === true,
    grantedPermissions: normalizeExtensionPermissions(raw.grantedPermissions),
    installedAt: Number.isFinite(installedAt) && installedAt > 0 ? installedAt : 0,
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : 0,
    // 未知来源归为 `directory`：来源只能由可信的安装入口赋予，不能从文件里猜。
    source: normalizeExtensionSource(raw.source),
    ...(templateId ? { templateId } : {}),
    ...(templateVersion ? { templateVersion } : {}),
    ...(developmentSourcePath ? { developmentSourcePath } : {}),
    ...(installedCodeDigest ? { installedCodeDigest } : {})
  }
}

export class ExtensionRegistry {
  private readonly registryFile: string
  private readonly backupFile: string
  private readonly now: () => number
  private readonly recoverByScan: (() => ExtensionRegistryRecord[]) | null
  private state: RegistryFile = { version: REGISTRY_VERSION, extensions: [] }
  private loaded = false
  /**
   * 主文件当前是否含可解析内容。
   *
   * 备份轮换只在这个标记为真时执行：主文件已经损坏时复制它，会把唯一的
   * 有效备份也换成坏数据。
   */
  private primaryValid = false
  /** 只有 `unreadable` 需要内存态：连状态文件都写不进去，自然无法持久化。 */
  private unreadable: ExtensionRegistryHealth | null = null

  constructor(dependencies: ExtensionRegistryDependencies) {
    this.registryFile = dependencies.registryFile
    this.backupFile = `${dependencies.registryFile}.bak`
    this.now = dependencies.now ?? (() => Date.now())
    this.recoverByScan = dependencies.recover ?? null
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

  /** 状态文件的可信度；非 `ok` 时调用方必须向用户暴露，而不是当作「没装扩展」。 */
  getHealth(): ExtensionRegistryHealth {
    this.ensureLoaded()
    if (this.unreadable) return { ...this.unreadable }
    const recovery = this.state.recovery
    if (!recovery) return { state: 'ok', at: this.now() }
    return {
      state: recovery.kind === 'backup' ? 'recovered-from-backup' : 'recovered-by-scan',
      at: recovery.at,
      ...(recovery.corruptFile ? { corruptFile: recovery.corruptFile } : {}),
      message:
        recovery.kind === 'backup'
          ? '扩展状态文件损坏，已从备份重建；所有扩展已暂停，请重新确认后启用'
          : '扩展状态文件与备份均不可用，已按磁盘目录重建；所有扩展已暂停，请重新确认后启用'
    }
  }

  /**
   * 用户确认「我知道发生过恢复」。
   *
   * 只清除提示标记，不改动任何扩展的启用状态与授权——那些已经由恢复流程
   * 降级为「未启用 + 无授权」，需要用户逐个重新授权。
   */
  acknowledgeRecovery(): boolean {
    this.ensureLoaded()
    if (!this.state.recovery) return false
    const previous = this.state
    this.state = { version: REGISTRY_VERSION, extensions: this.state.extensions }
    try {
      this.persist()
    } catch (error) {
      this.state = previous
      throw error
    }
    return true
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
    this.load()
  }

  private load(): void {
    const stamp = this.now()

    if (!fs.existsSync(this.registryFile)) {
      // 文件不存在是合法状态（首次安装），不是损坏。
      this.state = { version: REGISTRY_VERSION, extensions: [] }
      this.primaryValid = false
      return
    }

    let text: string
    try {
      text = fs.readFileSync(this.registryFile, 'utf8')
    } catch (error) {
      // 读取失败（权限、IO）与「内容损坏」是两件事：不移动文件，也不尝试覆盖。
      this.state = { version: REGISTRY_VERSION, extensions: [] }
      this.primaryValid = false
      this.unreadable = {
        state: 'unreadable',
        at: stamp,
        message: error instanceof Error ? error.message.slice(0, 200) : '无法读取扩展状态文件'
      }
      return
    }

    const parsed = parseRegistryText(text)
    if (parsed.ok) {
      this.state = {
        version: REGISTRY_VERSION,
        extensions: parsed.extensions,
        ...(parsed.recovery ? { recovery: parsed.recovery } : {})
      }
      this.primaryValid = true
      return
    }

    const corruptFile = this.preserveCorrupt(text)

    const backup = this.tryLoadBackup()
    if (backup) {
      this.state = this.buildRecoveredState(backup, 'backup', corruptFile)
      this.primaryValid = false
      // 立即把降级后的状态写回主文件：恢复提示与「全部暂停」必须能跨重启保留。
      try {
        this.writeState(this.state)
        this.primaryValid = true
      } catch {
        // 保留内存状态即可，启动不应因为一次修复失败而中断。
      }
      return
    }

    const scanned = this.scan()
    if (scanned) {
      this.state = this.buildRecoveredState(scanned, 'scan', corruptFile)
      this.primaryValid = false
      // 刻意不写盘：损坏现场仍留在原位，用户可以在修复后重新读取。
      // 一旦用户执行任何写操作（启用/卸载），降级结果与恢复标记会一并落盘。
      return
    }

    this.state = { version: REGISTRY_VERSION, extensions: [] }
    this.primaryValid = false
    this.unreadable = {
      state: 'unreadable',
      at: stamp,
      ...(corruptFile ? { corruptFile } : {}),
      message: '扩展状态文件损坏且无法恢复；为避免覆盖现场，已停止写入'
    }
  }

  /**
   * 恢复出来的状态一律降级。
   *
   * 备份最多落后一版，它可能记录着用户随后撤销的授权或关闭的开关。
   * 自动采纳等于「把用户已经收回的权限再发回去」，所以只保留身份与版本，
   * 启用状态与授权全部清零，等用户重新确认。
   */
  private buildRecoveredState(
    records: ExtensionRegistryRecord[],
    kind: 'backup' | 'scan',
    corruptFile?: string
  ): RegistryFile {
    return {
      version: REGISTRY_VERSION,
      extensions: records.map((record) => ({
        ...record,
        enabled: false,
        grantedPermissions: [],
        updatedAt: this.now()
      })),
      recovery: {
        at: this.now(),
        kind,
        ...(corruptFile ? { corruptFile } : {})
      }
    }
  }

  private tryLoadBackup(): ExtensionRegistryRecord[] | null {
    try {
      if (!fs.existsSync(this.backupFile)) return null
      const parsed = parseRegistryText(fs.readFileSync(this.backupFile, 'utf8'))
      return parsed.ok ? parsed.extensions : null
    } catch {
      return null
    }
  }

  private scan(): ExtensionRegistryRecord[] | null {
    if (!this.recoverByScan) return null
    let records: ExtensionRegistryRecord[]
    try {
      records = this.recoverByScan()
    } catch {
      return null
    }
    if (!Array.isArray(records)) return null
    // 扫描结果只用于「知道有哪些扩展存在」，不继承任何授权或启用状态。
    return records.map((record) => ({
      ...record,
      enabled: false,
      grantedPermissions: [],
      source: 'directory' as const
    }))
  }

  /**
   * 把损坏内容写到 `.corrupt-<时间戳>`。
   *
   * 保留现场是恢复的前提：用户可能手工修好它，或者授权更高版本的 TraceMemo 读取。
   */
  private preserveCorrupt(text: string): string | undefined {
    const base = `${this.registryFile}.corrupt-${this.now().toString(36)}`
    let target = base
    let index = 1
    while (fs.existsSync(target)) {
      target = `${base}-${index}`
      index += 1
    }
    try {
      fs.writeFileSync(target, text, 'utf8')
      this.pruneCorruptFiles()
      return path.basename(target)
    } catch {
      return undefined
    }
  }

  private pruneCorruptFiles(): void {
    try {
      const directory = path.dirname(this.registryFile)
      const prefix = `${path.basename(this.registryFile)}.corrupt-`
      const files = fs
        .readdirSync(directory)
        .filter((name) => name.startsWith(prefix))
        .map((name) => ({ name, at: fs.statSync(path.join(directory, name)).mtimeMs }))
        .sort((left, right) => left.at - right.at)
      for (const file of files.slice(0, Math.max(0, files.length - CORRUPT_KEEP_LIMIT))) {
        fs.removeSync(path.join(directory, file.name))
      }
    } catch {
      // 清理失败不影响恢复本身。
    }
  }

  private commit(extensions: ExtensionRegistryRecord[]): void {
    const previous = this.state
    const previousValid = this.primaryValid
    // 恢复标记必须跟着普通写入一起保留：否则用户启用一个扩展就把
    // 「其余扩展全部暂停过」的提示抹掉了。
    this.state = {
      version: REGISTRY_VERSION,
      extensions,
      ...(previous.recovery ? { recovery: previous.recovery } : {})
    }
    try {
      this.persist()
    } catch (error) {
      this.state = previous
      this.primaryValid = previousValid
      throw error
    }
  }

  private persist(): void {
    if (this.unreadable) {
      throw new ExtensionError(
        'EXTENSION_REGISTRY_UNREADABLE',
        '扩展状态文件损坏且无法恢复，已拒绝写入以保留现场'
      )
    }
    this.rotateBackup()
    this.writeState(this.state)
    this.primaryValid = true
  }

  /**
   * 用当前主文件刷新 `.bak`。
   *
   * 三重保护：
   * 1. 主文件不可信（`primaryValid === false`）时直接跳过；
   * 2. 先写 `.bak.tmp` 并重新解析，拒绝把坏内容升级成备份；
   * 3. 成功后才 rename 覆盖旧备份，失败时旧备份原样保留。
   */
  private rotateBackup(): void {
    if (!this.primaryValid) return
    if (!fs.existsSync(this.registryFile)) return
    const temporary = `${this.backupFile}.tmp`
    try {
      fs.copyFileSync(this.registryFile, temporary)
      const parsed = parseRegistryText(fs.readFileSync(temporary, 'utf8'))
      if (!parsed.ok) {
        fs.removeSync(temporary)
        return
      }
      fs.moveSync(temporary, this.backupFile, { overwrite: true })
    } catch {
      fs.removeSync(temporary)
    }
  }

  /** 临时文件 → 读回校验 → 原子替换；中途失败不会留下半写的主文件。 */
  private writeState(state: RegistryFile): void {
    const directory = path.dirname(this.registryFile)
    fs.ensureDirSync(directory)
    const temporary = `${this.registryFile}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2), 'utf8')
    const parsed = parseRegistryText(fs.readFileSync(temporary, 'utf8'))
    if (!parsed.ok) {
      fs.removeSync(temporary)
      throw new ExtensionError('EXTENSION_REGISTRY_UNREADABLE', `写入前校验失败：${parsed.reason}`)
    }
    fs.moveSync(temporary, this.registryFile, { overwrite: true })
  }
}
