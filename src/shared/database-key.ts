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
  architecture?: string
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
