import type { MacHardwareArch, MacKeyFlow } from './macos-arch'

export type DatabaseKeyValidationCode =
  | 'INVALID_FORMAT'
  | 'DATABASE_OPEN_FAILED'
  | 'ACCOUNT_MISMATCH'
  | 'ROOT_UNAVAILABLE'
  | 'DATABASE_FILE_MISSING'
  /**
   * 路径存在、但**当前进程无权读取**（macOS 的完全磁盘访问权限是最常见的成因）。
   *
   * 与 `DATABASE_FILE_MISSING` 分开，是因为两者的下一步动作完全不同：
   * 文件真的不存在要用户去查路径 / 重装，而权限不足要用户去系统设置授权。
   * 合成一个码会把用户指向错误的排查方向。
   */
  | 'DATABASE_PERMISSION_DENIED'
  | 'VC_RUNTIME_MISSING'
  | 'UNKNOWN_VALIDATION_ERROR'

export type DatabaseInitCode = DatabaseKeyValidationCode | 'ACCOUNT_SELECTION_REQUIRED'

export interface DatabaseInitResult {
  success: boolean
  code?: DatabaseInitCode
  error?: string
  monitoring?: boolean
}

export interface DatabaseKeyValidationResult {
  success: boolean
  code?: DatabaseKeyValidationCode
  error?: string
  accountRoot?: string
  wxid?: string
  contacts?: { available: boolean; count?: number }
  messages?: { available: boolean; count?: number }
}

export interface DatabaseKeyStorageResult {
  success: boolean
  key?: string
  error?: string
  saved: boolean
  encryptionAvailable: boolean
}

export type AccountLoginStatus = 'current' | 'other' | 'unknown'

export interface WechatAccountCandidate {
  id: string
  accountRoot: string
  directoryName: string
  wxid?: string
  nickname?: string
  avatar?: string
  hasSavedDbKey: boolean
  loginStatus: AccountLoginStatus
  selectedByInput: boolean
}

export interface AccountDiscoveryResult {
  success: boolean
  inputKind?: 'root' | 'account'
  accounts: WechatAccountCandidate[]
  preselectedAccountId?: string
  error?: string
}

export interface DatabaseKeyEnvironment {
  platform: NodeJS.Platform
  /**
   * 进程运行架构（`process.arch`）。原生库按它选择，不要用硬件架构替换：
   * Rosetta 下的 x64 进程无法加载 arm64 动态库。
   */
  architecture?: string
  /** CPU 实际架构，来自 `hw.optional.arm64`。 */
  hardwareArchitecture?: MacHardwareArch
  /** 当前进程是否被 Rosetta 翻译。 */
  underARM64Translation?: boolean
  /**
   * 密钥流程的唯一判据。UI 读它，主进程分流也读它，避免两侧各自推断。
   * 缺省时 UI 回落到 `architecture`，用于主进程尚未提供该字段的场景。
   */
  macKeyFlow?: MacKeyFlow
  /** 架构信号矛盾时的诊断标记，例如 `hardware_arch_unknown`。 */
  archAnomalies?: string[]
  osVersion: string
  appVersion: string
  wechatVersion: string
  dataStructureVersion: string
  dataDirectoryDetected: boolean
  diagnosticSummary: string
  autoDetectSupported: boolean
  wechatRunning: boolean
  accountIdentified: boolean
  dbConnected: boolean
  encryptionAvailable: boolean
  sipDisabled?: boolean
  pythonAvailable?: boolean
  fridaAvailable?: boolean
  wechatAdhocSigned?: boolean
}
