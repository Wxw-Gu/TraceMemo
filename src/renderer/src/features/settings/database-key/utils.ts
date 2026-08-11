import type { DatabaseKeyState } from './types'

export const normalizeDatabaseKey = (value: string): string => value.trim().replace(/^0x/i, '')

export const isDatabaseKeyFormatValid = (value: string): boolean =>
  /^[0-9a-f]{64}$/i.test(normalizeDatabaseKey(value))

export function mapAutoDetectPhase(message: string): number {
  if (/完成|成功|已获取/.test(message)) return 5
  if (/验证|校验/.test(message)) return 4
  if (/扫描|候选|获取/.test(message)) return 3
  if (/版本|组件|窗口/.test(message)) return 2
  return 1
}

export function formatValidationTime(timestamp?: number): string {
  if (!timestamp) return '尚未验证'
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false })
}

export function buildDatabaseKeyDiagnostics(
  state: DatabaseKeyState,
  input: string,
  account: { wxid?: string; accountRoot?: string } | null,
  dbReady: boolean
): string {
  const validation = state.validation
  return [
    'TraceMemo 数据库密钥诊断',
    `已保存: ${state.saved ? '是' : '否'}`,
    `已验证: ${validation?.success ? '是' : '否'}`,
    `密钥长度合法: ${isDatabaseKeyFormatValid(input) ? '是' : '否'}`,
    `当前账号 wxid: ${account?.wxid || validation?.wxid || '未识别'}`,
    `当前数据库目录: ${account?.accountRoot || validation?.accountRoot || '未识别'}`,
    `最近验证时间: ${formatValidationTime(state.lastValidatedAt)}`,
    `最近验证结果: ${validation?.success ? '成功' : state.error || '未验证'}`,
    `安全错误代码: ${state.errorCode || '无'}`,
    `数据库连接: ${dbReady ? '已连接' : '未连接'}`,
    `当前平台: ${state.environment?.platform || '未知'}`,
    `自动获取支持: ${state.environment?.autoDetectSupported ? '是' : '否'}`,
    `系统安全存储: ${state.encryptionAvailable ? '可用' : '不可用'}`
  ].join('\n')
}
