import fs from 'fs-extra'
import path from 'node:path'
import { ExtensionError } from '../../shared/extensions/errors'

/** 加密实现由主进程注入（Electron `safeStorage`），本模块不直接依赖 electron。 */
export interface ExtensionSecretCipher {
  isAvailable: () => boolean
  encrypt: (plain: string) => Buffer
  decrypt: (payload: Buffer) => string
}

export interface ExtensionSecretStoreDependencies {
  /** 通常是 `<userData>/extensions-state/secrets`。 */
  root: string
  cipher: ExtensionSecretCipher
  now?: () => number
}

interface SecretFile {
  version: 1
  values: Record<string, string>
}

const MAX_KEY_LENGTH = 64
const MAX_VALUE_BYTES = 8 * 1024
const MAX_KEYS = 32
const SECRET_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/

/**
 * 扩展私有凭据。
 *
 * 设计取舍：
 * - 每个扩展一个文件、一个命名空间，A 扩展拿不到 B 的键；
 * - 落盘只有 `safeStorage` 加密后的密文，**不再产生明文 .txt**；
 * - 加密不可用时直接失败，绝不退化成明文——宁可让用户知道「这台机器不支持」，
 *   也不要把 Cookie 摊在磁盘上。
 *
 * 这不是操作系统级沙箱：扩展后台是拥有 Node 权限的本地进程，能读别的文件。
 * 它能防的是「普通 SDK / 页面桥跨扩展取密钥」与「意外明文落盘」。
 */
export class ExtensionSecretStore {
  private readonly root: string
  private readonly cipher: ExtensionSecretCipher
  private readonly now: () => number
  private readonly cache = new Map<string, SecretFile>()

  constructor(dependencies: ExtensionSecretStoreDependencies) {
    this.root = dependencies.root
    this.cipher = dependencies.cipher
    this.now = dependencies.now ?? (() => Date.now())
  }

  isAvailable(): boolean {
    try {
      return this.cipher.isAvailable()
    } catch {
      return false
    }
  }

  /** 只返回键名与数量，不返回值；供 UI 显示「是否已配置」。 */
  listKeys(extensionId: string): string[] {
    return Object.keys(this.read(extensionId).values).sort()
  }

  has(extensionId: string, key: string): boolean {
    const name = assertKey(key)
    return Object.prototype.hasOwnProperty.call(this.read(extensionId).values, name)
  }

  get(extensionId: string, key: string): string | null {
    const name = assertKey(key)
    const values = this.read(extensionId).values
    return Object.prototype.hasOwnProperty.call(values, name) ? values[name] : null
  }

  set(extensionId: string, key: string, value: string): void {
    const name = assertKey(key)
    if (typeof value !== 'string') throw new ExtensionError('INVALID_REQUEST', '凭据值必须是字符串')
    if (new TextEncoder().encode(value).length > MAX_VALUE_BYTES) {
      throw new ExtensionError('INVALID_REQUEST', '凭据超过 8KB 上限')
    }
    const file = this.read(extensionId)
    if (
      !Object.prototype.hasOwnProperty.call(file.values, name) &&
      Object.keys(file.values).length >= MAX_KEYS
    ) {
      throw new ExtensionError('INVALID_REQUEST', `单个扩展最多保存 ${MAX_KEYS} 个凭据`)
    }
    file.values[name] = value
    this.write(extensionId, file)
  }

  delete(extensionId: string, key: string): boolean {
    const name = assertKey(key)
    const file = this.read(extensionId)
    if (!Object.prototype.hasOwnProperty.call(file.values, name)) return false
    delete file.values[name]
    this.write(extensionId, file)
    return true
  }

  /** 卸载扩展且用户选择清除数据时调用。 */
  clear(extensionId: string): void {
    this.cache.delete(extensionId)
    fs.removeSync(this.filePath(extensionId))
  }

  private filePath(extensionId: string): string {
    return path.join(this.root, `${extensionId}.bin`)
  }

  private read(extensionId: string): SecretFile {
    const cached = this.cache.get(extensionId)
    if (cached) return { version: 1, values: { ...cached.values } }
    const file = this.filePath(extensionId)
    if (!fs.existsSync(file)) {
      const empty: SecretFile = { version: 1, values: {} }
      this.cache.set(extensionId, empty)
      return { version: 1, values: {} }
    }
    this.assertAvailable()
    let parsed: SecretFile
    try {
      const payload = fs.readFileSync(file)
      const text = this.cipher.decrypt(payload)
      const raw = JSON.parse(text) as unknown
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('结构不合法')
      const values: Record<string, string> = {}
      for (const [key, value] of Object.entries((raw as { values?: unknown }).values ?? {})) {
        if (SECRET_KEY_PATTERN.test(key) && typeof value === 'string') values[key] = value
      }
      parsed = { version: 1, values }
    } catch {
      // 解不开就当作没有：不能把损坏的密文当成空口令去覆盖（写盘会覆盖原文件）。
      throw new ExtensionError(
        'EXTENSION_STORAGE_CORRUPTED',
        '扩展凭据无法解密（可能换了机器或系统密钥变更），请在扩展页面重新填写'
      )
    }
    this.cache.set(extensionId, parsed)
    return { version: 1, values: { ...parsed.values } }
  }

  private write(extensionId: string, file: SecretFile): void {
    this.assertAvailable()
    const payload = this.cipher.encrypt(JSON.stringify({ version: 1, values: file.values }))
    fs.ensureDirSync(this.root)
    const target = this.filePath(extensionId)
    const temporary = `${target}.tmp`
    fs.writeFileSync(temporary, payload, { mode: 0o600 })
    fs.moveSync(temporary, target, { overwrite: true })
    try {
      fs.chmodSync(target, 0o600)
    } catch {
      // Windows 不支持 POSIX 权限位；忽略即可。
    }
    this.cache.set(extensionId, { version: 1, values: { ...file.values } })
    void this.now
  }

  private assertAvailable(): void {
    if (this.isAvailable()) return
    throw new ExtensionError('CAPABILITY_UNAVAILABLE', '当前系统不支持安全存储，扩展凭据功能不可用')
  }
}

function assertKey(value: string): string {
  const key = String(value ?? '').trim()
  if (!SECRET_KEY_PATTERN.test(key) || key.length > MAX_KEY_LENGTH) {
    throw new ExtensionError('INVALID_REQUEST', '凭据键名不合法')
  }
  return key
}
