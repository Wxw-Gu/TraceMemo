import { useCallback, useEffect, useMemo, useReducer } from 'react'
import type { SettingsSelfInfo } from '../model/types'
import { imageDecryptionReducer, initialImageDecryptionState } from './imageDecryptionReducer'
import type { ImageDecryptionController } from './types'
import { normalizeAutoXorKey, sanitizeImageError } from './utils'

export function useImageDecryptionController({
  selfInfo,
  onNotice
}: {
  selfInfo: SettingsSelfInfo | null
  onNotice: (message: string) => void
}): ImageDecryptionController {
  const [state, dispatch] = useReducer(imageDecryptionReducer, initialImageDecryptionState)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [config, status, contacts] = await Promise.all([
        window.api.getImageKeyConfig(),
        window.api.getImageDecryptionStatus(),
        window.api.getContacts()
      ])
      dispatch({ type: 'LOADED', config, status, contacts })
    } catch {
      dispatch({ type: 'LOAD_ERROR', error: '无法读取图片解密状态' })
    }
  }, [])

  useEffect(() => {
    void refresh()
    return window.api.onImageKeyStatus(({ message }) => {
      dispatch({ type: 'AUTO_PROGRESS', message })
    })
  }, [refresh])

  const edit = useCallback((field: 'xorKey' | 'aesKey', value: string): void => {
    dispatch({ type: 'EDIT', field, value })
  }, [])

  const selectChat = useCallback((userMd5: string): void => {
    dispatch({ type: 'SELECT_CHAT', userMd5 })
  }, [])

  const test = useCallback(async (): Promise<void> => {
    dispatch({ type: 'TEST_START' })
    const result = await window.api.testImageDecryption({
      userMd5: state.selectedUserMd5,
      resourceRoot: state.resourceRoot,
      xorKey: state.xorKey,
      aesKey: state.aesKey
    })
    dispatch({
      type: 'TEST_DONE',
      result: result.success ? result : { ...result, error: sanitizeImageError(result.error) }
    })
  }, [state.aesKey, state.resourceRoot, state.selectedUserMd5, state.xorKey])

  const save = useCallback(async (): Promise<void> => {
    if (!state.testResult?.success && state.autoPhase !== 'success') return
    if (state.autoPhase === 'success') dispatch({ type: 'AUTO_SAVE_START' })
    const result = await window.api.saveImageKeyConfig({
      resourceRoot: state.resourceRoot,
      xorKey: state.xorKey,
      aesKey: state.aesKey
    })
    if (!result.success) {
      dispatch({ type: 'OPERATION_ERROR', error: sanitizeImageError(result.error) })
      return
    }
    await refresh()
    if (state.autoPhase === 'success') dispatch({ type: 'AUTO_SAVED' })
    onNotice('图片解密配置已安全保存')
  }, [
    onNotice,
    refresh,
    state.aesKey,
    state.autoPhase,
    state.resourceRoot,
    state.testResult,
    state.xorKey
  ])

  const autoDetect = useCallback(async (): Promise<void> => {
    dispatch({ type: 'AUTO_START' })
    const result = await window.api.autoGetImageKey({ save: false })
    if (!result.success || !result.aesKey || !result.verified) {
      // 自动获取链路：原文透传后端错误信息，不要走 sanitizeImageError。
      // sanitizeImageError 是给"测试图片解析"设计的字典，会把
      // "未找到 V2 模板文件 / 微信进程未运行 / 60 秒未扫描到密钥" 等
      // 完全合法的扫描阶段错误强制翻成"无法解析媒体文件"。
      const rawError = (result.error || '').toString().trim()
      const errorMessage = !result.success
        ? rawError || '自动获取图片密钥失败'
        : !result.aesKey
          ? '自动获取未返回 AES 密钥'
          : '获取到候选密钥，但未通过图片验证'
      dispatch({ type: 'AUTO_ERROR', error: errorMessage })
      return
    }
    dispatch({
      type: 'AUTO_CANDIDATE',
      resourceRoot: state.resourceRoot || selfInfo?.accountRoot || '',
      xorKey: normalizeAutoXorKey(result.xorKey, result.imageXorKey),
      aesKey: result.aesKey,
      account: selfInfo?.nickname || selfInfo?.wxid || '当前微信账号'
    })
    dispatch({ type: 'AUTO_VALIDATING' })
    // Windows 内存扫描只会返回通过模板图片头验证的候选密钥。
    dispatch({ type: 'AUTO_DONE' })
    onNotice('已获取有效图片密钥，请确认保存')
  }, [onNotice, selfInfo?.accountRoot, selfInfo?.nickname, selfInfo?.wxid, state.resourceRoot])

  const clear = useCallback(async (): Promise<void> => {
    dispatch({ type: 'CLEAR_START' })
    const result = await window.api.clearImageKeyConfig()
    if (!result.success) {
      dispatch({ type: 'OPERATION_ERROR', error: '图片解密配置清除失败' })
      return
    }
    const [config, status] = await Promise.all([
      window.api.getImageKeyConfig(),
      window.api.getImageDecryptionStatus()
    ])
    dispatch({ type: 'CLEAR_DONE', config, status })
    onNotice('图片密钥已清除，微信原始数据未受影响')
  }, [onNotice])

  const busy = ['checking', 'testing', 'clearing'].includes(state.phase)
  const canSave = Boolean(
    ((state.testResult?.success && state.dirty) || state.autoPhase === 'success') &&
    state.status?.encryptionAvailable
  )
  const pageStatus = useMemo<ImageDecryptionController['pageStatus']>(() => {
    if (!state.config?.configured) return 'unconfigured'
    if (!state.config.saved || !state.status?.encryptionAvailable) return 'partial'
    if (state.status.resources.imageDirectory.state === 'unavailable') return 'partial'
    return 'configured'
  }, [state.config, state.status])

  return {
    state,
    pageStatus,
    busy,
    canSave,
    edit,
    selectChat,
    test,
    save,
    autoDetect,
    clear,
    refresh
  }
}
