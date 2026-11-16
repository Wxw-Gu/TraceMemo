import path from 'node:path'
import { app } from 'electron'

/**
 * 扩展相关目录的唯一解析器。
 *
 * **所有扩展文件都在 `userData` 下**，与安装目录 / `app.asar` / 源码树完全分离：
 * 官方升级只替换应用本体，不会碰这三个目录。Windows 与 macOS 的差异由
 * `app.getPath('userData')` 吸收，调用方不假设任何绝对路径。
 *
 * ```text
 * <userData>/extensions/<id>/            扩展代码（manifest + ui + background）
 * <userData>/extensions-data/<id>/       扩展私有数据（配置、缓存）
 * <userData>/extensions-state/           宿主状态（registry、日志）
 * <userData>/extensions-staging/         安装临时目录（成功后原子改名，不留半装状态）
 * ```
 */
export interface ExtensionPaths {
  userData: string
  extensionsDir: string
  dataDir: string
  stateDir: string
  stagingDir: string
  registryFile: string
  logsDir: string
  installDir: (extensionId: string) => string
  extensionDataDir: (extensionId: string) => string
  logFile: (extensionId: string) => string
  stagingPath: (prefix: string) => string
}

export function createExtensionPaths(userData: string): ExtensionPaths {
  const extensionsDir = path.join(userData, 'extensions')
  const dataDir = path.join(userData, 'extensions-data')
  const stateDir = path.join(userData, 'extensions-state')
  const stagingDir = path.join(userData, 'extensions-staging')
  const logsDir = path.join(stateDir, 'logs')
  return {
    userData,
    extensionsDir,
    dataDir,
    stateDir,
    stagingDir,
    registryFile: path.join(stateDir, 'registry.json'),
    logsDir,
    installDir: (extensionId) => path.join(extensionsDir, extensionId),
    extensionDataDir: (extensionId) => path.join(dataDir, extensionId),
    logFile: (extensionId) => path.join(logsDir, `${extensionId}.jsonl`),
    stagingPath: (prefix) => path.join(stagingDir, `${prefix}-${Date.now().toString(36)}`)
  }
}

let cached: ExtensionPaths | null = null

/** 懒解析：`app.getPath` 必须在 app ready 之后才可靠。 */
export function getExtensionPaths(): ExtensionPaths {
  if (!cached) cached = createExtensionPaths(app.getPath('userData'))
  return cached
}

/**
 * 判断 `child` 是否在 `parent` 内（含自身）。符号链接需调用方先 realpath。
 *
 * Windows 上盘符大小写、分隔符与短文件名都可能让字符串比较失手，
 * 这里统一把两侧规范化后再比：`path.resolve` 处理分隔符，Windows 额外折叠大小写。
 */
export function isPathInside(parent: string, child: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  const relative = path.relative(normalize(parent), normalize(child))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/** 只比路径本身，不跟随符号链接；用于判断两个字符串是否指向同一位置。 */
export function isSamePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  return normalize(left) === normalize(right)
}
