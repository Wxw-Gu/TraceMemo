import type { ImageDecryptionAction, ImageDecryptionState } from './types'

export const initialImageDecryptionState: ImageDecryptionState = {
  phase: 'checking',
  config: null,
  status: null,
  contacts: [],
  selectedUserMd5: '',
  resourceRoot: '',
  xorKey: '0x40',
  aesKey: '',
  testResult: null,
  autoPhase: 'idle',
  autoProgress: '',
  dirty: false
}

export function imageDecryptionReducer(
  state: ImageDecryptionState,
  action: ImageDecryptionAction
): ImageDecryptionState {
  switch (action.type) {
    case 'LOADED':
      return {
        ...state,
        phase: action.config.configured ? 'configured' : 'not-configured',
        config: action.config,
        status: action.status,
        contacts: action.contacts,
        // 下方"图片资源目录"跟随状态面板的默认目录同步；
        // 一旦用户手动编辑过（dirty），就不再被刷新覆盖。
        resourceRoot: state.dirty && state.resourceRoot
          ? state.resourceRoot
          : action.status.resourceRoot || action.config.resourceRoot,
        xorKey: action.config.xorKey || '0x40',
        aesKey: action.config.aesKey || '',
        error: action.config.success ? undefined : action.config.error,
        dirty: false
      }
    case 'LOAD_ERROR':
      return { ...state, phase: 'not-configured', error: action.error }
    case 'EDIT':
      return {
        ...state,
        [action.field]: action.value,
        phase: state.config?.configured ? 'configured' : 'not-configured',
        testResult: null,
        error: undefined,
        dirty: true
      }
    case 'SELECT_CHAT':
      return { ...state, selectedUserMd5: action.userMd5, testResult: null, error: undefined }
    case 'TEST_START':
      return { ...state, phase: 'testing', testResult: null, error: undefined }
    case 'TEST_DONE':
      return {
        ...state,
        phase: action.result.success ? 'test-success' : 'test-failed',
        testResult: action.result,
        error: action.result.error,
        status:
          action.result.success && state.status
            ? {
                ...state.status,
                resources: {
                  ...state.status.resources,
                  thumbnail: action.result.isThumbnail
                    ? { state: 'available', detail: '正常' }
                    : state.status.resources.thumbnail,
                  original: action.result.isThumbnail
                    ? { state: 'unavailable', detail: '本次未找到原图' }
                    : { state: 'available', detail: '正常' }
                }
              }
            : state.status
      }
    case 'AUTO_START':
      return {
        ...state,
        phase: 'checking',
        autoPhase: 'scanning',
        autoProgress: '正在检查微信运行环境',
        autoAccount: undefined,
        autoError: undefined,
        error: undefined
      }
    case 'AUTO_PROGRESS':
      return { ...state, autoProgress: action.message }
    case 'AUTO_CANDIDATE':
      return {
        ...state,
        autoPhase: 'candidate-found',
        resourceRoot: action.resourceRoot,
        xorKey: action.xorKey,
        aesKey: action.aesKey,
        autoAccount: action.account,
        autoProgress: '已发现候选密钥',
        dirty: true
      }
    case 'AUTO_VALIDATING':
      return { ...state, autoPhase: 'validating', autoProgress: '正在验证候选密钥的图片解析能力' }
    case 'AUTO_DONE':
      return {
        ...state,
        phase: 'test-success',
        autoPhase: 'success',
        autoProgress: '图片密钥验证成功',
        dirty: true
      }
    case 'AUTO_SAVE_START':
      return { ...state, autoPhase: 'saving', autoProgress: '正在安全保存图片密钥' }
    case 'AUTO_SAVED':
      return { ...state, autoPhase: 'saved', autoProgress: '图片密钥已安全保存' }
    case 'AUTO_ERROR':
      return {
        ...state,
        phase: 'test-failed',
        autoPhase: 'failed',
        autoError: action.error,
        autoProgress: ''
      }
    case 'OPERATION_ERROR':
      return { ...state, phase: 'test-failed', error: action.error }
    case 'CLEAR_START':
      return { ...state, phase: 'clearing', error: undefined }
    case 'CLEAR_DONE':
      return {
        ...initialImageDecryptionState,
        phase: 'clear-success',
        config: action.config,
        status: action.status,
        contacts: state.contacts,
        resourceRoot: action.status.resourceRoot || action.config.resourceRoot
      }
    default:
      return state
  }
}
