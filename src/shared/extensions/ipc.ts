import type { ExtensionErrorPayload } from './errors'

/** 扩展中心 IPC 通道。渲染层只依赖这些常量，不手写通道字符串。 */
export const EXTENSION_IPC = {
  list: 'extension:list',
  detail: 'extension:get',
  installDirectory: 'extension:installDirectory',
  installPackage: 'extension:installPackage',
  pickDirectory: 'extension:pickDirectory',
  pickPackage: 'extension:pickPackage',
  setEnabled: 'extension:setEnabled',
  uninstall: 'extension:uninstall',
  logs: 'extension:getLogs',
  clearLogs: 'extension:clearLogs',
  pageUrl: 'extension:getPageUrl',
  pageRequest: 'extension:pageRequest',
  openDataDir: 'extension:openDataDir',
  changed: 'extension:changed'
} as const

export type ExtensionChangeReason =
  | 'installed'
  | 'enabled'
  | 'disabled'
  | 'uninstalled'
  | 'runtime'
  | 'actions'

export interface ExtensionChangedEvent {
  extensionId: string
  reason: ExtensionChangeReason
}

export const EXTENSION_PAGE_MESSAGE_SOURCE = 'tracememo-extension-page'
export const EXTENSION_PAGE_HOST_SOURCE = 'tracememo-extension-host'

export interface ExtensionPageBridgeRequest {
  source: typeof EXTENSION_PAGE_MESSAGE_SOURCE
  extensionId: string
  requestId: string
  method: string
  params?: Record<string, unknown>
}

export interface ExtensionPageBridgeResponse {
  source: typeof EXTENSION_PAGE_HOST_SOURCE
  requestId: string
  ok: boolean
  result?: unknown
  error?: ExtensionErrorPayload
}

export function isExtensionPageBridgeRequest(value: unknown): value is ExtensionPageBridgeRequest {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<ExtensionPageBridgeRequest>
  return (
    candidate.source === EXTENSION_PAGE_MESSAGE_SOURCE &&
    typeof candidate.extensionId === 'string' &&
    typeof candidate.requestId === 'string' &&
    typeof candidate.method === 'string'
  )
}
