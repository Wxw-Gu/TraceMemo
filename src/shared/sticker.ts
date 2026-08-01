export type StickerFailureCode =
  | 'link_expired'
  | 'authentication_required'
  | 'access_denied'
  | 'resource_removed'
  | 'rate_limited'
  | 'http_error'

export interface StickerHttpFailure {
  code: StickerFailureCode
  message: string
}

export function classifyStickerHttpFailure(
  statusCode: number,
  url: string,
  now = Date.now()
): StickerHttpFailure {
  if (statusCode === 401) {
    return { code: 'authentication_required', message: '表情链接需要微信授权' }
  }
  if (statusCode === 403) {
    const expiresAt = readExpiryTimestamp(url)
    if (expiresAt !== undefined && expiresAt <= now) {
      return { code: 'link_expired', message: '表情链接已过期' }
    }
    return { code: 'access_denied', message: '表情链接已失效或需要微信授权' }
  }
  if (statusCode === 404 || statusCode === 410) {
    return { code: 'resource_removed', message: '表情资源已删除或失效' }
  }
  if (statusCode === 429) {
    return { code: 'rate_limited', message: '表情下载请求过于频繁' }
  }
  return { code: 'http_error', message: `表情包下载失败: HTTP ${statusCode}` }
}

function readExpiryTimestamp(value: string): number | undefined {
  try {
    const url = new URL(value)
    for (const key of ['expire', 'expires', 'expiry', 'deadline']) {
      const raw = url.searchParams.get(key)
      if (!raw) continue
      const numeric = Number(raw)
      if (Number.isFinite(numeric) && numeric > 0) {
        return numeric > 10_000_000_000 ? numeric : numeric * 1000
      }
      const parsed = Date.parse(raw)
      if (Number.isFinite(parsed)) return parsed
    }
  } catch {
    // Invalid URLs have no trustworthy expiry metadata.
  }
  return undefined
}
