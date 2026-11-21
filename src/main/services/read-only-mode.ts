/**
 * 只读验收模式。
 *
 * 用于「接真实微信库、但不允许任何写副作用」的验收场景。启用后：
 * - 不执行 MsgInsert reconciliation / 规则写入；
 * - 不发送任何微信消息（网关直接 blocked）；
 * - 不执行自动化与定时日报的发送步骤；
 * - 不写退群本地提示。
 *
 * 读取、SSE 订阅、数据库回补不受影响。
 *
 * 生产模式默认关闭：只有显式设置 `TRACEMEMO_READ_ONLY=1` 才生效。
 */
export const READ_ONLY_ENV = 'TRACEMEMO_READ_ONLY'

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on'])

export function isReadOnlyMode(): boolean {
  const value = process.env[READ_ONLY_ENV]
  return typeof value === 'string' && TRUE_VALUES.has(value.trim().toLowerCase())
}

/** 统一日志：只记录被跳过的操作名，不记录会话 / 消息内容。 */
export function logReadOnlySkip(operation: string): void {
  console.log(`[ReadOnly] 已跳过 ${operation}`)
}
