export function isWcdbDebugEnabled(): boolean {
  return process.env.WCDB_DEBUG_LOGS === '1'
}

export function wcdbDebugLog(message: string): void {
  if (isWcdbDebugEnabled()) console.log(message)
}
