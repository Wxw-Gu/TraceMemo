import type { ExtensionCompatibility } from './manifest'
import type { ExtensionPermission } from './permissions'
import type { ExtensionErrorPayload } from './errors'

/** 扩展后台进程状态。`crashed` 表示连续崩溃后已停止自动重启，等用户手动处理。 */
export type ExtensionRuntimeState = 'inactive' | 'starting' | 'active' | 'error' | 'crashed'

export interface ExtensionRuntimeSnapshot {
  state: ExtensionRuntimeState
  since: number
  restarts: number
  /** 面向用户的一句话；**不含**路径、wxid、聊天正文。 */
  lastError?: string
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
  permissions: ExtensionPermission[]
  grantedPermissions: ExtensionPermission[]
  runtime: ExtensionRuntimeSnapshot
  pages: Array<{ id: string; title: string }>
  automationActions: ExtensionAutomationActionSummary[]
  /** 扩展目录是否仍然存在；false 时 UI 必须显示为「文件缺失」而不是可启动。 */
  filesPresent: boolean
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
  | 'test.send'
  | 'douyin.cookie.get'
  | 'douyin.cookie.set'
  | 'douyin.cookie.clear'
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
