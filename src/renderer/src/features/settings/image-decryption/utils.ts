export function formatImageConfigTime(value?: number): string {
  if (!value) return '尚未验证'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(value)
}

export function sanitizeImageError(error?: string): string {
  const value = String(error || '').toLowerCase()
  if (value.includes('no_image_message') || value.includes('300')) {
    return '当前会话最近 300 条消息内没有图片，请换一个含图片的聊天再测试'
  }
  if (value.includes('unsupported') || value.includes('dat version')) {
    return '仅支持 WeChat 4.0 图片协议，V3 及以下无法解析'
  }
  if (
    value.includes('wxgf') ||
    value.includes('ffmpeg') ||
    value.includes('hevc') ||
    value.includes('不完整') ||
    value.includes('格式异常') ||
    value.includes('无法识别')
  ) {
    return error || '无法解析媒体文件'
  }
  if (value.includes('key') || value.includes('密钥')) return '图片密钥未配置或与当前账号不匹配'
  if (value.includes('不存在') || value.includes('not found')) return '图片文件不存在'
  if (value.includes('账号')) return '当前账号不匹配'
  if (value.includes('目录')) return '图片资源目录不可用'
  return error ? '无法解析媒体文件（仅支持 WeChat 4.0）' : '图片解析测试未通过'
}

export function normalizeAutoXorKey(value?: number, formatted?: string): string {
  if (formatted) return formatted
  return `0x${Number(value ?? 0x40)
    .toString(16)
    .toUpperCase()
    .padStart(2, '0')}`
}
