import type { ExtensionCompatibility } from './manifest'
import type { ExtensionPermission } from './permissions'
import type { ExtensionErrorPayload } from './errors'
import type { ExtensionSource } from './source'

/** 扩展后台进程状态。`crashed` 表示连续崩溃后已停止自动重启，等用户手动处理。 */
export type ExtensionRuntimeState = 'inactive' | 'starting' | 'active' | 'error' | 'crashed'

export interface ExtensionRuntimeSnapshot {
  state: ExtensionRuntimeState
  since: number
  restarts: number
  /** 面向用户的一句话；**不含**路径、wxid、聊天正文。 */
  lastError?: string
  /**
   * 状态补充说明，用于区分「已停止」与「本来就没有后台任务」。
   * 例如只有页面入口的扩展会得到 `inactive` + 本字段。
   */
  note?: string
}

/** 扩展私有存储的健康状态。非 `ok` 时界面必须提示用户。 */
export type ExtensionStorageHealthState = 'ok' | 'recovered-from-backup' | 'unrecovered'

export interface ExtensionStorageHealthSummary {
  state: ExtensionStorageHealthState
  /** 面向用户的一句话；不含路径。 */
  message?: string
}

export interface ExtensionAutomationActionSummary {
  /** 扩展内唯一 id（manifest 声明）。 */
  id: string
  title: string
  description?: string
  /** 宿主运行期是否真的注册成功（后台进程未启动时为 false）。 */
  registered: boolean
}

export interface InstalledExtension {
  id: string
  name: string
  version: string
  apiVersion: string
  minAppVersion?: string
  description?: string
  author?: string
  enabled: boolean
  installedAt: number
  updatedAt: number
  compatibility: ExtensionCompatibility
  /** 安装来源；只有 `template` 的记录归官方模板目录管理。 */
  source: ExtensionSource
  /** 来源为官方模板时，记录模板 id 与安装时的模板版本。 */
  template?: { id: string; version: string }
  /**
   * 开发模式的源码位置。
   *
   * `available === false` 表示目录被移动或删除：Registry 与用户配置都还在，
   * 只是暂时跑不起来，界面要给「重新选择目录」而不是「扩展没了」。
   */
  development?: { sourcePath: string; available: boolean }
  permissions: ExtensionPermission[]
  grantedPermissions: ExtensionPermission[]
  /**
   * manifest 声明但用户尚未授予的权限。
   *
   * 非空表示该扩展升级后新增了能力：这些能力当前**不可用**，
   * 需要用户显式授权后才会下发到后台进程。
   */
  pendingPermissions: ExtensionPermission[]
  runtime: ExtensionRuntimeSnapshot
  pages: Array<{ id: string; title: string }>
  automationActions: ExtensionAutomationActionSummary[]
  /** 扩展目录是否仍然存在；false 时 UI 必须显示为「文件缺失」而不是可启动。 */
  filesPresent: boolean
  storage: ExtensionStorageHealthSummary
}

/**
 * 从其它页面跳到扩展中心时的定位目标。
 *
 * 只描述「去哪里」，不携带任何安装状态：扩展中心自己读 Registry，
 * 避免两个页面各维护一份事实。
 */
export interface ExtensionDeepLink {
  /** 定位官方模板（打开模板画廊并展开该卡片）。 */
  templateId?: string
  /** 定位已安装扩展（选中详情）。 */
  extensionId?: string
  /** 打开「二次开发」引导（创建项目 / 链接本地 / 重载 / 文档）。 */
  development?: boolean
}

/**
 * 单个扩展动作的完整可用性描述。
 *
 * `registered` 只说明后台注册过，`available` 才决定能不能用：
 * 停用、代码缺失、权限未授予、Schema 非法、Storage 暂停都会让 available=false。
 */
export interface ExtensionActionInfo {
  extensionId: string
  extensionName: string
  actionId: string
  title: string
  description?: string
  declared: boolean
  registered: boolean
  enabled: boolean
  available: boolean
  unavailableReason?: string
  inputSchema?: import('./action-schema').ExtensionActionInputSchema
}

export interface ExtensionLogEntry {
  id: string
  at: number
  level: 'info' | 'warn' | 'error'
  /** 来源：宿主自身事件，或扩展代码主动写入的日志。 */
  source: 'core' | 'extension'
  message: string
}

export interface ExtensionInstallResult {
  success: boolean
  extension?: InstalledExtension
  error?: ExtensionErrorPayload
}

export interface ExtensionOperationResult {
  success: boolean
  error?: ExtensionErrorPayload
}

/** 项目生成 / 导出结果；`projectPath` 是用户目录里的绝对路径。 */
export interface ExtensionProjectResult extends ExtensionOperationResult {
  projectPath?: string
  /** 被改写扩展身份的源码文件（相对路径）。 */
  rewrittenFiles?: string[]
}

export interface ExtensionPageDescriptor {
  extensionId: string
  pageId: string
  title: string
  url: string
}

/** 渲染层可调用的页面侧能力白名单；扩展页面拿不到发送 / AI / 查询权限。 */
export type ExtensionPageMethod =
  | 'storage.get'
  | 'storage.set'
  | 'storage.remove'
  | 'storage.list'
  | 'capabilities.get'
  | 'contacts.listGroups'
  /** 通用通道：把请求转发给**同一扩展**后台注册的处理器。 */
  | 'extension.request'
  | 'extension.info'

export interface ExtensionPageRequest {
  extensionId: string
  method: ExtensionPageMethod
  params?: Record<string, unknown>
}

export interface ExtensionPageResponse {
  ok: boolean
  result?: unknown
  error?: ExtensionErrorPayload
}

export interface ExtensionCapabilitySnapshot {
  extensionId: string
  enabled: boolean
  permissions: ExtensionPermission[]
  platform: NodeJS.Platform
  databaseReady: boolean
  send: {
    supported: boolean
    ready: boolean
    canSendText: boolean
    /** 图片与视频是两条独立通道。 */
    canSendImage: boolean
    canSendVideo: boolean
    /** 仅 `wechat.send.text` 被授予时才有意义。 */
    licensed: boolean
    message: string
  }
  ai: {
    configured: boolean
    modelName: string
  }
}

export interface ExtensionQuitBehavior {
  keepData: boolean
}

/** 扩展状态文件的可信度；渲染层据此决定是否显示告警条。 */
export type ExtensionRegistryHealthState =
  | 'ok'
  | 'recovered-from-backup'
  | 'recovered-by-scan'
  | 'unreadable'

export interface ExtensionSystemHealth {
  registry: {
    state: ExtensionRegistryHealthState
    message?: string
  }
}
