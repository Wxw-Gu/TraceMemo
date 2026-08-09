export type DatabaseKeyValidationCode =
  | 'INVALID_FORMAT'
  | 'DATABASE_OPEN_FAILED'
  | 'ACCOUNT_MISMATCH'
  | 'ROOT_UNAVAILABLE'
  | 'DATABASE_FILE_MISSING'
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
}
