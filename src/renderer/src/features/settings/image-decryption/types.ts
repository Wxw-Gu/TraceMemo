import type { Contact } from '../../../../../shared/types'
import type {
  ImageDecryptionStatus,
  ImageDecryptionTestResult,
  ImageKeyConfigResult
} from '../../../../../shared/image-decryption'

export type ImageDecryptionPhase =
  | 'idle'
  | 'checking'
  | 'configured'
  | 'not-configured'
  | 'testing'
  | 'test-success'
  | 'test-failed'
  | 'clearing'
  | 'clear-success'
  | 'clear-failed'

export type ImageKeyAutoDetectPhase =
  | 'idle'
  | 'scanning'
  | 'candidate-found'
  | 'validating'
  | 'success'
  | 'saving'
  | 'saved'
  | 'failed'

export interface ImageDecryptionState {
  phase: ImageDecryptionPhase
  config: ImageKeyConfigResult | null
  status: ImageDecryptionStatus | null
  contacts: Contact[]
  selectedUserMd5: string
  resourceRoot: string
  xorKey: string
  aesKey: string
  testResult: ImageDecryptionTestResult | null
  autoPhase: ImageKeyAutoDetectPhase
  autoProgress: string
  autoAccount?: string
  autoError?: string
  error?: string
  dirty: boolean
}

export type ImageDecryptionAction =
  | {
      type: 'LOADED'
      config: ImageKeyConfigResult
      status: ImageDecryptionStatus
      contacts: Contact[]
    }
  | { type: 'LOAD_ERROR'; error: string }
  | { type: 'EDIT'; field: 'xorKey' | 'aesKey'; value: string }
  | { type: 'SELECT_CHAT'; userMd5: string }
  | { type: 'TEST_START' }
  | { type: 'TEST_DONE'; result: ImageDecryptionTestResult }
  | { type: 'AUTO_START' }
  | { type: 'AUTO_PROGRESS'; message: string }
  | {
      type: 'AUTO_CANDIDATE'
      resourceRoot: string
      xorKey: string
      aesKey: string
      account: string
    }
  | { type: 'AUTO_VALIDATING' }
  | { type: 'AUTO_DONE' }
  | { type: 'AUTO_SAVE_START' }
  | { type: 'AUTO_SAVED' }
  | { type: 'AUTO_ERROR'; error: string }
  | { type: 'OPERATION_ERROR'; error: string }
  | { type: 'CLEAR_START' }
  | { type: 'CLEAR_DONE'; config: ImageKeyConfigResult; status: ImageDecryptionStatus }

export interface ImageDecryptionController {
  state: ImageDecryptionState
  pageStatus: 'configured' | 'unconfigured' | 'partial'
  busy: boolean
  canSave: boolean
  edit: (field: 'xorKey' | 'aesKey', value: string) => void
  selectChat: (userMd5: string) => void
  test: () => Promise<void>
  save: () => Promise<void>
  autoDetect: () => Promise<void>
  clear: () => Promise<void>
  refresh: () => Promise<void>
}
