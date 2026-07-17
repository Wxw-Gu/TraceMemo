import { useCallback, useEffect, useMemo, useReducer } from 'react'
import type { Contact } from '../../../../../shared/types'
import type { SettingsSelfInfo } from '../model/types'
import { databaseKeyReducer, initialDatabaseKeyState } from './databaseKeyReducer'
import type { DatabaseKeyController } from './types'
import { buildDatabaseKeyDiagnostics, isDatabaseKeyFormatValid, mapAutoDetectPhase } from './utils'

export function useDatabaseKeyController({
  dbKey,
  dbReady,
  selfInfo,
  onDbKeyChange,
  onDatabaseConnectionChange,
  onSelfInfoChange,
  onContactsChange,
  onFilteredContactsChange,
  onReturnToLogin,
  onNotice
}: {
  dbKey: string
  dbReady: boolean
  selfInfo: SettingsSelfInfo | null
  onDbKeyChange: (key: string) => void
  onDatabaseConnectionChange: (connected: boolean) => void
  onSelfInfoChange: (info: SettingsSelfInfo | null) => void
  onContactsChange: (contacts: Contact[]) => void
  onFilteredContactsChange: (contacts: Contact[]) => void
  onReturnToLogin: () => void
  onNotice: (message: string) => void
}): DatabaseKeyController {
  const [state, dispatch] = useReducer(databaseKeyReducer, initialDatabaseKeyState)

  const refreshEnvironment = useCallback(async (): Promise<void> => {
    const environment = await window.api.getDatabaseKeyEnvironment()
    dispatch({ type: 'ENVIRONMENT_LOADED', environment })
  }, [])

  const refreshStorage = useCallback(async (): Promise<void> => {
    const result = await window.api.getSavedDbKey()
    dispatch({
      type: 'STORAGE_LOADED',
      saved: result.saved,
      encryptionAvailable: result.encryptionAvailable,
      error: result.success ? undefined : result.error
    })
  }, [])

  useEffect(() => {
    void Promise.all([refreshStorage(), refreshEnvironment()])
    return window.api.onDbKeyStatus(({ message }) => {
      dispatch({ type: 'AUTO_PROGRESS', phase: mapAutoDetectPhase(message) })
    })
  }, [refreshEnvironment, refreshStorage])

  const editKey = useCallback(
    (value: string): void => {
      onDbKeyChange(value)
      dispatch({ type: 'EDIT' })
    },
    [onDbKeyChange]
  )

  const pasteKey = useCallback(async (): Promise<void> => {
    const result = await window.api.readDatabaseKeyClipboard()
    if (!result.success || !result.value) {
      onNotice(result.error || '剪贴板中没有可用的数据库密钥')
      return
    }
    editKey(result.value)
    onNotice('已从剪贴板粘贴，请验证后保存')
  }, [editKey, onNotice])

  const runValidation = useCallback(
    async (key: string): Promise<boolean> => {
      dispatch({ type: 'VALIDATE_START' })
      if (!isDatabaseKeyFormatValid(key)) {
        dispatch({
          type: 'VALIDATE_ERROR',
          at: Date.now(),
          result: { success: false, code: 'INVALID_FORMAT', error: '密钥格式不正确' }
        })
        return false
      }
      const result = await window.api.testConnection(key, selfInfo?.accountRoot)
      if (
        result.success &&
        selfInfo?.wxid &&
        result.wxid &&
        result.wxid.toLowerCase() !== selfInfo.wxid.toLowerCase()
      ) {
        result.success = false
        result.code = 'ACCOUNT_MISMATCH'
        result.error = '密钥与当前账号不匹配'
      }
      dispatch({
        type: result.success ? 'VALIDATE_SUCCESS' : 'VALIDATE_ERROR',
        result,
        at: Date.now()
      })
      return result.success
    },
    [selfInfo]
  )

  const validateKey = useCallback(async (): Promise<void> => {
    await runValidation(dbKey)
  }, [dbKey, runValidation])

  const saveKey = useCallback(async (): Promise<void> => {
    if (state.status !== 'valid') return
    dispatch({ type: 'SAVE_START' })
    const saved = await window.api.saveDbKey(dbKey)
    if (!saved.success || !saved.key) {
      dispatch({
        type: 'SAVE_ERROR',
        error: saved.encryptionAvailable ? '密钥保存失败' : '系统安全存储不可用'
      })
      return
    }
    const stored = await window.api.getSavedDbKey()
    if (!stored.success || !stored.saved || !stored.key) {
      dispatch({ type: 'SAVE_ERROR', error: '无法确认密钥保存状态' })
      return
    }
    const initialized = await window.api.initDb(stored.key)
    const connected = typeof initialized === 'boolean' ? initialized : initialized.success
    onDbKeyChange(stored.key)
    onDatabaseConnectionChange(connected)
    if (connected) {
      const [self, contacts] = await Promise.all([window.api.getSelf(), window.api.getContacts()])
      onSelfInfoChange(self.ready ? self.info : null)
      onContactsChange(contacts)
      onFilteredContactsChange(contacts)
    } else {
      onSelfInfoChange(null)
      onContactsChange([])
      onFilteredContactsChange([])
    }
    dispatch({ type: 'SAVE_SUCCESS', encryptionAvailable: stored.encryptionAvailable })
    await refreshEnvironment()
    onNotice(connected ? '数据库密钥已安全保存' : '密钥已保存，但数据库重新连接失败')
  }, [
    dbKey,
    onContactsChange,
    onDatabaseConnectionChange,
    onDbKeyChange,
    onFilteredContactsChange,
    onNotice,
    onSelfInfoChange,
    refreshEnvironment,
    state.status
  ])

  const autoDetectKey = useCallback(async (): Promise<void> => {
    dispatch({ type: 'AUTO_START' })
    await refreshEnvironment()
    const result = await window.api.autoGetDbKey({ save: false })
    if (!result.success || !result.key) {
      dispatch({ type: 'AUTO_ERROR', error: result.error || '暂未找到有效密钥' })
      return
    }
    onDbKeyChange(result.key)
    dispatch({ type: 'AUTO_SUCCESS' })
    await runValidation(result.key)
  }, [onDbKeyChange, refreshEnvironment, runValidation])

  const clearSavedKey = useCallback(async (): Promise<void> => {
    dispatch({ type: 'CLEAR_START' })
    const result = await window.api.clearSavedDbKey()
    if (!result.success) {
      dispatch({ type: 'CLEAR_ERROR', error: '清除密钥失败' })
      return
    }
    await window.api.disconnectDb()
    onDbKeyChange('')
    onDatabaseConnectionChange(false)
    onSelfInfoChange(null)
    onContactsChange([])
    onFilteredContactsChange([])
    dispatch({ type: 'CLEAR_SUCCESS' })
    await refreshEnvironment()
    onNotice('数据库密钥已清除')
  }, [
    onContactsChange,
    onDatabaseConnectionChange,
    onDbKeyChange,
    onFilteredContactsChange,
    onNotice,
    onSelfInfoChange,
    refreshEnvironment
  ])

  const returnToLogin = useCallback(async (): Promise<void> => {
    // macOS WCDB 的 close 会关闭进程级原生运行时，返回登录时只退出 UI 连接态。
    // 用户再次点击连接后由 db:init 复用已验证的本机连接。
    const result = await window.api.disconnectDb({ closeNative: false })
    if (!result.success) {
      onNotice(result.error || '断开数据库连接失败')
      return
    }
    onDatabaseConnectionChange(false)
    onSelfInfoChange(null)
    onContactsChange([])
    onFilteredContactsChange([])
    onReturnToLogin()
  }, [
    onContactsChange,
    onDatabaseConnectionChange,
    onFilteredContactsChange,
    onNotice,
    onReturnToLogin,
    onSelfInfoChange
  ])

  const copyDiagnostics = useCallback(async (): Promise<void> => {
    const result = await window.api.copyText(
      buildDatabaseKeyDiagnostics(state, dbKey, selfInfo, dbReady)
    )
    onNotice(result.success ? '密钥诊断信息已复制' : result.error || '复制诊断信息失败')
  }, [dbKey, dbReady, onNotice, selfInfo, state])

  const isBusy = ['validating', 'saving', 'clearing', 'auto-detecting'].includes(state.status)
  const canSave = state.status === 'valid' && state.encryptionAvailable
  const pageStatus = useMemo<DatabaseKeyController['pageStatus']>(() => {
    if (state.status === 'validating' || state.status === 'auto-detecting') return 'validating'
    if (state.status === 'invalid') return 'invalid'
    return state.saved ? 'saved' : 'unconfigured'
  }, [state.saved, state.status])

  return {
    state,
    isBusy,
    canSave,
    pageStatus,
    editKey,
    pasteKey,
    validateKey,
    saveKey,
    autoDetectKey,
    clearSavedKey,
    returnToLogin,
    copyDiagnostics,
    refreshEnvironment
  }
}
