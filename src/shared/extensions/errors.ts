/**
 * 扩展系统的稳定错误码。
 *
 * 调用方（UI / 扩展 SDK / 自动化 runner）只依赖这里的 `code`，
 * 不解析 `message` —— 文案会改，错误码不会。
 */

export const EXTENSION_ERROR_CODES = [
  'EXTENSION_NOT_FOUND',
  'EXTENSION_DISABLED',
  'EXTENSION_INCOMPATIBLE',
  'EXTENSION_ALREADY_INSTALLED',
  'EXTENSION_INSTALL_FAILED',
  'EXTENSION_INVALID_MANIFEST',
  'EXTENSION_INVALID_PATH',
  'EXTENSION_HOST_UNAVAILABLE',
  'PERMISSION_DENIED',
  'CAPABILITY_UNAVAILABLE',
  'LICENSE_REQUIRED',
  'DATABASE_NOT_READY',
  'SEND_NOT_SUPPORTED',
  'ACTION_TIMEOUT',
  'ACTION_FAILED',
  'RATE_LIMITED',
  'INVALID_REQUEST',
  'STORAGE_LIMIT_EXCEEDED'
] as const

export type ExtensionErrorCode = (typeof EXTENSION_ERROR_CODES)[number]

export const EXTENSION_ERROR_MESSAGES: Record<ExtensionErrorCode, string> = {
  EXTENSION_NOT_FOUND: '找不到该扩展',
  EXTENSION_DISABLED: '扩展当前未启用',
  EXTENSION_INCOMPATIBLE: '扩展与当前 TraceMemo 版本不兼容',
  EXTENSION_ALREADY_INSTALLED: '已安装同名扩展',
  EXTENSION_INSTALL_FAILED: '扩展安装失败',
  EXTENSION_INVALID_MANIFEST: '扩展 manifest 不合法',
  EXTENSION_INVALID_PATH: '扩展资源路径不合法',
  EXTENSION_HOST_UNAVAILABLE: '扩展后台进程不可用',
  PERMISSION_DENIED: '扩展没有该权限',
  CAPABILITY_UNAVAILABLE: '当前环境不具备该能力',
  LICENSE_REQUIRED: '需要有效授权',
  DATABASE_NOT_READY: '微信数据库尚未连接',
  SEND_NOT_SUPPORTED: '当前发送能力不支持该消息类型',
  ACTION_TIMEOUT: '扩展处理超时',
  ACTION_FAILED: '扩展执行失败',
  RATE_LIMITED: '触发频率限制，请稍后再试',
  INVALID_REQUEST: '请求格式不合法',
  STORAGE_LIMIT_EXCEEDED: '扩展存储已超出上限'
}

export interface ExtensionErrorPayload {
  code: ExtensionErrorCode
  message: string
  /** 可选的机器可读细节；**不允许**放聊天正文、文件路径、wxid。 */
  detail?: string
}

export class ExtensionError extends Error {
  readonly code: ExtensionErrorCode

  constructor(code: ExtensionErrorCode, message?: string, options?: { cause?: unknown }) {
    super(message || EXTENSION_ERROR_MESSAGES[code], options)
    this.name = 'ExtensionError'
    this.code = code
  }
}

export function extensionError(code: ExtensionErrorCode, message?: string): ExtensionError {
  return new ExtensionError(code, message)
}

export function isExtensionErrorCode(value: unknown): value is ExtensionErrorCode {
  return typeof value === 'string' && (EXTENSION_ERROR_CODES as readonly string[]).includes(value)
}

/** 任意异常 → 可跨进程传输的错误载荷。未知异常一律落到 `ACTION_FAILED`。 */
export function toExtensionErrorPayload(error: unknown): ExtensionErrorPayload {
  if (error instanceof ExtensionError) {
    return { code: error.code, message: error.message }
  }
  if (error && typeof error === 'object') {
    const candidate = error as { code?: unknown; message?: unknown }
    if (isExtensionErrorCode(candidate.code)) {
      return {
        code: candidate.code,
        message:
          typeof candidate.message === 'string'
            ? candidate.message
            : EXTENSION_ERROR_MESSAGES[candidate.code]
      }
    }
    if (typeof candidate.message === 'string' && candidate.message.trim()) {
      return { code: 'ACTION_FAILED', message: candidate.message.trim() }
    }
  }
  return { code: 'ACTION_FAILED', message: EXTENSION_ERROR_MESSAGES.ACTION_FAILED }
}
