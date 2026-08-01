import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SettingsSelfInfo } from '../model/types'
import {
  buildConnectionDiagnostics,
  formatConnectionCheckedAt,
  getConnectionOverviewStatus,
  isSameAccount,
  sanitizeConnectionError
} from './diagnostics'
import type { ConnectionCheckState } from './types'

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function useAccountDatabaseController({
  dbKey,
  dbReady,
  dbConnecting = false,
  selfInfo,
  onNotice
}: {
  dbKey: string
  dbReady: boolean
  dbConnecting?: boolean
  selfInfo: SettingsSelfInfo | null
  onNotice: (message: string) => void
}) {
  const [hasImageKey, setHasImageKey] = useState(false)
  const [checkState, setCheckState] = useState<ConnectionCheckState>({ status: 'idle' })
  const [clock, setClock] = useState(() => new Date())

  useEffect(() => {
    let active = true
    void window.api
      .getImageKeyConfig()
      .then((result) => {
        if (active) setHasImageKey(result.configured)
      })
      .catch(() => {
        if (active) setHasImageKey(false)
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (!checkState.checkedAt) return
    const timer = window.setInterval(() => setClock(new Date()), 30_000)
    return () => window.clearInterval(timer)
  }, [checkState.checkedAt])

  const diagnostics = useMemo(
    () =>
      buildConnectionDiagnostics({
        dbReady,
        selfInfo,
        hasDbKey: Boolean(dbKey.trim()),
        hasImageKey,
        checkState
      }),
    [checkState, dbKey, dbReady, hasImageKey, selfInfo]
  )
  const connectionStatus = useMemo(
    () =>
      dbConnecting
        ? ('checking' as const)
        : getConnectionOverviewStatus({ dbReady, checkState, diagnostics }),
    [checkState, dbConnecting, dbReady, diagnostics]
  )
  const lastCheckedLabel = formatConnectionCheckedAt(checkState, clock)

  const testConnection = useCallback(async (): Promise<void> => {
    if (checkState.status === 'checking') return
    setCheckState({ status: 'checking', checkedAt: checkState.checkedAt })
    const checkedAt = new Date()
    setClock(checkedAt)
    try {
      const result = await window.api.testConnection(dbKey, selfInfo?.accountRoot)
      if (!result.success) {
        setCheckState({
          status: 'error',
          checkedAt,
          message: sanitizeConnectionError(result.error)
        })
        onNotice('连接检测失败，请查看诊断结果')
        return
      }

      const identityMatched = isSameAccount({
        currentWxid: selfInfo?.wxid,
        probeWxid: result.wxid,
        currentRoot: selfInfo?.accountRoot,
        probeRoot: result.accountRoot
      })
      if (identityMatched === false) {
        setCheckState({
          status: 'warning',
          checkedAt,
          message: '当前连接账号与页面账号不一致',
          identityMatched
        })
        onNotice('连接检测失败，请查看诊断结果')
        return
      }

      setCheckState({ status: 'success', checkedAt, identityMatched })
      onNotice(hasImageKey ? '连接检测完成' : '连接可用，但部分能力需要配置')
    } catch {
      setCheckState({ status: 'error', checkedAt, message: '数据库连接检查未通过' })
      onNotice('连接检测失败，请查看诊断结果')
    }
  }, [checkState, dbKey, hasImageKey, onNotice, selfInfo])

  const openAccountDirectory = useCallback(async (): Promise<void> => {
    const result = await window.api.openAccountRoot()
    if (!result.success) onNotice('无法打开账号目录')
  }, [onNotice])

  const copyAccountDirectory = useCallback(async (): Promise<void> => {
    const accountRoot = selfInfo?.accountRoot
    if (!accountRoot) return onNotice('账号目录不可用')
    const result = await window.api.copyText(accountRoot)
    onNotice(result.success ? '账号目录已复制' : '复制账号目录失败')
  }, [onNotice, selfInfo?.accountRoot])

  return {
    diagnostics,
    connectionStatus,
    checkState,
    isChecking: dbConnecting || checkState.status === 'checking',
    lastCheckedLabel,
    testConnection,
    openAccountDirectory,
    copyAccountDirectory
  }
}
