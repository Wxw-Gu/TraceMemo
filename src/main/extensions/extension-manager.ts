import fs from 'fs-extra'
import path from 'node:path'
import { ExtensionError, toExtensionErrorPayload } from '../../shared/extensions/errors'
import { isPathInside } from './extension-paths'
import { computeDirectoryDigest } from './extension-code-digest'
import { ExtensionSecretStore, type ExtensionSecretCipher } from './extension-secret-store'
import {
  createProjectFromTemplate as createProjectFiles,
  exportInstalledCopy
} from './extension-project-files'
import {
  autoGrantedPermissions,
  hasExtensionPermission,
  normalizeExtensionPermissions,
  type ExtensionPermission
} from '../../shared/extensions/permissions'
import {
  checkExtensionCompatibility,
  isValidExtensionId,
  parseExtensionManifest,
  type ExtensionManifest
} from '../../shared/extensions/manifest'
import type {
  ExtensionCapabilitySnapshot,
  ExtensionInstallResult,
  ExtensionLogEntry,
  ExtensionOperationResult,
  ExtensionPageDescriptor,
  ExtensionPageMethod,
  ExtensionPageResponse,
  ExtensionActionInfo,
  ExtensionProjectResult,
  ExtensionSystemHealth,
  ExtensionTtsCapabilitySnapshot,
  InstalledExtension
} from '../../shared/extensions/types'
import type {
  ExtensionAutomationActionOutput,
  ExtensionMessagesQueryRequest,
  ExtensionQueriedMessage,
  ExtensionSendImageRequest,
  ExtensionSendTextRequest,
  ExtensionSendTextResult,
  ExtensionSendVideoRequest,
  ExtensionSendVoiceRequest
} from '../../shared/extensions/rpc'
import type { PersonalWechatSendCapability } from '../../shared/personal-wechat'
import type { WechatActionRequest, WechatActionResult } from '../../shared/wechat-action'
import type { NormalizedIncomingMessage } from '../services/message-listener-service'
import { ExtensionActionRegistry } from './extension-action-registry'
import { ExtensionEventBus } from './extension-event-bus'
import type { ExtensionEntitlementResult } from './extension-entitlement'
import {
  ExtensionHost,
  forkExtensionHost,
  type ExtensionHostChild,
  type ExtensionHostSpawnOptions
} from './extension-host'
import { ExtensionInstaller, type InstallOutcome } from './extension-installer'
import {
  assertSafeDevelopmentRoot,
  createExtensionRootResolver,
  type ExtensionRootResolver
} from './extension-root-resolver'
import {
  ExtensionTemplateCatalog,
  type ExtensionTemplateStatus
} from './extension-template-catalog'
import { ExtensionLogStore } from './extension-log'
import { ExtensionRegistry, type ExtensionRegistryRecord } from './extension-registry'
import { ExtensionSendGateway } from './extension-send-gateway'
import { ExtensionStorage } from './extension-storage'
import type { ExtensionPaths } from './extension-paths'

export interface ExtensionManagerDependencies {
  paths: ExtensionPaths
  appVersion: string
  platform?: NodeJS.Platform
  spawn?: (options: ExtensionHostSpawnOptions) => ExtensionHostChild
  getCapability: () => Promise<PersonalWechatSendCapability>
  checkEntitlement: () => Promise<ExtensionEntitlementResult>
  executeAction: (request: WechatActionRequest) => Promise<WechatActionResult>
  queryMessages: (request: ExtensionMessagesQueryRequest) => Promise<ExtensionQueriedMessage[]>
  /** 群列表（id + 显示名）；用于扩展配置页选择发送目标。 */
  listGroups: () => Promise<Array<{ id: string; name: string }>>
  aiChat: (messages: Array<{ role: string; content: string }>) => Promise<{ text: string }>
  /** 当前 AI 是否已配置；不暴露 key、endpoint 或任何凭据。 */
  aiStatus?: () => { configured: boolean; modelName: string }
  /** 当前文字转语音配置与选定音色摘要；不暴露 key。 */
  ttsStatus?: () => Promise<ExtensionTtsCapabilitySnapshot> | ExtensionTtsCapabilitySnapshot
  synthesizeVoice?: (request: {
    text: string
    voiceId?: string
  }) => Promise<{ filePath: string }>
  cleanupVoice?: (filePath: string) => void
  getAccountId: () => string
  getSelfUsernames: () => string[]
  isDatabaseReady: () => boolean
  /** 官方模板资源根目录；未提供时扩展中心只显示「我的扩展」。 */
  templatesRoot?: string
  /** 扩展凭据的加密实现；未提供时凭据能力不可用（明确失败，不退化明文）。 */
  secretCipher: ExtensionSecretCipher
  now?: () => number
  onChange?: (
    extensionId: string,
    reason: 'installed' | 'enabled' | 'disabled' | 'uninstalled' | 'runtime' | 'actions'
  ) => void
}

/** 页面请求方法名：与 SDK 侧保持同一规则。 */
const PAGE_REQUEST_METHOD = /^[a-z][a-zA-Z0-9]*(?:[._-][a-zA-Z0-9]+){0,3}$/

const PAGE_METHODS: ExtensionPageMethod[] = [
  'storage.get',
  'storage.set',
  'storage.remove',
  'storage.list',
  'capabilities.get',
  'contacts.listGroups',
  'extension.request',
  'extension.info'
]

/** 扩展系统的编排层：只管编排，不实现消息监听、发送与规则存储。 */
export class ExtensionManager {
  private readonly dependencies: ExtensionManagerDependencies
  private readonly paths: ExtensionPaths
  private readonly registry: ExtensionRegistry
  private readonly installer: ExtensionInstaller
  private readonly storage: ExtensionStorage
  private readonly logs: ExtensionLogStore
  private readonly actions = new ExtensionActionRegistry()
  private readonly sendGateway: ExtensionSendGateway
  private readonly hosts = new Map<string, ExtensionHost>()
  private readonly manifests = new Map<string, ExtensionManifest | null>()
  private readonly eventBus: ExtensionEventBus
  private readonly now: () => number
  private initialized = false
  private disposed = false
  /** 代码与 Registry 版本不一致的扩展：值为面向用户的原因，存在即禁止启动。 */
  private readonly inconsistencies = new Map<string, string>()
  /** 配置从旧备份恢复、尚未被用户确认的扩展。 */
  private readonly storageHolds = new Set<string>()
  private readonly templates: ExtensionTemplateCatalog | null
  /** 扩展代码根目录的唯一解析器：安装副本与外部开发目录共用一条路径。 */
  private readonly roots: ExtensionRootResolver
  private readonly secrets: ExtensionSecretStore

  constructor(dependencies: ExtensionManagerDependencies) {
    this.dependencies = dependencies
    this.paths = dependencies.paths
    this.now = dependencies.now ?? (() => Date.now())
    this.registry = new ExtensionRegistry({
      registryFile: this.paths.registryFile,
      now: this.now,
      // 状态文件与备份都不可用时，用磁盘上的目录重建「有哪些扩展」；
      // 重建结果不带启用状态与授权，用户必须重新确认。
      recover: () => this.installer.recoverFromDisk()
    })
    this.installer = new ExtensionInstaller({
      paths: this.paths,
      registry: this.registry,
      now: this.now
    })
    this.templates = dependencies.templatesRoot
      ? new ExtensionTemplateCatalog({
          templateRoot: dependencies.templatesRoot,
          getRecord: (extensionId) => this.registry.get(extensionId),
          resolveInstallDir: (extensionId) => this.paths.installDir(extensionId),
          platform: dependencies.platform
        })
      : null
    this.roots = createExtensionRootResolver({
      paths: this.paths,
      getRecord: (extensionId) => this.registry.get(extensionId)
    })
    this.secrets = new ExtensionSecretStore({
      root: path.join(this.paths.stateDir, 'secrets'),
      cipher: dependencies.secretCipher
    })
    this.storage = new ExtensionStorage({
      dataRoot: this.paths.dataDir,
      onHealthChange: (extensionId, health) => this.handleStorageHealthChange(extensionId, health)
    })
    this.logs = new ExtensionLogStore(this.paths.logsDir)
    this.sendGateway = new ExtensionSendGateway({
      getCapability: dependencies.getCapability,
      checkEntitlement: dependencies.checkEntitlement,
      executeAction: dependencies.executeAction,
      getExtensionDataRoot: (extensionId) => this.paths.extensionDataDir(extensionId),
      synthesizeVoice: dependencies.synthesizeVoice,
      cleanupVoice: dependencies.cleanupVoice,
      getFromId: () => dependencies.getAccountId(),
      now: this.now
    })
    this.eventBus = new ExtensionEventBus({
      listSubscribers: () => this.listEventSubscribers(),
      getAccountId: dependencies.getAccountId,
      getSelfUsernames: dependencies.getSelfUsernames,
      now: this.now
    })
  }

  /** 建立目录、加载状态、拉起已启用的扩展。单个扩展失败不影响其他扩展。 */
  async initialize(): Promise<void> {
    if (this.initialized) return
    this.initialized = true
    for (const directory of [
      this.paths.extensionsDir,
      this.paths.dataDir,
      this.paths.stateDir,
      this.paths.logsDir,
      this.paths.stagingDir
    ]) {
      fs.ensureDirSync(directory)
    }
    this.eventBus.setAccountId(this.dependencies.getAccountId())
    const health = this.registry.getHealth()
    if (health.state !== 'ok') {
      // 宿主级事件没有归属扩展，走主进程日志；界面通过 `getHealth()` 展示。
      console.warn(`[Extension] ${health.message || '扩展状态文件曾损坏，已进入恢复状态'}`)
    }

    for (const record of this.registry.list()) {
      const manifest = this.readManifest(record.id)
      if (!manifest) {
        this.logs.append(record.id, 'error', 'core', '扩展文件缺失或 manifest 无法读取')
        continue
      }
      this.syncDeclared(record.id, manifest)

      // 代码与状态可能在上次升级中断时分叉：先判一致性，不一致就不启动。
      const drift = this.checkInstallConsistency(record, manifest)
      if (drift) {
        this.inconsistencies.set(record.id, drift)
        this.logs.append(record.id, 'error', 'core', drift)
        continue
      }
      this.inconsistencies.delete(record.id)

      if (!record.enabled) continue

      // 配置从旧备份恢复过：先暂停，等用户确认「接受恢复的配置」。
      const storageHealth = this.storage.health(record.id)
      if (storageHealth.state !== 'ok') {
        this.storageHolds.add(record.id)
        this.logs.append(
          record.id,
          'warn',
          'core',
          storageHealth.state === 'recovered-from-backup'
            ? '扩展配置曾从备份恢复，已暂停启动；请在详情页确认后再启用'
            : '扩展配置损坏且无可用备份，已暂停启动；请重置配置后重新启用'
        )
        try {
          this.registry.setEnabled(record.id, false)
        } catch {
          // 状态文件不可写时保持内存中的暂停状态即可。
        }
        continue
      }
      this.storageHolds.delete(record.id)

      const compatibility = checkExtensionCompatibility(manifest, this.dependencies.appVersion)
      if (!compatibility.compatible) {
        this.logs.append(record.id, 'error', 'core', compatibility.reason || '扩展不兼容')
        continue
      }
      try {
        await this.startHost(record.id, manifest)
      } catch (error) {
        this.logs.append(
          record.id,
          'error',
          'core',
          `扩展启动失败：${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
  }

  /** 校验状态记录与磁盘上的 manifest 是否描述同一个版本；这种扩展不能带着旧授权直接跑。 */
  private checkInstallConsistency(
    record: ExtensionRegistryRecord,
    manifest: ExtensionManifest
  ): string | null {
    if (record.id !== manifest.id) {
      return '扩展目录中的 manifest.id 与状态记录不一致'
    }
    if (record.version !== manifest.version) {
      return `代码版本 ${manifest.version} 与状态记录 ${record.version} 不一致，上次升级可能中断`
    }
    if (record.apiVersion !== manifest.apiVersion) {
      return `扩展 API 版本不一致（代码 ${manifest.apiVersion} / 状态 ${record.apiVersion}）`
    }
    return null
  }

  list(): InstalledExtension[] {
    return this.registry
      .list()
      .map((record) => this.toInstalled(record))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  get(extensionId: string): InstalledExtension | null {
    const record = this.registry.get(extensionId)
    if (!record) return null
    return this.toInstalled(record)
  }

  getLogs(extensionId: string, limit = 100): ExtensionLogEntry[] {
    return this.logs.list(extensionId, limit)
  }

  clearLogs(extensionId: string): void {
    this.logs.clear(extensionId)
  }

  async installFromDirectory(directory: string): Promise<ExtensionInstallResult> {
    return this.install((beforeReplace) =>
      this.installer.installFromDirectory(directory, {
        appVersion: this.dependencies.appVersion,
        beforeReplace
      })
    )
  }

  async installFromPackage(packagePath: string): Promise<ExtensionInstallResult> {
    return this.install((beforeReplace) =>
      this.installer.installFromPackage(packagePath, {
        appVersion: this.dependencies.appVersion,
        source: 'package',
        beforeReplace
      })
    )
  }

  /** 官方模板列表；模板资源缺失时返回空数组，不影响「我的扩展」。 */
  async listTemplates(): Promise<ExtensionTemplateStatus[]> {
    if (!this.templates) return []
    return this.templates.list()
  }

  /** 安装官方模板；同 id 被非模板来源占用时拒绝接管。 */
  async installTemplate(templateId: string): Promise<ExtensionInstallResult> {
    const templates = this.templates
    if (!templates) {
      return {
        success: false,
        error: { code: 'CAPABILITY_UNAVAILABLE', message: '模板目录不可用' }
      }
    }
    let resolved: Awaited<ReturnType<ExtensionTemplateCatalog['resolveZip']>>
    try {
      resolved = await templates.resolveZip(templateId)
    } catch (error) {
      return { success: false, error: toExtensionErrorPayload(error) }
    }

    const existing = this.registry.get(resolved.template.extensionId)
    if (existing && (existing.source !== 'template' || existing.templateId !== templateId)) {
      return {
        success: false,
        error: {
          code: 'EXTENSION_ALREADY_INSTALLED',
          message: '已存在同 ID 的非官方扩展，未自动替换'
        }
      }
    }
    if (existing && existing.version === resolved.template.version) {
      return {
        success: false,
        error: { code: 'EXTENSION_ALREADY_INSTALLED', message: '该模板版本已安装' }
      }
    }

    return this.install((beforeReplace) =>
      this.installer.installFromPackage(resolved.path, {
        appVersion: this.dependencies.appVersion,
        source: 'template',
        template: { id: resolved.template.templateId, version: resolved.template.version },
        beforeReplace
      })
    )
  }

  /** 该扩展是否被暂停（配置待确认 / 版本不一致）；事件、动作、发送都看它。 */
  private isSuspended(extensionId: string): boolean {
    return this.storageHolds.has(extensionId) || this.inconsistencies.has(extensionId)
  }

  /** 运行期检测到配置回退：立刻收住这个扩展。 */
  private handleStorageHealthChange(
    extensionId: string,
    health: { state: string; message?: string }
  ): void {
    if (health.state === 'ok') return
    if (this.storageHolds.has(extensionId)) return
    this.storageHolds.add(extensionId)
    void this.stopHost(extensionId).catch(() => undefined)
    try {
      this.registry.setEnabled(extensionId, false)
    } catch {
      // 状态文件不可写时保持内存中的暂停状态即可。
    }
    this.logs.append(
      extensionId,
      'warn',
      'core',
      health.state === 'recovered-from-backup'
        ? '扩展配置在运行期间从备份恢复，已暂停该扩展；请确认后再启用'
        : '扩展配置在运行期间损坏，已暂停该扩展'
    )
    this.dependencies.onChange?.(extensionId, 'runtime')
  }

  /** 供自定义协议解析代码根目录；开发目录不可用时返回 null（页面 404 而不是 500）。 */
  resolveExtensionRoot(extensionId: string): string | null {
    try {
      return this.roots.resolve(extensionId).root
    } catch {
      return null
    }
  }

  /** 链接外部开发项目：只读用户选的目录，不复制代码，也不写回源码目录。 */
  async linkDevelopmentProject(directory: string): Promise<ExtensionInstallResult> {
    const raw = String(directory || '').trim()
    if (!raw) {
      return { success: false, error: { code: 'INVALID_REQUEST', message: '请选择项目目录' } }
    }
    let realRoot: string
    try {
      realRoot = fs.realpathSync(raw)
    } catch {
      return {
        success: false,
        error: { code: 'EXTENSION_SOURCE_MISSING', message: '目录不存在或无法访问' }
      }
    }
    let isDirectory = false
    try {
      isDirectory = fs.statSync(realRoot).isDirectory()
    } catch {
      isDirectory = false
    }
    if (!isDirectory) {
      return {
        success: false,
        error: { code: 'EXTENSION_INVALID_PATH', message: '所选路径不是目录' }
      }
    }

    const manifestPath = path.join(realRoot, 'manifest.json')
    let parsedManifest: ReturnType<typeof parseExtensionManifest>
    try {
      parsedManifest = parseExtensionManifest(fs.readJsonSync(manifestPath) as unknown)
    } catch {
      return {
        success: false,
        error: { code: 'EXTENSION_INVALID_MANIFEST', message: '目录里没有可读的 manifest.json' }
      }
    }
    if (!parsedManifest.ok || !parsedManifest.manifest) {
      return {
        success: false,
        error: {
          code: 'EXTENSION_INVALID_MANIFEST',
          message: 'manifest.json 不合法'
        }
      }
    }
    const manifest = parsedManifest.manifest

    // 先判路径边界：指向宿主私有目录时，连入口检查都不该做。
    try {
      assertSafeDevelopmentRoot(this.paths, manifest.id, realRoot)
    } catch (error) {
      return { success: false, error: toExtensionErrorPayload(error) }
    }

    for (const [key, value] of Object.entries(manifest.entrypoints)) {
      if (!value) continue
      const entryPath = path.join(realRoot, value)
      if (!this.isFileInside(realRoot, entryPath)) {
        return {
          success: false,
          error: { code: 'EXTENSION_INVALID_MANIFEST', message: `入口 ${key} 无法解析` }
        }
      }
    }

    const existing = this.registry.get(manifest.id)
    if (existing && existing.source !== 'development') {
      return {
        success: false,
        error: {
          code: 'EXTENSION_ALREADY_INSTALLED',
          message: '该扩展 ID 已被正式安装占用；请先「导出为开发项目」切换来源'
        }
      }
    }
    if (existing && existing.developmentSourcePath === realRoot) {
      return {
        success: false,
        error: { code: 'EXTENSION_ALREADY_INSTALLED', message: '该目录已经链接过' }
      }
    }

    const timestamp = this.now()
    this.registry.upsert({
      id: manifest.id,
      version: manifest.version,
      apiVersion: manifest.apiVersion,
      // 链接不等于信任：默认停用；只自动授予低风险权限（与安装策略一致），
      // 高风险能力仍需用户在启用时确认。
      enabled: false,
      grantedPermissions: autoGrantedPermissions(manifest.permissions),
      installedAt: existing?.installedAt ?? timestamp,
      updatedAt: timestamp,
      source: 'development',
      developmentSourcePath: realRoot
    })
    this.manifests.set(manifest.id, manifest)
    this.syncDeclared(manifest.id, manifest)
    this.logs.append(manifest.id, 'info', 'core', '已链接外部开发项目')
    this.dependencies.onChange?.(manifest.id, 'installed')
    const extension = this.get(manifest.id)
    return { success: true, ...(extension ? { extension } : {}) }
  }

  /** 重新加载开发项目。 */
  async reloadDevelopment(extensionId: string): Promise<ExtensionOperationResult> {
    const record = this.registry.get(extensionId)
    if (!record) return failure(new ExtensionError('EXTENSION_NOT_FOUND'))
    if (record.source !== 'development') {
      return failure(new ExtensionError('INVALID_REQUEST', '该扩展不是开发模式'))
    }

    await this.stopHost(extensionId)
    this.manifests.delete(extensionId)

    try {
      // 先确认源码目录仍然可达；不可达时给出「重新选择目录」而不是「manifest 读不到」。
      this.roots.resolve(extensionId)
    } catch (error) {
      return failure(toExtensionErrorPayload(error) as unknown as ExtensionError)
    }
    const manifest = this.readManifest(extensionId)
    if (!manifest) {
      return failure(new ExtensionError('EXTENSION_INVALID_MANIFEST', 'manifest 无法读取'))
    }
    if (manifest.id !== extensionId) {
      return failure(
        new ExtensionError(
          'EXTENSION_INVALID_MANIFEST',
          `目录内 manifest.id 为 ${manifest.id}，与链接时不一致`
        )
      )
    }

    try {
      const drift = this.checkInstallConsistency(record, manifest)
      if (drift && manifest.version !== record.version) {
        // 开发模式允许版本自由变化：这里把状态对齐到磁盘，而不是拒绝启动。
        this.registry.upsert({
          ...record,
          version: manifest.version,
          apiVersion: manifest.apiVersion,
          grantedPermissions: record.grantedPermissions.filter((permission) =>
            manifest.permissions.includes(permission)
          ),
          updatedAt: this.now()
        })
      }
    } catch (error) {
      return failure(toExtensionErrorPayload(error) as unknown as ExtensionError)
    }

    this.manifests.set(extensionId, manifest)
    this.syncDeclared(extensionId, manifest)
    this.inconsistencies.delete(extensionId)
    this.storageHolds.delete(extensionId)

    let startError: unknown = null
    if (record.enabled) {
      try {
        await this.startHost(extensionId, manifest)
      } catch (error) {
        startError = error
      }
    }
    this.logs.append(extensionId, 'info', 'core', '开发项目已重新加载')
    this.dependencies.onChange?.(extensionId, 'installed')
    if (startError) {
      return failure(toExtensionErrorPayload(startError) as unknown as ExtensionError)
    }
    return { success: true }
  }

  /** 移除开发链接：有安装副本就退回它，否则删记录；外部目录永不删除。 */
  async unlinkDevelopment(
    extensionId: string,
    options: { keepData: boolean }
  ): Promise<ExtensionOperationResult> {
    const record = this.registry.get(extensionId)
    if (!record) return failure(new ExtensionError('EXTENSION_NOT_FOUND'))
    if (record.source !== 'development') {
      return failure(new ExtensionError('INVALID_REQUEST', '该扩展不是开发模式'))
    }

    await this.stopHost(extensionId)
    this.manifests.delete(extensionId)
    this.inconsistencies.delete(extensionId)
    this.storageHolds.delete(extensionId)

    const installedRoot = this.paths.installDir(extensionId)
    const hasInstalledCopy = fs.existsSync(path.join(installedRoot, 'manifest.json'))
    try {
      if (hasInstalledCopy) {
        // 回到安装副本：不是删除，只是换来源。
        this.registry.upsert({
          ...record,
          source: 'directory',
          enabled: false,
          updatedAt: this.now()
        })
        const restored = this.readManifest(extensionId)
        if (restored) {
          this.manifests.set(extensionId, restored)
          this.syncDeclared(extensionId, restored)
        }
      } else {
        this.registry.remove(extensionId)
      }
    } catch (error) {
      return failure(toExtensionErrorPayload(error) as unknown as ExtensionError)
    }

    if (!options.keepData) {
      await fs
        .rm(this.paths.extensionDataDir(extensionId), { recursive: true, force: true })
        .catch(() => undefined)
    }
    this.logs.append(extensionId, 'info', 'core', '已移除开发链接（外部源码未删除）')
    this.dependencies.onChange?.(extensionId, hasInstalledCopy ? 'installed' : 'uninstalled')
    return { success: true }
  }

  /** 把开发项目转成正式安装副本。 */
  async convertDevelopmentToInstalled(extensionId: string): Promise<ExtensionOperationResult> {
    const record = this.registry.get(extensionId)
    if (!record) return failure(new ExtensionError('EXTENSION_NOT_FOUND'))
    if (record.source !== 'development') {
      return failure(new ExtensionError('INVALID_REQUEST', '该扩展不是开发模式'))
    }
    let root: string
    try {
      root = this.roots.resolve(extensionId).root
    } catch (error) {
      return failure(toExtensionErrorPayload(error) as unknown as ExtensionError)
    }

    await this.stopHost(extensionId)
    // 转换后不自动运行：先把启用状态落成 false，安装器才会保留它。
    try {
      this.registry.setEnabled(extensionId, false)
    } catch (error) {
      return failure(toExtensionErrorPayload(error) as unknown as ExtensionError)
    }

    try {
      const outcome = await this.installer.installFromDirectory(root, {
        appVersion: this.dependencies.appVersion,
        source: 'directory',
        beforeReplace: async () => {
          await this.stopHost(extensionId)
        }
      })
      await outcome.cleanup()
      this.manifests.delete(extensionId)
      this.manifests.set(extensionId, outcome.manifest)
      this.syncDeclared(extensionId, outcome.manifest)
    } catch (error) {
      return failure(toExtensionErrorPayload(error) as unknown as ExtensionError)
    }

    this.logs.append(extensionId, 'info', 'core', '开发项目已转为正式安装')
    this.dependencies.onChange?.(extensionId, 'installed')
    return { success: true }
  }

  /** 从官方模板生成一个独立项目（不安装、不启用）。 */
  async createProjectFromTemplate(
    templateId: string,
    targetDirectory: string,
    options: { extensionId: string; name?: string }
  ): Promise<ExtensionProjectResult> {
    if (!this.templates) {
      return {
        success: false,
        error: { code: 'CAPABILITY_UNAVAILABLE', message: '模板目录不可用' }
      }
    }
    if (!isValidExtensionId(options.extensionId)) {
      return {
        success: false,
        error: { code: 'INVALID_REQUEST', message: '扩展 id 必须是反向域名格式' }
      }
    }
    if (this.registry.get(options.extensionId)) {
      return {
        success: false,
        error: { code: 'EXTENSION_ALREADY_INSTALLED', message: '该扩展 id 已被占用' }
      }
    }

    let resolved: Awaited<ReturnType<ExtensionTemplateCatalog['resolveZip']>>
    try {
      resolved = await this.templates.resolveZip(templateId)
    } catch (error) {
      return { success: false, error: toExtensionErrorPayload(error) }
    }

    try {
      const outcome = await createProjectFiles({
        zipPath: resolved.path,
        targetDir: targetDirectory,
        extensionId: options.extensionId,
        templateExtensionId: resolved.template.extensionId,
        ...(options.name ? { name: options.name } : {})
      })
      this.logs.append(
        options.extensionId,
        'info',
        'core',
        `已从模板 ${resolved.template.templateId} 生成独立项目`
      )
      return {
        success: true,
        projectPath: outcome.projectPath,
        rewrittenFiles: outcome.rewrittenFiles
      }
    } catch (error) {
      return { success: false, error: toExtensionErrorPayload(error) }
    }
  }

  /** 把已安装副本导出成外部项目，并把来源切换为 development。 */
  async exportInstalledAsProject(
    extensionId: string,
    targetDirectory: string
  ): Promise<ExtensionProjectResult> {
    const record = this.registry.get(extensionId)
    if (!record) return { success: false, error: { code: 'EXTENSION_NOT_FOUND', message: '' } }
    if (record.source === 'development') {
      return {
        success: false,
        error: { code: 'INVALID_REQUEST', message: '该扩展已经是开发模式' }
      }
    }
    const installRoot = this.paths.installDir(extensionId)

    await this.stopHost(extensionId)
    let projectPath: string
    try {
      const outcome = await exportInstalledCopy(installRoot, targetDirectory)
      projectPath = fs.realpathSync(outcome.projectPath)
    } catch (error) {
      // 导出失败时把旧 Host 拉回来，别让扩展停在半死状态。
      await this.restoreHostAfterFailure(extensionId)
      return { success: false, error: toExtensionErrorPayload(error) }
    }

    const parsed = (() => {
      try {
        return parseExtensionManifest(fs.readJsonSync(path.join(projectPath, 'manifest.json')))
      } catch {
        return null
      }
    })()
    if (!parsed?.ok || !parsed.manifest || parsed.manifest.id !== extensionId) {
      return {
        success: false,
        error: {
          code: 'EXTENSION_INVALID_MANIFEST',
          message: '导出的项目 manifest 与原扩展不一致，未切换来源'
        }
      }
    }

    const next = {
      ...record,
      source: 'development' as const,
      developmentSourcePath: projectPath,
      // 转换后不自动运行；授权按新 manifest 取交集。
      enabled: false,
      grantedPermissions: record.grantedPermissions.filter((permission) =>
        parsed.manifest!.permissions.includes(permission)
      ),
      updatedAt: this.now()
    }
    // 模板身份与旧指纹在新来源下没有意义，必须清掉。
    delete next.templateId
    delete next.templateVersion
    delete next.installedCodeDigest

    try {
      this.registry.upsert(next)
    } catch {
      return {
        success: false,
        error: {
          code: 'EXTENSION_REGISTRY_UNREADABLE',
          message: '项目已导出，但扩展状态写入失败；请用「链接本地项目」重新接入'
        }
      }
    }

    this.manifests.delete(extensionId)
    this.manifests.set(extensionId, parsed.manifest)
    this.syncDeclared(extensionId, parsed.manifest)
    this.logs.append(extensionId, 'info', 'core', '已导出为开发项目并切换来源')
    this.dependencies.onChange?.(extensionId, 'installed')
    return { success: true, projectPath }
  }

  /** 目标文件必须真实落在扩展根目录内（跟随符号链接后仍在内）。 */
  private isFileInside(root: string, target: string): boolean {
    try {
      const realRoot = fs.realpathSync(root)
      const realTarget = fs.realpathSync(target)
      return isPathInside(realRoot, realTarget) && fs.statSync(realTarget).isFile()
    } catch {
      return false
    }
  }

  /** 状态文件的可信度；`unreadable` 时界面必须提示，而不是显示「没有扩展」。 */
  getHealth(): ExtensionSystemHealth {
    const health = this.registry.getHealth()
    return {
      registry: {
        state: health.state,
        ...(health.message ? { message: health.message } : {})
      }
    }
  }

  /** 授予扩展已声明的权限；只接受 manifest 里出现过的权限：渲染层传来的字符串不能扩大扩展的能力面。 */
  async grantPermissions(
    extensionId: string,
    permissions: ExtensionPermission[]
  ): Promise<ExtensionOperationResult> {
    const record = this.registry.get(extensionId)
    if (!record) return failure(new ExtensionError('EXTENSION_NOT_FOUND'))
    const manifest = this.readManifest(extensionId)
    if (!manifest) return failure(new ExtensionError('EXTENSION_INVALID_MANIFEST', '扩展文件缺失'))

    const granted = normalizeExtensionPermissions([
      ...record.grantedPermissions,
      ...permissions.filter((permission) => manifest.permissions.includes(permission))
    ])
    try {
      this.registry.setGrantedPermissions(extensionId, granted)
    } catch (error) {
      return failure(toExtensionErrorPayload(error) as unknown as ExtensionError)
    }
    if (record.enabled && manifest.entrypoints.background) {
      await this.startHost(extensionId, manifest).catch(() => undefined)
    }
    this.dependencies.onChange?.(extensionId, 'enabled')
    return { success: true }
  }

  /** 撤销单项授权；已启用时需要重启后台，正在运行的能力随之失效。 */
  async revokePermission(
    extensionId: string,
    permission: ExtensionPermission
  ): Promise<ExtensionOperationResult> {
    const record = this.registry.get(extensionId)
    if (!record) return failure(new ExtensionError('EXTENSION_NOT_FOUND'))
    const manifest = this.readManifest(extensionId)
    try {
      this.registry.setGrantedPermissions(
        extensionId,
        record.grantedPermissions.filter((item) => item !== permission)
      )
    } catch (error) {
      return failure(toExtensionErrorPayload(error) as unknown as ExtensionError)
    }
    if (record.enabled && manifest?.entrypoints.background) {
      await this.startHost(extensionId, manifest).catch(() => undefined)
    }
    this.dependencies.onChange?.(extensionId, 'enabled')
    return { success: true }
  }

  /** 重置扩展私有存储；损坏现场已经由存储层另存为 `.corrupt-*`。 */
  resetStorage(extensionId: string): ExtensionOperationResult {
    const record = this.registry.get(extensionId)
    if (!record) return failure(new ExtensionError('EXTENSION_NOT_FOUND'))
    try {
      this.storage.reset(extensionId)
    } catch (error) {
      return failure(toExtensionErrorPayload(error) as unknown as ExtensionError)
    }
    this.dependencies.onChange?.(extensionId, 'runtime')
    return { success: true }
  }

  async setEnabled(extensionId: string, enabled: boolean): Promise<ExtensionOperationResult> {
    const record = this.registry.get(extensionId)
    if (!record) return failure(new ExtensionError('EXTENSION_NOT_FOUND'))
    const manifest = this.readManifest(extensionId)
    if (!manifest) return failure(new ExtensionError('EXTENSION_INVALID_MANIFEST', '扩展文件缺失'))

    if (!enabled) {
      await this.stopHost(extensionId)
      this.registry.setEnabled(extensionId, false)
      this.registry.setGrantedPermissions(extensionId, autoGrantedPermissions(manifest.permissions))
      this.dependencies.onChange?.(extensionId, 'disabled')
      return { success: true }
    }

    const drift = this.checkInstallConsistency(record, manifest)
    if (drift) {
      this.inconsistencies.set(extensionId, drift)
      return failure(new ExtensionError('EXTENSION_INCOMPATIBLE', drift))
    }

    // 配置还没被用户确认前不允许启动：恢复出来的开关可能还停在旧值上。
    const storageHealth = this.storage.health(extensionId)
    if (storageHealth.state !== 'ok') {
      this.storageHolds.add(extensionId)
      return failure(
        new ExtensionError(
          'EXTENSION_STORAGE_CORRUPTED',
          storageHealth.state === 'recovered-from-backup'
            ? '扩展配置曾从备份恢复，请先在详情页确认后再启用'
            : '扩展配置已损坏，请先重置配置再启用'
        )
      )
    }
    this.storageHolds.delete(extensionId)

    const compatibility = checkExtensionCompatibility(manifest, this.dependencies.appVersion)
    if (!compatibility.compatible) {
      return failure(new ExtensionError('EXTENSION_INCOMPATIBLE', compatibility.reason))
    }
    this.registry.setEnabled(extensionId, true)
    this.registry.setGrantedPermissions(extensionId, manifest.permissions)
    this.syncDeclared(extensionId, manifest)
    if (manifest.entrypoints.background) {
      try {
        await this.startHost(extensionId, manifest)
      } catch {
        // 启用状态保留：运行状态会显示为「错误」，用户可以查看日志后重新启用。
      }
    }
    this.dependencies.onChange?.(extensionId, 'enabled')
    return { success: true }
  }

  /** 清除「状态文件曾恢复」的提示；不改动任何扩展的启用状态。 */
  acknowledgeRegistryRecovery(): ExtensionOperationResult {
    try {
      this.registry.acknowledgeRecovery()
    } catch (error) {
      return failure(toExtensionErrorPayload(error) as unknown as ExtensionError)
    }
    this.dependencies.onChange?.('', 'runtime')
    return { success: true }
  }

  /** 接受从备份恢复出来的扩展配置，之后才允许启用该扩展。 */
  acknowledgeStorageRecovery(extensionId: string): ExtensionOperationResult {
    const record = this.registry.get(extensionId)
    if (!record) return failure(new ExtensionError('EXTENSION_NOT_FOUND'))
    try {
      this.storage.acknowledge(extensionId)
    } catch (error) {
      return failure(toExtensionErrorPayload(error) as unknown as ExtensionError)
    }
    this.storageHolds.delete(extensionId)
    this.dependencies.onChange?.(extensionId, 'runtime')
    return { success: true }
  }

  /** 采用磁盘上的代码版本：把状态记录的版本对齐到 manifest。 */
  adoptInstalledCode(extensionId: string): ExtensionOperationResult {
    const record = this.registry.get(extensionId)
    const manifest = this.readManifest(extensionId)
    if (!record) return failure(new ExtensionError('EXTENSION_NOT_FOUND'))
    if (!manifest) return failure(new ExtensionError('EXTENSION_INVALID_MANIFEST', '扩展文件缺失'))
    try {
      this.registry.upsert({
        ...record,
        version: manifest.version,
        apiVersion: manifest.apiVersion,
        grantedPermissions: record.grantedPermissions.filter((permission) =>
          manifest.permissions.includes(permission)
        ),
        updatedAt: this.now()
      })
    } catch (error) {
      return failure(toExtensionErrorPayload(error) as unknown as ExtensionError)
    }
    this.inconsistencies.delete(extensionId)
    this.manifests.delete(extensionId)
    this.dependencies.onChange?.(extensionId, 'installed')
    return { success: true }
  }

  /** 把最近的升级过渡备份换回来，用于「新代码可疑、旧代码还在」的场景。 */
  async rollbackInterruptedUpgrade(extensionId: string): Promise<ExtensionOperationResult> {
    const record = this.registry.get(extensionId)
    if (!record) return failure(new ExtensionError('EXTENSION_NOT_FOUND'))
    await this.stopHost(extensionId)
    let restored: { restored: boolean; manifest?: ExtensionManifest }
    try {
      restored = await this.installer.restoreLatestBackup(extensionId)
    } catch (error) {
      return failure(toExtensionErrorPayload(error) as unknown as ExtensionError)
    }
    if (!restored.restored || !restored.manifest) {
      return failure(new ExtensionError('EXTENSION_INSTALL_FAILED', '没有可用的升级备份'))
    }
    try {
      this.registry.upsert({
        ...record,
        version: restored.manifest.version,
        apiVersion: restored.manifest.apiVersion,
        grantedPermissions: record.grantedPermissions.filter((permission) =>
          restored.manifest!.permissions.includes(permission)
        ),
        updatedAt: this.now()
      })
    } catch (error) {
      return failure(toExtensionErrorPayload(error) as unknown as ExtensionError)
    }
    this.inconsistencies.delete(extensionId)
    this.manifests.delete(extensionId)
    this.dependencies.onChange?.(extensionId, 'installed')
    return { success: true }
  }

  async uninstall(extensionId: string, keepData: boolean): Promise<ExtensionOperationResult> {
    const record = this.registry.get(extensionId)
    if (!record) return failure(new ExtensionError('EXTENSION_NOT_FOUND'))
    await this.stopHost(extensionId)
    this.actions.remove(extensionId)
    this.manifests.delete(extensionId)
    try {
      await this.installer.uninstall(extensionId, { keepData })
    } catch (error) {
      return failure(toExtensionErrorPayload(error) as unknown as ExtensionError)
    }
    if (!keepData) this.logs.remove(extensionId)
    this.dependencies.onChange?.(extensionId, 'uninstalled')
    return { success: true }
  }

  /** 页面地址。停用的扩展也允许打开自己的配置页（否则用户无法先配置再启用）。 */
  pageUrl(extensionId: string, pageId?: string): ExtensionPageDescriptor {
    const record = this.registry.get(extensionId)
    if (!record) throw new ExtensionError('EXTENSION_NOT_FOUND')
    const manifest = this.readManifest(extensionId)
    if (!manifest) throw new ExtensionError('EXTENSION_INVALID_MANIFEST', '扩展文件缺失')
    const page = pageId
      ? manifest.contributions.pages.find((item) => item.id === pageId)
      : manifest.contributions.pages[0]
    const entry = page?.entry || manifest.entrypoints.page
    if (!entry) throw new ExtensionError('EXTENSION_NOT_FOUND', '扩展没有可打开的页面')
    return {
      extensionId,
      pageId: page?.id || 'main',
      title: page?.title || manifest.name,
      url: `tm-extension://${extensionId}/${entry}`
    }
  }

  /** 扩展页面可调用的能力。 */
  async pageRequest(
    extensionId: string,
    method: string,
    params: Record<string, unknown> = {}
  ): Promise<ExtensionPageResponse> {
    try {
      if (!PAGE_METHODS.includes(method as ExtensionPageMethod)) {
        throw new ExtensionError('PERMISSION_DENIED', `页面不能调用 ${method}`)
      }
      const record = this.registry.get(extensionId)
      if (!record) throw new ExtensionError('EXTENSION_NOT_FOUND')
      const manifest = this.readManifest(extensionId)
      if (!manifest) throw new ExtensionError('EXTENSION_INVALID_MANIFEST', '扩展文件缺失')
      // 页面桥只认「已授予」的权限：manifest 声明只是申请，不代表用户同意。
      if (!record.grantedPermissions.includes('storage') && method.startsWith('storage.')) {
        throw new ExtensionError('PERMISSION_DENIED', '扩展没有 storage 权限')
      }
      if (
        method === 'contacts.listGroups' &&
        !record.grantedPermissions.includes('contacts.list')
      ) {
        throw new ExtensionError('PERMISSION_DENIED', '扩展没有 contacts.list 权限')
      }
      switch (method as ExtensionPageMethod) {
        case 'storage.get':
          return { ok: true, result: this.storage.get(extensionId, params.key) }
        case 'storage.set':
          this.storage.set(extensionId, params.key, params.value)
          return { ok: true, result: { ok: true } }
        case 'storage.remove':
          return { ok: true, result: { removed: this.storage.remove(extensionId, params.key) } }
        case 'storage.list':
          return { ok: true, result: { entries: this.storage.list(extensionId) } }
        case 'capabilities.get':
          return { ok: true, result: await this.buildCapabilitySnapshot(extensionId) }
        case 'contacts.listGroups': {
          const groups = await this.dependencies.listGroups()
          return {
            ok: true,
            result: {
              groups: groups
                .filter((group) => group && group.id)
                .map((group) => ({ id: group.id, name: group.name || group.id }))
                .slice(0, 2_000)
            }
          }
        }
        case 'extension.request': {
          // 通用转发：只进入**同一扩展**的后台，宿主不知道任何具体业务。
          const inner = String(params.method || '').trim()
          if (!PAGE_REQUEST_METHOD.test(inner)) {
            throw new ExtensionError('INVALID_REQUEST', '页面请求方法名不合法')
          }
          if (!record.enabled) throw new ExtensionError('EXTENSION_DISABLED')
          if (this.isSuspended(extensionId)) {
            throw new ExtensionError('EXTENSION_STORAGE_CORRUPTED', '扩展已暂停，页面请求被拒绝')
          }
          const host = this.hosts.get(extensionId)
          if (!host) throw new ExtensionError('EXTENSION_HOST_UNAVAILABLE')
          const rawParams = params.params
          if (
            rawParams !== undefined &&
            (typeof rawParams !== 'object' || Array.isArray(rawParams))
          ) {
            throw new ExtensionError('INVALID_REQUEST', 'params 必须是对象')
          }
          return {
            ok: true,
            result: await host.requestPage(
              inner,
              (rawParams as Record<string, unknown> | undefined) ?? {},
              90_000
            )
          }
        }
        case 'extension.info':
          return {
            ok: true,
            result: {
              id: manifest.id,
              name: manifest.name,
              version: manifest.version,
              enabled: record.enabled
            }
          }
        default:
          throw new ExtensionError('PERMISSION_DENIED', `页面不能调用 ${method}`)
      }
    } catch (error) {
      return { ok: false, error: toExtensionErrorPayload(error) }
    }
  }

  handleMessage(message: NormalizedIncomingMessage): void {
    this.eventBus.setAccountId(this.dependencies.getAccountId())
    this.eventBus.handleMessage(message)
  }

  setAccountId(accountId: string): void {
    this.eventBus.setAccountId(accountId)
  }

  /** 自动化动作执行入口。由 `AutomationActionRunner` 调用。 */
  async invokeAutomationAction(
    extensionId: string,
    actionId: string,
    input: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<ExtensionAutomationActionOutput> {
    const record = this.registry.get(extensionId)
    if (!record) throw new ExtensionError('EXTENSION_NOT_FOUND')
    if (!record.enabled) throw new ExtensionError('EXTENSION_DISABLED')
    if (this.isSuspended(extensionId)) {
      throw new ExtensionError('EXTENSION_STORAGE_CORRUPTED', '扩展配置待确认，动作已暂停')
    }
    if (!hasExtensionPermission(record.grantedPermissions, 'automation.action')) {
      throw new ExtensionError('PERMISSION_DENIED', '扩展没有 automation.action 权限')
    }
    const host = this.hosts.get(extensionId)
    if (!host) throw new ExtensionError('EXTENSION_HOST_UNAVAILABLE')
    if (!this.actions.isRegistered(extensionId, actionId)) {
      throw new ExtensionError('ACTION_FAILED', '扩展没有注册该动作')
    }
    return host.invokeAction(actionId, input, timeoutMs)
  }

  getActions(): ReturnType<ExtensionActionRegistry['list']> {
    return this.actions.list()
  }

  /** 供自动化编辑器使用的动作列表。 */
  listActions(): ExtensionActionInfo[] {
    return this.actions.list().map((action) => {
      const record = this.registry.get(action.extensionId)
      const manifest = this.manifests.get(action.extensionId)
      const base: ExtensionActionInfo = {
        extensionId: action.extensionId,
        extensionName: action.extensionName,
        actionId: action.actionId,
        title: action.title,
        ...(action.description ? { description: action.description } : {}),
        declared: action.declared,
        registered: action.registered,
        enabled: record?.enabled === true,
        available: false,
        ...(action.inputSchema ? { inputSchema: action.inputSchema } : {})
      }
      const block = (reason: string): ExtensionActionInfo => ({
        ...base,
        unavailableReason: reason
      })

      if (!record) return block('扩展已卸载')
      if (!manifest) return block('扩展代码缺失或 manifest 无法读取')
      const compatibility = checkExtensionCompatibility(manifest, this.dependencies.appVersion)
      if (!compatibility.compatible) return block(compatibility.reason || '扩展与当前版本不兼容')
      if (!record.enabled) return block('扩展未启用')
      if (this.isSuspended(record.id)) return block('扩展已暂停（配置待确认）')
      if (!hasExtensionPermission(record.grantedPermissions, 'automation.action')) {
        return block('未授予「执行自动化动作」权限')
      }
      if (action.schemaError) return block(`参数 Schema 不可用：${action.schemaError}`)
      if (!action.registered) {
        return block(action.declared ? '后台未注册该动作（可能仍在启动或代码报错）' : '动作未注册')
      }
      return { ...base, available: true }
    })
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const ids = Array.from(this.hosts.keys())
    await Promise.all(ids.map((id) => this.stopHost(id)))
  }

  /** 安装 / 升级的编排。 */
  private async install(
    run: (
      beforeReplace: (
        manifest: ExtensionManifest,
        previous: ExtensionRegistryRecord | undefined
      ) => Promise<void>
    ) => Promise<InstallOutcome>
  ): Promise<ExtensionInstallResult> {
    let upgradingId: string | null = null
    const beforeReplace = async (
      manifest: ExtensionManifest,
      previous: ExtensionRegistryRecord | undefined
    ): Promise<void> => {
      upgradingId = manifest.id
      // 模板来源的代码被用户改过时，不允许任何安装路径静默覆盖。
      if (previous?.source === 'template') this.assertTemplateCodeUntouched(previous)
      // manifest 缓存必须先失效：否则后续读到的仍是旧版本的入口与权限。
      this.manifests.delete(manifest.id)
      if (previous?.enabled) await this.stopHost(manifest.id)
    }

    let outcome: InstallOutcome
    try {
      outcome = await run(beforeReplace)
    } catch (error) {
      // 失败可能发生在旧 Host 已停止之后：旧代码仍在磁盘上，尽量把它拉回来。
      if (upgradingId) await this.restoreHostAfterFailure(upgradingId)
      return { success: false, error: toExtensionErrorPayload(error) }
    }

    const { manifest, previousRecord } = outcome
    const wasEnabled = previousRecord?.enabled === true
    this.manifests.set(manifest.id, manifest)
    this.syncDeclared(manifest.id, manifest)
    // 新安装只自动授予低风险权限；升级保留用户已经授予的集合（已按新 manifest 取交集）。
    if (!outcome.upgraded) {
      this.registry.setGrantedPermissions(manifest.id, autoGrantedPermissions(manifest.permissions))
    }
    this.logs.append(
      manifest.id,
      'info',
      'core',
      outcome.upgraded
        ? `扩展已更新：${outcome.previousVersion ?? '?'} → ${manifest.version}`
        : `扩展已安装：${manifest.version}`
    )
    this.dependencies.onChange?.(manifest.id, 'installed')

    if (wasEnabled && manifest.entrypoints.background) {
      try {
        await this.startHost(manifest.id, manifest)
      } catch (error) {
        // 新版本起不来：代码与状态一起退回旧版本，并把旧版本重新拉起。
        await this.stopHost(manifest.id)
        await outcome.rollback().catch(() => undefined)
        this.manifests.delete(manifest.id)
        await this.restoreHostAfterFailure(manifest.id)
        const message = error instanceof Error ? error.message : '新版本启动失败'
        this.logs.append(manifest.id, 'error', 'core', `新版本启动失败，已回滚：${message}`)
        this.dependencies.onChange?.(manifest.id, 'installed')
        return {
          success: false,
          error: {
            code: 'EXTENSION_INSTALL_FAILED',
            message: `扩展已回滚到上一版本：${message}`
          }
        }
      }
    }

    await outcome.cleanup().catch(() => undefined)
    const installed = this.get(manifest.id)
    return { success: true, ...(installed ? { extension: installed } : {}) }
  }

  /** 模板来源的「本地改动」检查。 */
  private assertTemplateCodeUntouched(record: ExtensionRegistryRecord): void {
    const root = this.paths.installDir(record.id)
    if (!fs.existsSync(path.join(root, 'manifest.json'))) return
    if (!record.installedCodeDigest) {
      throw new ExtensionError(
        'EXTENSION_MODIFIED_LOCALLY',
        '无法确认该模板的代码是否被修改过；请先「导出为开发项目」再更新'
      )
    }
    const current = computeDirectoryDigest(root)
    if (current !== record.installedCodeDigest) {
      throw new ExtensionError(
        'EXTENSION_MODIFIED_LOCALLY',
        '检测到安装代码已被修改，已阻止自动覆盖；请先「导出为开发项目」'
      )
    }
  }

  /** 安装流程中断后，把 Registry 里仍标记为启用的扩展重新拉起来。 */
  private async restoreHostAfterFailure(extensionId: string): Promise<void> {
    const record = this.registry.get(extensionId)
    if (!record?.enabled) return
    this.manifests.delete(extensionId)
    const manifest = this.readManifest(extensionId)
    if (!manifest?.entrypoints.background) return
    await this.startHost(extensionId, manifest).catch(() => undefined)
  }

  private async startHost(extensionId: string, manifest: ExtensionManifest): Promise<void> {
    if (this.disposed) return
    if (!manifest.entrypoints.background) return
    // 双保险：任何路径（含自动恢复、自动化触发）都不能绕过这两道闸。
    const drift = this.inconsistencies.get(extensionId)
    if (drift) {
      throw new ExtensionError('EXTENSION_INCOMPATIBLE', drift)
    }
    if (this.storageHolds.has(extensionId)) {
      throw new ExtensionError('EXTENSION_STORAGE_CORRUPTED', '扩展配置尚未确认恢复，已阻止启动')
    }
    await this.stopHost(extensionId)
    const resolvedRoot = this.roots.resolve(extensionId)
    const host = new ExtensionHost({
      extensionId,
      extensionDir: resolvedRoot.root,
      dataDir: this.paths.extensionDataDir(extensionId),
      permissions: this.registry.get(extensionId)?.grantedPermissions ?? [],
      storage: this.storage,
      secrets: this.secrets,
      spawn: this.dependencies.spawn ?? this.defaultSpawn(),
      onLog: (level, message) => {
        this.logs.append(extensionId, level, 'core', message)
        if (level === 'error') this.dependencies.onChange?.(extensionId, 'runtime')
      },
      onStateChange: () => this.dependencies.onChange?.(extensionId, 'runtime'),
      onActionsChanged: () => {
        this.syncRegisteredActions(extensionId, manifest.name)
        this.dependencies.onChange?.(extensionId, 'actions')
      },
      queryMessages: (id, request) => this.queryMessages(id, request),
      sendText: (id, request) => this.sendText(id, request),
      sendImage: (id, request) => this.sendImage(id, request),
      sendVideo: (id, request) => this.sendVideo(id, request),
      sendVoice: (id, request) => this.sendVoice(id, request),
      aiChat: (_id, messages) => this.dependencies.aiChat(messages),
      capabilities: (id) => this.buildCapabilitySnapshot(id)
    })
    this.hosts.set(extensionId, host)
    await host.start()
  }

  private async stopHost(extensionId: string): Promise<void> {
    const host = this.hosts.get(extensionId)
    if (!host) return
    this.hosts.delete(extensionId)
    await host.stop()
    this.actions.removeRuntime(extensionId)
  }

  private defaultSpawn(): (options: ExtensionHostSpawnOptions) => ExtensionHostChild {
    // electron-vite 把主进程入口输出到 out/main，扩展宿主脚本与它同级。
    return forkExtensionHost(path.join(__dirname, 'extensionHost.js'))
  }

  private syncDeclared(extensionId: string, manifest: ExtensionManifest): void {
    this.actions.setDeclared(extensionId, manifest.name, manifest.contributions.automationActions)
  }

  private syncRegisteredActions(extensionId: string, extensionName: string): void {
    const host = this.hosts.get(extensionId)
    this.actions.setRegistered(extensionId, extensionName, host?.registeredActions() ?? [])
  }

  private listEventSubscribers(): Array<{
    extensionId: string
    subscriptions: ExtensionManifest['subscriptions']
    deliver: (
      envelope: Parameters<ExtensionEventBus['handleMessage']>[0] extends never
        ? never
        : import('../../shared/extensions/events').ExtensionEventEnvelope
    ) => boolean
  }> {
    const subscribers: Array<{
      extensionId: string
      subscriptions: ExtensionManifest['subscriptions']
      deliver: (
        envelope: import('../../shared/extensions/events').ExtensionEventEnvelope
      ) => boolean
    }> = []
    for (const [extensionId, host] of this.hosts) {
      const record = this.registry.get(extensionId)
      const manifest = this.manifests.get(extensionId)
      if (!record?.enabled || !manifest) continue
      // 暂停中的扩展不再收事件：否则它仍会用旧规则回复。
      if (this.isSuspended(extensionId)) continue
      if (!hasExtensionPermission(record.grantedPermissions, 'messages.subscribe')) continue
      if (host.snapshot().state !== 'active') continue
      subscribers.push({
        extensionId,
        subscriptions: manifest.subscriptions,
        deliver: (envelope) => host.deliverEvent(envelope)
      })
    }
    return subscribers
  }

  private async queryMessages(
    extensionId: string,
    request: ExtensionMessagesQueryRequest
  ): Promise<ExtensionQueriedMessage[]> {
    if (!this.dependencies.isDatabaseReady()) {
      throw new ExtensionError('DATABASE_NOT_READY')
    }
    const conversationId = String(request?.conversationId || '').trim()
    if (!conversationId || conversationId.length > 128) {
      throw new ExtensionError('INVALID_REQUEST', '会话 id 不合法')
    }
    const limit = Math.max(1, Math.min(Number(request?.limit) || 50, 500))
    const startTime = Number.isFinite(Number(request?.startTime))
      ? Number(request.startTime)
      : Date.now() - 24 * 60 * 60 * 1000
    const endTime = Number.isFinite(Number(request?.endTime)) ? Number(request.endTime) : Date.now()
    if (endTime <= startTime) throw new ExtensionError('INVALID_REQUEST', '时间范围不合法')
    if (endTime - startTime > 35 * 24 * 60 * 60 * 1000) {
      throw new ExtensionError('INVALID_REQUEST', '单次查询范围不能超过 35 天')
    }
    const record = this.registry.get(extensionId)
    if (!record?.enabled) throw new ExtensionError('EXTENSION_DISABLED')
    return this.dependencies.queryMessages({
      conversationId,
      startTime,
      endTime,
      limit
    })
  }

  private async sendText(
    extensionId: string,
    request: ExtensionSendTextRequest
  ): Promise<ExtensionSendTextResult> {
    const record = this.registry.get(extensionId)
    if (!record) throw new ExtensionError('EXTENSION_NOT_FOUND')
    if (!record.enabled) throw new ExtensionError('EXTENSION_DISABLED')
    if (this.isSuspended(extensionId)) {
      throw new ExtensionError('EXTENSION_STORAGE_CORRUPTED', '扩展已暂停，发送被拒绝')
    }
    const manifest = this.manifests.get(extensionId)
    return this.sendGateway.sendText(
      {
        extensionId,
        permissions: record.grantedPermissions,
        conversationScope: manifest?.subscriptions?.conversationIds ?? []
      },
      request
    )
  }

  private async sendImage(
    extensionId: string,
    request: ExtensionSendImageRequest
  ): Promise<ExtensionSendTextResult> {
    const record = this.registry.get(extensionId)
    if (!record) throw new ExtensionError('EXTENSION_NOT_FOUND')
    if (!record.enabled) throw new ExtensionError('EXTENSION_DISABLED')
    if (this.isSuspended(extensionId)) {
      throw new ExtensionError('EXTENSION_STORAGE_CORRUPTED', '扩展已暂停，发送被拒绝')
    }
    const manifest = this.manifests.get(extensionId)
    return this.sendGateway.sendImage(
      {
        extensionId,
        permissions: record.grantedPermissions,
        conversationScope: manifest?.subscriptions?.conversationIds ?? []
      },
      request
    )
  }

  private async sendVideo(
    extensionId: string,
    request: ExtensionSendVideoRequest
  ): Promise<ExtensionSendTextResult> {
    const record = this.registry.get(extensionId)
    if (!record) throw new ExtensionError('EXTENSION_NOT_FOUND')
    if (!record.enabled) throw new ExtensionError('EXTENSION_DISABLED')
    if (this.isSuspended(extensionId)) {
      throw new ExtensionError('EXTENSION_STORAGE_CORRUPTED', '扩展已暂停，发送被拒绝')
    }
    const manifest = this.manifests.get(extensionId)
    return this.sendGateway.sendVideo(
      {
        extensionId,
        permissions: record.grantedPermissions,
        conversationScope: manifest?.subscriptions?.conversationIds ?? []
      },
      request
    )
  }

  private async sendVoice(
    extensionId: string,
    request: ExtensionSendVoiceRequest
  ): Promise<ExtensionSendTextResult> {
    const record = this.registry.get(extensionId)
    if (!record) throw new ExtensionError('EXTENSION_NOT_FOUND')
    if (!record.enabled) throw new ExtensionError('EXTENSION_DISABLED')
    if (this.isSuspended(extensionId)) {
      throw new ExtensionError('EXTENSION_STORAGE_CORRUPTED', '扩展已暂停，发送被拒绝')
    }
    const manifest = this.manifests.get(extensionId)
    return this.sendGateway.sendVoice(
      {
        extensionId,
        permissions: record.grantedPermissions,
        conversationScope: manifest?.subscriptions?.conversationIds ?? []
      },
      request
    )
  }

  private async buildCapabilitySnapshot(extensionId: string): Promise<ExtensionCapabilitySnapshot> {
    const record = this.registry.get(extensionId)
    const granted = record?.grantedPermissions ?? []
    const capability = await this.dependencies.getCapability().catch(() => null)
    let licensed = false
    if (
      hasExtensionPermission(granted as ExtensionPermission[], 'wechat.send.text') ||
      hasExtensionPermission(granted as ExtensionPermission[], 'wechat.send.voice') ||
      hasExtensionPermission(granted as ExtensionPermission[], 'wechat.send.image') ||
      hasExtensionPermission(granted as ExtensionPermission[], 'wechat.send.video')
    ) {
      const entitlement = await this.dependencies.checkEntitlement().catch(() => null)
      licensed = entitlement?.ok === true
    }
    let tts: ExtensionTtsCapabilitySnapshot | undefined
    if (this.dependencies.ttsStatus) {
      try {
        tts = await this.dependencies.ttsStatus()
      } catch {
        tts = {
          configured: false,
          model: 's2.1-pro-free',
          selectedVoiceId: '',
          selectedVoice: null
        }
      }
    }
    return {
      extensionId,
      enabled: record?.enabled === true,
      permissions: [...granted],
      platform: this.dependencies.platform ?? process.platform,
      databaseReady: this.dependencies.isDatabaseReady(),
      send: {
        supported: Boolean(capability?.supported),
        ready: Boolean(capability?.ready),
        canSendText: Boolean(capability?.capabilities?.text),
        canSendImage: Boolean(capability?.capabilities?.image),
        canSendVideo: Boolean(capability?.capabilities?.video),
        canSendVoice: Boolean(capability?.capabilities?.voice),
        licensed,
        message: capability?.message || '暂时无法获知微信发送能力'
      },
      ai: (() => {
        try {
          const status = this.dependencies.aiStatus?.()
          return status
            ? { configured: status.configured, modelName: status.modelName }
            : { configured: false, modelName: '' }
        } catch {
          return { configured: false, modelName: '' }
        }
      })(),
      ...(tts ? { tts } : {})
    }
  }

  private toInstalled(record: ExtensionRegistryRecord): InstalledExtension {
    const manifest = this.readManifest(record.id)
    const compatibility = manifest
      ? checkExtensionCompatibility(manifest, this.dependencies.appVersion)
      : { compatible: false, code: 'manifest' as const, reason: '扩展文件缺失或 manifest 无法读取' }
    const host = this.hosts.get(record.id)
    const runtime = host ? host.snapshot() : this.deriveIdleRuntime(record, manifest)
    const pendingPermissions = manifest
      ? manifest.permissions.filter((permission) => !record.grantedPermissions.includes(permission))
      : []
    const storageHealth = this.storage.health(record.id)
    return {
      id: record.id,
      name: manifest?.name || record.id,
      version: manifest?.version || record.version,
      apiVersion: manifest?.apiVersion || record.apiVersion,
      ...(manifest?.minAppVersion ? { minAppVersion: manifest.minAppVersion } : {}),
      ...(manifest?.description ? { description: manifest.description } : {}),
      ...(manifest?.author ? { author: manifest.author } : {}),
      enabled: record.enabled,
      installedAt: record.installedAt,
      updatedAt: record.updatedAt,
      compatibility,
      source: record.source,
      ...(record.templateId
        ? {
            template: {
              id: record.templateId,
              version: record.templateVersion || ''
            }
          }
        : {}),
      ...(record.source === 'development'
        ? {
            development: {
              sourcePath: record.developmentSourcePath || '',
              available: this.isDevelopmentRootAvailable(record.id)
            }
          }
        : {}),
      permissions: manifest?.permissions ?? [],
      grantedPermissions: record.grantedPermissions,
      pendingPermissions,
      runtime,
      pages: (manifest?.contributions.pages ?? []).map((page) => ({
        id: page.id,
        title: page.title
      })),
      automationActions: this.actions.summariesFor(record.id),
      filesPresent: Boolean(manifest),
      storage: {
        state: storageHealth.state,
        ...(storageHealth.message ? { message: storageHealth.message } : {})
      }
    }
  }

  /** 没有 Host 时的运行状态。 */
  private deriveIdleRuntime(
    record: ExtensionRegistryRecord,
    manifest: ExtensionManifest | null
  ): InstalledExtension['runtime'] {
    const base = { since: record.updatedAt, restarts: 0 }
    // 版本不一致优先展示：即使扩展已停用，用户也需要知道上一次升级可能中断。
    const drift = this.inconsistencies.get(record.id)
    if (drift) return { state: 'error', ...base, lastError: drift }
    if (this.storageHolds.has(record.id) && record.enabled) {
      return {
        state: 'error',
        ...base,
        lastError: '扩展配置曾从备份恢复，确认后才能启动'
      }
    }
    if (!record.enabled) return { state: 'inactive', ...base }
    if (!manifest) {
      return {
        state: 'error',
        ...base,
        lastError: '扩展文件缺失或 manifest 无法读取'
      }
    }
    if (!manifest.entrypoints.background) {
      return { state: 'inactive', ...base, note: '仅提供页面，没有后台任务' }
    }
    const compatibility = checkExtensionCompatibility(manifest, this.dependencies.appVersion)
    if (!compatibility.compatible) {
      return {
        state: 'error',
        ...base,
        lastError: compatibility.reason || '扩展与当前版本不兼容'
      }
    }
    return { state: 'error', ...base, lastError: '后台进程未启动' }
  }

  private isDevelopmentRootAvailable(extensionId: string): boolean {
    try {
      return Boolean(this.roots.resolve(extensionId).root)
    } catch {
      return false
    }
  }

  private readManifest(extensionId: string): ExtensionManifest | null {
    if (this.manifests.has(extensionId)) return this.manifests.get(extensionId) ?? null
    let root: string
    try {
      root = this.roots.resolve(extensionId).root
    } catch {
      // 开发目录不可用或扩展不存在：交给调用方按「没有 manifest」处理。
      return null
    }
    const file = path.join(root, 'manifest.json')
    let manifest: ExtensionManifest | null = null
    try {
      const parsed = parseExtensionManifest(fs.readJsonSync(file) as unknown)
      manifest = parsed.ok ? (parsed.manifest ?? null) : null
    } catch {
      manifest = null
    }
    this.manifests.set(extensionId, manifest)
    return manifest
  }
}

function failure(error: unknown): ExtensionOperationResult {
  const payload = toExtensionErrorPayload(error)
  return { success: false, error: payload }
}
