import fs from 'fs-extra'
import path from 'node:path'
import { ExtensionError } from '../../shared/extensions/errors'

const STORAGE_FILE = 'storage.json'
const STORAGE_VERSION = 1
const MAX_KEY_LENGTH = 64
const MAX_VALUE_BYTES = 256 * 1024
const MAX_TOTAL_BYTES = 1024 * 1024
const KEY_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

interface StorageFile {
  version: number
  values: Record<string, unknown>
}

export interface ExtensionStorageDependencies {
  /** 通常是 `<userData>/extensions-data`。 */
  dataRoot: string
  maxTotalBytes?: number
  maxValueBytes?: number
}

/**
 * 扩展私有的键值存储。
 *
 * 边界：
 * - 每个扩展一个独立目录，键空间互不可见；
 * - 单值 / 总量都有上限，写入前先序列化，**不存无法序列化的值**；
 * - 卸载时由 `ExtensionInstaller` 决定是否删除，本类不主动清理。
 */
export class ExtensionStorage {
  private readonly dataRoot: string
  private readonly maxTotalBytes: number
  private readonly maxValueBytes: number

  constructor(dependencies: ExtensionStorageDependencies) {
    this.dataRoot = dependencies.dataRoot
    this.maxTotalBytes = dependencies.maxTotalBytes ?? MAX_TOTAL_BYTES
    this.maxValueBytes = dependencies.maxValueBytes ?? MAX_VALUE_BYTES
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
    return Object.prototype.hasOwnProperty.call(values, name) ? clone(values[name]) : undefined
  }

  set(extensionId: string, key: unknown, value: unknown): void {
    const name = assertKey(key)
    const serialized = serializeValue(value)
    if (Buffer.byteLength(serialized, 'utf8') > this.maxValueBytes) {
      throw new ExtensionError('STORAGE_LIMIT_EXCEEDED', '单个存储值超出上限')
    }
    const file = this.read(extensionId)
    file.values[name] = JSON.parse(serialized)
    this.assertTotalSize(file)
    this.write(extensionId, file)
  }

  remove(extensionId: string, key: unknown): boolean {
    const name = assertKey(key)
    const file = this.read(extensionId)
    if (!Object.prototype.hasOwnProperty.call(file.values, name)) return false
    delete file.values[name]
    this.write(extensionId, file)
    return true
  }

  list(extensionId: string): Array<{ key: string; value: unknown }> {
    const values = this.read(extensionId).values
    return Object.keys(values).map((key) => ({ key, value: clone(values[key]) }))
  }

  clear(extensionId: string): void {
    this.write(extensionId, { version: STORAGE_VERSION, values: {} })
  }

  private read(extensionId: string): StorageFile {
    const filePath = this.filePath(extensionId)
    try {
      const raw = fs.readJsonSync(filePath) as unknown
      if (!raw || typeof raw !== 'object') return { version: STORAGE_VERSION, values: {} }
      const values = (raw as { values?: unknown }).values
      if (!values || typeof values !== 'object' || Array.isArray(values)) {
        return { version: STORAGE_VERSION, values: {} }
      }
      return { version: STORAGE_VERSION, values: values as Record<string, unknown> }
    } catch {
      return { version: STORAGE_VERSION, values: {} }
    }
  }

  private write(extensionId: string, file: StorageFile): void {
    const filePath = this.filePath(extensionId)
    fs.ensureDirSync(path.dirname(filePath))
    const temporary = `${filePath}.tmp`
    fs.writeJsonSync(temporary, file, { spaces: 2 })
    fs.moveSync(temporary, filePath, { overwrite: true })
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
