import fs from 'fs-extra'
import path from 'node:path'
import { ExtensionError } from '../../shared/extensions/errors'
import type { ExtensionStorageHealthState } from '../../shared/extensions/types'

const STORAGE_FILE = 'storage.json'
const STORAGE_VERSION = 1
const MAX_KEY_LENGTH = 64
const MAX_VALUE_BYTES = 256 * 1024
const MAX_TOTAL_BYTES = 1024 * 1024
const KEY_PATTERN = /^[A-Za-z0-9._-]{1,64}$/
/** 每个扩展最多保留的损坏现场份数；超出时删除最旧的。 */
const CORRUPT_KEEP_LIMIT = 3

interface StorageFile {
  version: number
  values: Record<string, unknown>
}

export interface ExtensionStorageHealth {
  state: ExtensionStorageHealthState
  at: number
  /** 损坏现场的**文件名**（不含目录）；不渲染绝对路径。 */
  corruptFile?: string
  message?: string
}

export interface ExtensionStorageDependencies {
  /** 通常是 `<userData>/extensions-data`。 */
  dataRoot: string
  maxTotalBytes?: number
  maxValueBytes?: number
  now?: () => number
  /**
   * 健康状态发生变化时的通知。
   *
   * 运行期才发生损坏/回退时，宿主要靠这个立刻收住扩展——
   * 只等下一次启动才处理，那台机器人已经用旧配置发完消息了。
   */
  onHealthChange?: (extensionId: string, health: ExtensionStorageHealth) => void
}

type ParseResult = { ok: true; values: Record<string, unknown> } | { ok: false; reason: string }

function parseStorageText(text: string): ParseResult {
  if (!text.trim()) return { ok: false, reason: '存储文件为空' }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, reason: '存储文件不是合法 JSON' }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: '存储文件顶层不是对象' }
  }
  const version = Number((raw as { version?: unknown }).version)
  if (!Number.isInteger(version) || version !== STORAGE_VERSION) {
    return { ok: false, reason: '存储文件版本不受支持' }
  }
  const values = (raw as { values?: unknown }).values
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    return { ok: false, reason: 'values 不是对象' }
  }
  return { ok: true, values: values as Record<string, unknown> }
}

/**
 * 扩展私有的键值存储。
 *
 * 边界：
 * - 每个扩展一个独立目录，键空间互不可见；
 * - 单值 / 总量都有上限，写入前先序列化，**不存无法序列化的值**；
 * - 卸载时由 `ExtensionInstaller` 决定是否删除，本类不主动清理。
 *
 * 损坏语义：主文件解析失败时先尝试 `storage.json.bak`；两者都不可用时，
 * 该扩展进入 `unrecovered` 状态，`set` 会被拒绝。宁可让扩展报错，
 * 也不能用一次写入把用户唯一的一份配置覆盖成空。
 */
export class ExtensionStorage {
  private readonly dataRoot: string
  private readonly maxTotalBytes: number
  private readonly maxValueBytes: number
  private readonly now: () => number
  private readonly onHealthChange?: ExtensionStorageDependencies['onHealthChange']
  private readonly healthByExtension = new Map<string, ExtensionStorageHealth>()

  constructor(dependencies: ExtensionStorageDependencies) {
    this.dataRoot = dependencies.dataRoot
    this.maxTotalBytes = dependencies.maxTotalBytes ?? MAX_TOTAL_BYTES
    this.maxValueBytes = dependencies.maxValueBytes ?? MAX_VALUE_BYTES
    this.now = dependencies.now ?? (() => Date.now())
    this.onHealthChange = dependencies.onHealthChange
  }

  filePath(extensionId: string): string {
    return path.join(this.dataRoot, extensionId, STORAGE_FILE)
  }

  directory(extensionId: string): string {
    return path.join(this.dataRoot, extensionId)
  }

  get(extensionId: string, key: unknown): unknown {
    const name = assertKey(key)
    const values = this.read(extensionId).values
    this.assertReadable(extensionId)
    return Object.prototype.hasOwnProperty.call(values, name) ? clone(values[name]) : undefined
  }

  set(extensionId: string, key: unknown, value: unknown): void {
    const name = assertKey(key)
    const serialized = serializeValue(value)
    if (Buffer.byteLength(serialized, 'utf8') > this.maxValueBytes) {
      throw new ExtensionError('STORAGE_LIMIT_EXCEEDED', '单个存储值超出上限')
    }
    const file = this.read(extensionId)
    this.assertReadable(extensionId)
    file.values[name] = JSON.parse(serialized)
    this.assertTotalSize(file)
    this.write(extensionId, file)
  }

  remove(extensionId: string, key: unknown): boolean {
    const name = assertKey(key)
    const file = this.read(extensionId)
    this.assertReadable(extensionId)
    if (!Object.prototype.hasOwnProperty.call(file.values, name)) return false
    delete file.values[name]
    this.write(extensionId, file)
    return true
  }

  list(extensionId: string): Array<{ key: string; value: unknown }> {
    const values = this.read(extensionId).values
    this.assertReadable(extensionId)
    return Object.keys(values).map((key) => ({ key, value: clone(values[key]) }))
  }

  clear(extensionId: string): void {
    this.write(extensionId, { version: STORAGE_VERSION, values: {} })
  }

  /**
   * 显式重置：保留损坏现场，然后把存储清空。
   *
   * 只允许用户从界面触发；扩展自身不能调用（`tm.storage` 没有这个能力）。
   */
  reset(extensionId: string): void {
    this.read(extensionId)
    this.writeState(extensionId, { version: STORAGE_VERSION, values: {} }, { rotateBackup: false })
    this.healthByExtension.set(extensionId, { state: 'ok', at: this.now() })
  }

  /**
   * 用户确认「接受从备份恢复出来的配置」。
   *
   * 恢复出来的内容可能落后一版——比如机器人开关还停在 `true`。
   * 在用户点这一下之前，宿主不会启动该扩展（见 `ExtensionManager` 的启动前检查）。
   */
  acknowledge(extensionId: string): void {
    const current = this.health(extensionId)
    if (current.state !== 'recovered-from-backup') {
      throw new ExtensionError('INVALID_REQUEST', '当前没有待确认的配置恢复')
    }
    this.healthByExtension.set(extensionId, { state: 'ok', at: this.now() })
  }

  /**
   * 未确认的恢复 / 无法恢复时，读写一律拒绝。
   *
   * 只让 `health()` 与 `reset()` / `acknowledge()` 能穿过这道闸：
   * 前者给界面看状态，后两者是用户的显式处理动作。
   */
  private assertReadable(extensionId: string): void {
    const health = this.healthByExtension.get(extensionId)
    if (!health || health.state === 'ok') return
    if (health.state === 'recovered-from-backup') {
      throw new ExtensionError(
        'EXTENSION_STORAGE_CORRUPTED',
        '扩展配置刚从备份恢复，用户确认前读写已暂停'
      )
    }
    throw new ExtensionError('EXTENSION_STORAGE_CORRUPTED', '扩展配置已损坏且没有可用备份')
  }

  private reportHealth(extensionId: string, health: ExtensionStorageHealth): void {
    this.healthByExtension.set(extensionId, health)
    if (health.state === 'ok') return
    try {
      this.onHealthChange?.(extensionId, health)
    } catch {
      // 通知失败不能反过来影响存储读写。
    }
  }

  health(extensionId: string): ExtensionStorageHealth {
    this.read(extensionId)
    return { ...(this.healthByExtension.get(extensionId) ?? { state: 'ok', at: this.now() }) }
  }

  private read(extensionId: string): StorageFile {
    const filePath = this.filePath(extensionId)
    if (!fs.existsSync(filePath)) {
      this.reportHealth(extensionId, { state: 'ok', at: this.now() })
      return { version: STORAGE_VERSION, values: {} }
    }

    let text: string
    try {
      text = fs.readFileSync(filePath, 'utf8')
    } catch (error) {
      this.reportHealth(extensionId, {
        state: 'unrecovered',
        at: this.now(),
        message: error instanceof Error ? error.message.slice(0, 200) : '无法读取扩展配置'
      })
      return { version: STORAGE_VERSION, values: {} }
    }

    const parsed = parseStorageText(text)
    if (parsed.ok) {
      // `recovered-from-backup` 要保留到用户看到它为止：恢复成功后立刻改回 `ok`，
      // 界面就再也不会提示「这份配置曾经损坏过」。
      const current = this.healthByExtension.get(extensionId)
      if (current?.state !== 'recovered-from-backup') {
        this.reportHealth(extensionId, { state: 'ok', at: this.now() })
      }
      return { version: STORAGE_VERSION, values: parsed.values }
    }

    const corruptFile = this.preserveCorrupt(extensionId, text)
    const backup = this.tryLoadBackup(extensionId)
    if (backup) {
      this.reportHealth(extensionId, {
        state: 'recovered-from-backup',
        at: this.now(),
        ...(corruptFile ? { corruptFile } : {}),
        message: '扩展配置损坏，已从备份恢复'
      })
      try {
        // 主文件此刻是坏的，不能让它进入备份轮换，否则会覆盖刚读到的有效备份。
        this.writeState(
          extensionId,
          { version: STORAGE_VERSION, values: backup },
          { rotateBackup: false }
        )
      } catch {
        // 提升备份失败时仍返回备份内容，下次写入会再试。
      }
      return { version: STORAGE_VERSION, values: backup }
    }

    this.reportHealth(extensionId, {
      state: 'unrecovered',
      at: this.now(),
      ...(corruptFile ? { corruptFile } : {}),
      message: '扩展配置损坏且没有可用备份；写入已停止以保留现场'
    })
    return { version: STORAGE_VERSION, values: {} }
  }

  private tryLoadBackup(extensionId: string): Record<string, unknown> | null {
    const backupPath = `${this.filePath(extensionId)}.bak`
    try {
      if (!fs.existsSync(backupPath)) return null
      const parsed = parseStorageText(fs.readFileSync(backupPath, 'utf8'))
      return parsed.ok ? parsed.values : null
    } catch {
      return null
    }
  }

  private preserveCorrupt(extensionId: string, text: string): string | undefined {
    const filePath = this.filePath(extensionId)
    const base = `${filePath}.corrupt-${this.now().toString(36)}`
    let target = base
    let index = 1
    while (fs.existsSync(target)) {
      target = `${base}-${index}`
      index += 1
    }
    try {
      fs.ensureDirSync(path.dirname(filePath))
      fs.writeFileSync(target, text, 'utf8')
      this.pruneCorruptFiles(extensionId)
      return path.basename(target)
    } catch {
      return undefined
    }
  }

  private pruneCorruptFiles(extensionId: string): void {
    try {
      const directory = path.dirname(this.filePath(extensionId))
      const prefix = `${STORAGE_FILE}.corrupt-`
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

  private write(extensionId: string, file: StorageFile): void {
    this.writeState(extensionId, file, { rotateBackup: true })
    this.reportHealth(extensionId, { state: 'ok', at: this.now() })
  }

  /**
   * 主文件 → `.bak` → 新内容。
   *
   * `rotateBackup` 只在主文件可信时为真：从备份恢复、显式重置这两条路径
   * 面对的主文件都是坏的，让它们参与轮换会把有效备份一起换掉。
   */
  private writeState(
    extensionId: string,
    file: StorageFile,
    options: { rotateBackup: boolean }
  ): void {
    const filePath = this.filePath(extensionId)
    fs.ensureDirSync(path.dirname(filePath))
    if (options.rotateBackup) this.rotateBackup(extensionId)
    const temporary = `${filePath}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(file, null, 2), 'utf8')
    const parsed = parseStorageText(fs.readFileSync(temporary, 'utf8'))
    if (!parsed.ok) {
      fs.removeSync(temporary)
      throw new ExtensionError('STORAGE_LIMIT_EXCEEDED', `写入前校验失败：${parsed.reason}`)
    }
    fs.moveSync(temporary, filePath, { overwrite: true })
  }

  private rotateBackup(extensionId: string): void {
    const filePath = this.filePath(extensionId)
    if (!fs.existsSync(filePath)) return
    const backupPath = `${filePath}.bak`
    const temporary = `${backupPath}.tmp`
    try {
      fs.copyFileSync(filePath, temporary)
      const parsed = parseStorageText(fs.readFileSync(temporary, 'utf8'))
      if (!parsed.ok) {
        fs.removeSync(temporary)
        return
      }
      fs.moveSync(temporary, backupPath, { overwrite: true })
    } catch {
      fs.removeSync(temporary)
    }
  }

  private assertTotalSize(file: StorageFile): void {
    const bytes = Buffer.byteLength(JSON.stringify(file.values), 'utf8')
    if (bytes > this.maxTotalBytes) {
      throw new ExtensionError('STORAGE_LIMIT_EXCEEDED', '扩展存储总量超出上限')
    }
  }
}

function assertKey(value: unknown): string {
  if (typeof value !== 'string') throw new ExtensionError('INVALID_REQUEST', '存储键必须是字符串')
  const key = value.trim()
  if (!KEY_PATTERN.test(key)) {
    throw new ExtensionError('INVALID_REQUEST', '存储键只能包含字母、数字、点、下划线与短横线')
  }
  if (key.length > MAX_KEY_LENGTH) throw new ExtensionError('INVALID_REQUEST', '存储键过长')
  return key
}

function serializeValue(value: unknown): string {
  if (value === undefined) throw new ExtensionError('INVALID_REQUEST', '不能存储 undefined')
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) throw new Error('unsupported')
    return serialized
  } catch {
    throw new ExtensionError('INVALID_REQUEST', '存储值必须可序列化为 JSON')
  }
}

function clone<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  return JSON.parse(JSON.stringify(value)) as T
}
