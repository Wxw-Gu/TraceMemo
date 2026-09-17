import { createHash } from 'node:crypto'

/**
 * 统一日志脱敏。
 *
 * 微信连接器与发送日志共用同一套规则：任何 secret 都不能以原值进入普通日志，
 * 包括 bot_token、context_token、typing_ticket、AES key、二维码凭据与 Authorization 头。
 *
 * 只用于自由文本日志；结构化字段（如 sha256 摘要）不要经过这里，否则会被误伤。
 */

const REDACTION_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // Authorization 头
  [/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [已隐藏]'],
  // 二维码图片内容（base64 data URL 可能长达数百 KB）
  [/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/gi, 'data:image/[二维码已隐藏]'],
  // JSON / query 形态的 secret 字段
  [
    /("?(?:bot_token|context_token|typing_ticket|aeskey|aes_key|access_token|refresh_token|authorization)"?\s*[:=]\s*)"?[^\s",}&]+"?/gi,
    '$1"[已隐藏]"'
  ],
  // 兼容历史写法：token=xxx / token: xxx
  [/(\btoken\s*[:=]\s*)[^\s,}]+/gi, '$1[已隐藏]'],
  // iLink 上传参数
  [/(encrypted_query_param=)[^\s&"]+/gi, '$1[已隐藏]']
]

/** 对任意自由文本日志做脱敏。 */
export function redactSecrets(message: string): string {
  let result = String(message ?? '')
  for (const [pattern, replacement] of REDACTION_RULES) {
    result = result.replace(pattern, replacement)
  }
  return result
}

/** 日志中只允许出现 secret 是否存在，不允许出现原值。 */
export function describeSecretPresence(value: string | undefined | null): string {
  return value ? 'present' : 'absent'
}

/**
 * 生成不可逆的短指纹，用于需要关联同一 secret 又不能落盘的诊断场景。
 * 只保留 sha256 前 8 位十六进制，无法反推原值。
 */
export function secretFingerprint(value: string | undefined | null): string {
  if (!value) return 'absent'
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 8)
}
