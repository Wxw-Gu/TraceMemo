import fs from 'fs-extra'
import os from 'node:os'
import path from 'node:path'
import { safeStorage } from 'electron'
import { ExtensionError, toExtensionErrorPayload } from '../../shared/extensions/errors'
import {
  autoGrantedPermissions,
  hasExtensionPermission,
  type ExtensionPermission
} from '../../shared/extensions/permissions'
import {
  checkExtensionCompatibility,
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
  InstalledExtension
} from '../../shared/extensions/types'
import type {
  ExtensionAutomationActionOutput,
  ExtensionMessagesQueryRequest,
  ExtensionQueriedMessage,
  ExtensionSendImageRequest,
  ExtensionSendTextRequest,
  ExtensionSendTextResult,
  ExtensionSendVideoRequest
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
import { ExtensionInstaller } from './extension-installer'
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
  getAccountId: () => string
  getSelfUsernames: () => string[]
  isDatabaseReady: () => boolean
  now?: () => number
  onChange?: (
    extensionId: string,
    reason: 'installed' | 'enabled' | 'disabled' | 'uninstalled' | 'runtime' | 'actions'
  ) => void
}

const PAGE_METHODS: ExtensionPageMethod[] = [
  'storage.get',
  'storage.set',
  'storage.remove',
  'storage.list',
  'capabilities.get',
  'contacts.listGroups',
  'test.send',
  'douyin.cookie.get',
  'douyin.cookie.set',
  'douyin.cookie.clear',
  'extension.info'
]

/**
 * 扩展系统的编排层。
 *
 * 职责边界：
 * - **只做编排**：清单读取、安装、启停、进程托管、事件分发、能力转发；
 * - 不实现消息监听（复用 `MessageListenerService`）、不实现发送（复用
 *   `WechatActionGateway`）、不实现自动化规则存储（复用 `AutomationRuleStore`）。
 *
 * 所有扩展代码都在 `ExtensionHost` 的子进程里运行；本类不 `require` 任何扩展文件。
 */
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

  constructor(dependencies: ExtensionManagerDependencies) {
    this.dependencies = dependencies
    this.paths = dependencies.paths
    this.now = dependencies.now ?? (() => Date.now())
    this.registry = new ExtensionRegistry({ registryFile: this.paths.registryFile, now: this.now })
    this.installer = new ExtensionInstaller({
      paths: this.paths,
      registry: this.registry,
      now: this.now
    })
    this.storage = new ExtensionStorage({ dataRoot: this.paths.dataDir })
    this.logs = new ExtensionLogStore(this.paths.logsDir)
    this.sendGateway = new ExtensionSendGateway({
      getCapability: dependencies.getCapability,
      checkEntitlement: dependencies.checkEntitlement,
      executeAction: dependencies.executeAction,
      getExtensionDataRoot: (extensionId) => this.paths.extensionDataDir(extensionId),
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
    for (const record of this.registry.list()) {
      const manifest = this.readManifest(record.id)
      if (!manifest) {
        this.logs.append(record.id, 'error', 'core', '扩展文件缺失或 manifest 无法读取')
        continue
      }
      this.syncDeclared(record.id, manifest)
      if (!record.enabled) continue
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
    return this.install(() =>
      this.installer.installFromDirectory(directory, { appVersion: this.dependencies.appVersion })
    )
  }

  async installFromPackage(packagePath: string): Promise<ExtensionInstallResult> {
    return this.install(() =>
      this.installer.installFromPackage(packagePath, {
        appVersion: this.dependencies.appVersion,
        source: 'package'
      })
    )
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

  /**
   * 扩展页面可调用的能力。
   *
   * 页面**没有**发送 / 查询 / AI 权限：那些能力只从后台进程按权限申请。
   * 页面与后台共享同一个 `storage` 命名空间，所以配置页保存的内容后台能直接读到。
   */
  async pageRequest(
    extensionId: string,
    method: string,
    params: Record<string, unknown> = {}
  ): Promise<ExtensionPageResponse> {
    try {
      if (!PAGE_METHODS.includes(method as ExtensionPageMethod)) {
        throw new ExtensionError('PERMISSION_DENIED', `页面不能调用 ${method}`)
      }
      if (method.startsWith('douyin.cookie.') && extensionId !== 'com.example.douyin-sender') {
        throw new ExtensionError('PERMISSION_DENIED', 'Cookie 能力不适用于此扩展')
      }
      const record = this.registry.get(extensionId)
      if (!record) throw new ExtensionError('EXTENSION_NOT_FOUND')
      const manifest = this.readManifest(extensionId)
      if (!manifest) throw new ExtensionError('EXTENSION_INVALID_MANIFEST', '扩展文件缺失')
      if (!manifest.permissions.includes('storage') && method.startsWith('storage.')) {
        throw new ExtensionError('PERMISSION_DENIED', '扩展没有 storage 权限')
      }
      if (method === 'contacts.listGroups' && !manifest.permissions.includes('contacts.list')) {
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
        case 'test.send': {
          if (extensionId !== 'com.example.douyin-sender') {
            throw new ExtensionError('PERMISSION_DENIED', '测试能力不适用于此扩展')
          }
          const host = this.hosts.get(extensionId)
          if (!host) throw new ExtensionError('EXTENSION_DISABLED')
          const cookieHeader = String(params.cookieHeader || '') || this.readDouyinCookie()
          try {
            return { ok: true, result: await host.testSend({ ...params, cookieHeader }) }
          } finally {
            params.cookieHeader = ''
          }
        }
        case 'douyin.cookie.get':
          return { ok: true, result: { configured: Boolean(this.readDouyinCookie()) } }
        case 'douyin.cookie.set': {
          const value = String(params.cookieHeader || '').trim()
          if (!value) throw new ExtensionError('INVALID_REQUEST', 'Cookie 不能为空')
          if (!safeStorage.isEncryptionAvailable())
            throw new ExtensionError('CAPABILITY_UNAVAILABLE', '系统安全存储不可用')
          fs.writeFileSync(
            path.join(this.paths.userData, 'douyin-cookie.bin'),
            safeStorage.encryptString(value),
            { mode: 0o600 }
          )
          fs.chmodSync(path.join(this.paths.userData, 'douyin-cookie.bin'), 0o600)
          this.syncDouyinCookieToExtensionData(value)
          return { ok: true, result: { configured: true } }
        }
        case 'douyin.cookie.clear':
          this.clearDouyinCookie()
          return { ok: true, result: { configured: false } }
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

  private syncDouyinCookieToExtensionData(value: string): void {
    try {
      const dataDir = this.paths.extensionDataDir('com.example.douyin-sender')
      fs.ensureDirSync(dataDir)
      const target = path.join(dataDir, 'douyin-cookie.txt')
      fs.writeFileSync(target, value, { mode: 0o600 })
      fs.chmodSync(target, 0o600)
    } catch {
      // 扩展数据目录同步失败不影响加密主存储。
    }
  }

  private readDouyinCookie(): string {
    const file = path.join(this.paths.userData, 'douyin-cookie.bin')
    if (fs.existsSync(file) && safeStorage.isEncryptionAvailable()) {
      try {
        const decrypted = safeStorage.decryptString(fs.readFileSync(file)).trim()
        if (decrypted) {
          this.syncDouyinCookieToExtensionData(decrypted)
          return decrypted
        }
      } catch {
        // 加密文件损坏或不可解密时继续尝试桌面 Cookie 文件。
      }
    }
    const desktopCookie = path.join(os.homedir(), 'Desktop', 'douyin-cookie')
    if (fs.existsSync(desktopCookie)) {
      try {
        return fs.readFileSync(desktopCookie, 'utf8').trim()
      } catch {
        return ''
      }
    }
    return ''
  }

  private clearDouyinCookie(): void {
    try {
      fs.removeSync(path.join(this.paths.userData, 'douyin-cookie.bin'))
      fs.removeSync(
        path.join(this.paths.extensionDataDir('com.example.douyin-sender'), 'douyin-cookie.txt')
      )
    } catch {
      throw new ExtensionError('INVALID_REQUEST', '无法清除抖音 Cookie')
    }
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

  async dispose(): Promise<void> {
    const ids = Array.from(this.hosts.keys())
    await Promise.all(ids.map((id) => this.stopHost(id)))
  }

  private async install(
    run: () => Promise<{ manifest: ExtensionManifest; upgraded: boolean; previousVersion?: string }>
  ): Promise<ExtensionInstallResult> {
    let outcome: Awaited<ReturnType<typeof run>>
    try {
      outcome = await run()
    } catch (error) {
      return { success: false, error: toExtensionErrorPayload(error) }
    }
    const { manifest } = outcome
    const wasEnabled = this.registry.get(manifest.id)?.enabled === true
    if (wasEnabled) await this.stopHost(manifest.id)
    this.manifests.delete(manifest.id)
    this.manifests.set(manifest.id, manifest)
    this.syncDeclared(manifest.id, manifest)
    // 新安装只自动授予低风险权限；升级保留用户已经授予的集合。
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
      await this.startHost(manifest.id, manifest).catch(() => undefined)
    }
    const installed = this.get(manifest.id)
    return { success: true, ...(installed ? { extension: installed } : {}) }
  }

  private async startHost(extensionId: string, manifest: ExtensionManifest): Promise<void> {
    if (!manifest.entrypoints.background) return
    await this.stopHost(extensionId)
    const host = new ExtensionHost({
      extensionId,
      extensionDir: this.paths.installDir(extensionId),
      dataDir: this.paths.extensionDataDir(extensionId),
      permissions: this.registry.get(extensionId)?.grantedPermissions ?? [],
      storage: this.storage,
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
    const limit = Math.max(1, Math.min(Number(request?.limit) || 50, 200))
    const startTime = Number.isFinite(Number(request?.startTime))
      ? Number(request.startTime)
      : Date.now() - 24 * 60 * 60 * 1000
    const endTime = Number.isFinite(Number(request?.endTime)) ? Number(request.endTime) : Date.now()
    if (endTime <= startTime) throw new ExtensionError('INVALID_REQUEST', '时间范围不合法')
    if (endTime - startTime > 7 * 24 * 60 * 60 * 1000) {
      throw new ExtensionError('INVALID_REQUEST', '单次查询范围不能超过 7 天')
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

  private async buildCapabilitySnapshot(extensionId: string): Promise<ExtensionCapabilitySnapshot> {
    const record = this.registry.get(extensionId)
    const granted = record?.grantedPermissions ?? []
    const capability = await this.dependencies.getCapability().catch(() => null)
    let licensed = false
    if (hasExtensionPermission(granted as ExtensionPermission[], 'wechat.send.text')) {
      const entitlement = await this.dependencies.checkEntitlement().catch(() => null)
      licensed = entitlement?.ok === true
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
        licensed,
        message: capability?.message || '暂时无法获知微信发送能力'
      },
      ai: {
        configured: false,
        modelName: ''
      }
    }
  }

  private toInstalled(record: ExtensionRegistryRecord): InstalledExtension {
    const manifest = this.readManifest(record.id)
    const compatibility = manifest
      ? checkExtensionCompatibility(manifest, this.dependencies.appVersion)
      : { compatible: false, code: 'manifest' as const, reason: '扩展文件缺失或 manifest 无法读取' }
    const host = this.hosts.get(record.id)
    const runtime = host
      ? host.snapshot()
      : {
          state: record.enabled ? ('active' as const) : ('inactive' as const),
          since: record.updatedAt,
          restarts: 0
        }
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
      permissions: manifest?.permissions ?? [],
      grantedPermissions: record.grantedPermissions,
      runtime,
      pages: (manifest?.contributions.pages ?? []).map((page) => ({
        id: page.id,
        title: page.title
      })),
      automationActions: this.actions.summariesFor(record.id),
      filesPresent: Boolean(manifest)
    }
  }

  private readManifest(extensionId: string): ExtensionManifest | null {
    if (this.manifests.has(extensionId)) return this.manifests.get(extensionId) ?? null
    const file = path.join(this.paths.installDir(extensionId), 'manifest.json')
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
