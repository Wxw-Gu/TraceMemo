import fs from 'fs'

/**
 * 区分「路径不存在」与「路径存在、但当前进程读不了」。
 *
 * 为什么需要它：`fs.existsSync()` 对**任何**错误都返回 `false` —— 包括 `EPERM`
 * 与 `EACCES`。于是"权限被拒绝"会被静默降级成"文件不存在"，调用方再据此报出
 * 「文件缺失」，把用户指向路径排查和重装。
 *
 * macOS 上最容易踩到的是**完全磁盘访问权限**未授予：微信数据在另一个 App 的容器里，
 * TCC 会以 `EPERM`（而不是 ENOENT）拒绝访问。此时数据目录其实是完整的。
 *
 * 只用 `statSync` 探**一次**，因为只有它会把 errno 如实抛出来。三种结果：
 *   - 能 stat          → `ok`
 *   - ENOENT / ENOTDIR → `missing`
 *   - EPERM / EACCES   → `denied`
 *
 * 不做递归遍历、不做缓存：调用点通常已经失败在即，这里不再额外制造 IO。
 */
export type PathAccess = 'ok' | 'missing' | 'denied'

/** 权限类 errno。TCC 拒绝一般给 `EPERM`；传统文件权限位不足给 `EACCES`。 */
const PERMISSION_ERRNOS = new Set(['EPERM', 'EACCES'])

/**
 * 「路径拿不到，原因是没有权限」——带 `code` 的显式错误类型。
 *
 * 存在的意义是**不要靠 message 文本传递原因**：上层据此调用 `isPermissionDeniedError()`
 * 就能判定，不需要去匹配「无权读取」这类措辞（措辞会随文案调整而漂移）。
 */
export class PathAccessDeniedError extends Error {
  /** 与 Node 的 fs errno 对齐，让通用的 errno 判定路径直接适用。 */
  readonly code = 'EPERM'
  readonly target: string

  constructor(target: string) {
    super(`无权读取微信数据目录: ${target}`)
    this.name = 'PathAccessDeniedError'
    this.target = target
  }
}

export function probePathAccess(target: string): PathAccess {
  try {
    fs.statSync(target)
    return 'ok'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (typeof code === 'string' && PERMISSION_ERRNOS.has(code)) return 'denied'
    return 'missing'
  }
}

/**
 * 从任意抛出物里取 errno —— 有些包装层只保留 `code`，有些只保留 message。
 *
 * 返回 null 表示拿不到 errno（调用方应退回文本匹配，而不是直接当成"不存在"）。
 */
export function readErrnoCode(error: unknown): string | null {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' && code ? code : null
}

/** 该抛出物是否是权限类错误（按 errno 判断，不做文本猜测）。 */
export function isPermissionDeniedError(error: unknown): boolean {
  const code = readErrnoCode(error)
  return code !== null && PERMISSION_ERRNOS.has(code)
}

/**
 * 目标路径**自身**读不了时，是否属于"权限不足"。
 *
 * 与 `probePathAccess` 的区别：这个只在调用方**已经**判定"拿不到"之后追问原因，
 * 用于把「文件缺失」纠正成「权限不足」。返回 `false` 表示要么能读、要么是真的不存在
 * —— 两种情况都不该被改判。
 */
export function looksLikePermissionDenied(target: string): boolean {
  return probePathAccess(target) === 'denied'
}

/**
 * 错误文本里的权限特征（小写匹配）。
 *
 * 只在拿不到 errno 时兜底 —— 底层把错误包成字符串（例如 native / helper 的 stderr）
 * 时这是唯一的线索。刻意逐个列举显式模式，不用 `includes('permission')`
 * 这类过宽判断：那会把 "permission config not found" 之类误判成权限问题。
 */
export const PERMISSION_DENIED_TEXT_PATTERNS: readonly RegExp[] = [
  /\beperm\b/,
  /\beacces\b/,
  /operation not permitted/,
  /permission denied/,
  /access denied/,
  /权限不足/
]

/** 文本里是否出现权限特征（调用方应确保传入的是已小写的字符串）。 */
export function hasPermissionDeniedText(lowercasedDetail: string): boolean {
  return PERMISSION_DENIED_TEXT_PATTERNS.some((pattern) => pattern.test(lowercasedDetail))
}
