/**
 * Wire types for the built-in macOS native WeChat runtime
 * (tm-wechat-host + libtmwechat.dylib), managed by MacWechatRuntimeManager.
 *
 * Binding lifecycle is "bind once per WeChat process": frida's unload/detach
 * inside WeChat is unreliable, so rebind is NOT a product path. When the host
 * dies while bound, the WeChat process keeps an orphaned agent and must be
 * restarted before binding again — surfaced as wechatRestartRequired.
 */

export type MacWechatRuntimeLifecycle =
  | 'stopped' // host not running (or never started)
  | 'starting' // spawn issued, waiting for /healthz
  | 'online' // host answering; WeChat NOT touched (lazy)
  | 'crashed_unbound' // died while unbound — safe to auto-restart
  | 'crashed_bound' // died while bound — WeChat keeps an orphan agent

export type MacWechatHostRuntimeState =
  | 'not_initialized'
  | 'wechat_not_running'
  | 'not_logged_in'
  | 'unsupported_version'
  | 'initializing'
  | 'ready'
  | 'error'
  | 'unknown'

export type MacWechatBindingState =
  | 'unbound'
  | 'binding'
  | 'bound'
  | 'ready'
  | 'failed'
  | 'stale'
  | 'unknown'

export interface MacWechatRuntimeManifest {
  runtime: 'tm-wechat-native'
  version: string
  platform: 'darwin-arm64'
  architecture: 'arm64'
  protocolVersion: number
  buildCommit: string
  tmSendSourceSha256: string
  addressProfileSha256: string
  supportedWechatVersions: string[]
  capabilities: Array<'text' | 'image' | 'voice'>
}

export interface MacWechatBindingStatus {
  runtime: boolean
  hostPid?: number
  runtimeState: MacWechatHostRuntimeState
  runtimeVersion?: string
  embeddedAgentSha256?: string
  embeddedAddressProfileSha256?: string
  abiVersion?: number
  dylibPath?: string
  wechatRunning: boolean
  wechatPid: number
  wechatVersion?: string
  supported: boolean
  supportedVersions?: string
  bindingState: MacWechatBindingState
  bound: boolean
  boundWechatPid: number
  sessionAttached: boolean
  scriptLoaded: boolean
  sendContextReady: boolean
  canSendText?: boolean
  canSendImage?: boolean
  canSendVoice?: boolean
  attachCount: number
  lastAttachAt?: string
  lastDetachReason?: string
}

export interface MacWechatRuntimeSnapshot {
  lifecycle: MacWechatRuntimeLifecycle
  /** True when the last host death happened while bound: WeChat must be restarted. */
  wechatRestartRequired: boolean
  endpoint: string
  port: number
  runtimeDir?: string
  manifest?: MacWechatRuntimeManifest
  error?: string
  binding?: MacWechatBindingStatus
}

export interface MacWechatBindResult {
  ok: boolean
  attached: boolean
  state?: 'wechat_restart_required' | 'runtime_offline' | 'host_error' | 'bad_response'
  message: string
}
