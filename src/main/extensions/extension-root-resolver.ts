import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ExtensionError } from '../../shared/extensions/errors'
import type { ExtensionSource } from '../../shared/extensions/source'
import { isPathInside, isSamePath, type ExtensionPaths } from './extension-paths'
import type { ExtensionRegistryRecord } from './extension-registry'

export interface ExtensionRootInfo {
  extensionId: string
  /** 代码根目录（已 realpath）。 */
  root: string
  source: ExtensionSource
  /** 开发模式下用户选择时的目录（同样是 realpath）。 */
  developmentSourcePath?: string
}

export interface ExtensionRootResolver {
  /**
   * 解析扩展代码根目录。
   *
   * 抛 `EXTENSION_SOURCE_MISSING` 表示开发目录不可用；调用方必须保留 Registry
   * 与配置，把扩展标成「源码目录不可用」，而不是当成「没装过」。
   */
  resolve(extensionId: string): ExtensionRootInfo
  /** 只看正式安装目录，用于导出、回滚等必须触碰安装副本的场景。 */
  installedRoot(extensionId: string): string
}

export interface ExtensionRootResolverDependencies {
  paths: ExtensionPaths
  getRecord: (extensionId: string) => ExtensionRegistryRecord | undefined
  /** 测试注入点。 */
  realpath?: (target: string) => string
  stat?: (target: string) => { isDirectory: () => boolean }
}

/**
 * 所有扩展代码根目录的唯一来源。
 *
 * 在这之前，代码目录被 manager、protocol、catalog 各自拼 `paths.installDir(id)`，
 * 开发模式一旦接入就会出现「后台读外部目录、页面读安装副本」的错位。
 */
export function createExtensionRootResolver(
  dependencies: ExtensionRootResolverDependencies
): ExtensionRootResolver {
  const realpath = dependencies.realpath ?? ((target: string) => fs.realpathSync(target))
  const stat = dependencies.stat ?? ((target: string) => fs.statSync(target))

  function resolveInstalled(extensionId: string): string {
    return dependencies.paths.installDir(extensionId)
  }

  return {
    installedRoot: resolveInstalled,

    resolve(extensionId: string): ExtensionRootInfo {
      const record = dependencies.getRecord(extensionId)
      if (!record) throw new ExtensionError('EXTENSION_NOT_FOUND')
      if (record.source !== 'development' || !record.developmentSourcePath) {
        return { extensionId, root: resolveInstalled(extensionId), source: record.source }
      }

      const configured = record.developmentSourcePath
      let realRoot: string
      try {
        realRoot = realpath(configured)
      } catch {
        throw new ExtensionError(
          'EXTENSION_SOURCE_MISSING',
          '开发源码目录不可用，请重新选择或移除链接'
        )
      }
      let isDirectory = false
      try {
        isDirectory = stat(realRoot).isDirectory()
      } catch {
        isDirectory = false
      }
      if (!isDirectory) {
        throw new ExtensionError('EXTENSION_SOURCE_MISSING', '开发源码路径不是目录')
      }

      assertSafeDevelopmentRoot(dependencies.paths, extensionId, realRoot)
      return {
        extensionId,
        root: realRoot,
        source: 'development',
        developmentSourcePath: realRoot
      }
    }
  }
}

/**
 * 开发目录的安全边界。
 *
 * 拒绝三类位置：
 * 1. 扩展自己的安装副本（否则「开发模式」等于原地打转，卸载还会误删）；
 * 2. 宿主的私有数据区（配置、状态、日志、暂存）——那里有用户凭据；
 * 3. 文件系统根 / 用户主目录（自定义协议会把整个目录开放给 iframe）。
 */
function safeRealpath(target: string): string {
  try {
    return fs.realpathSync(target)
  } catch {
    return path.resolve(target)
  }
}

export function assertSafeDevelopmentRoot(
  paths: ExtensionPaths,
  extensionId: string,
  realRoot: string
): void {
  const forbidden: Array<{ root: string; reason: string }> = [
    { root: paths.installDir(extensionId), reason: '不能指向扩展自己的安装目录' },
    { root: paths.extensionsDir, reason: '不能指向扩展安装根目录' },
    { root: paths.dataDir, reason: '不能指向宿主私有数据目录' },
    { root: paths.stateDir, reason: '不能指向宿主状态目录' },
    { root: paths.stagingDir, reason: '不能指向宿主暂存目录' }
  ]
  for (const item of forbidden) {
    // 两侧都必须 realpath：macOS 上 `/tmp` 指向 `/private/tmp`，
    // 只比较字符串会让「extensions-data 里的目录」冒充外部项目。
    const forbiddenRoot = safeRealpath(item.root)
    if (isSamePath(forbiddenRoot, realRoot) || isPathInside(forbiddenRoot, realRoot)) {
      throw new ExtensionError('EXTENSION_INVALID_PATH', item.reason)
    }
  }

  const parsed = path.parse(realRoot)
  if (realRoot === parsed.root) {
    throw new ExtensionError('EXTENSION_INVALID_PATH', '不能把文件系统根目录作为扩展源码')
  }
  try {
    if (isSamePath(os.homedir(), realRoot)) {
      throw new ExtensionError('EXTENSION_INVALID_PATH', '不能把用户主目录作为扩展源码')
    }
  } catch (error) {
    if (error instanceof ExtensionError) throw error
  }
}
