/**
 * 表情包目录（`emoticon.db`）只读解析。
 * 非商店：`kNonStoreEmoticonTable`；商店：`kStoreEmoticonPackageTable` + files/captions。
 * 不下载、不改收藏顺序。
 */

export type EmoticonItem = {
  md5?: string
  type?: number
  caption?: string
  productId?: string
  thumbUrl?: string
  cdnUrl?: string
  encryptUrl?: string
  /** 商店包名（若来自 package）。 */
  packageName?: string
}

export type EmoticonPackage = {
  packageId?: string
  packageName?: string
  paymentStatus?: number
  downloadStatus?: number
  intro?: string
}

function pick(row: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

export function parseNonStoreEmoticonRow(row: Record<string, unknown>): EmoticonItem {
  return {
    md5: pick(row, ['md5', 'md5_']),
    type: Number(row.type) || undefined,
    caption: pick(row, ['caption', 'caption_']),
    productId: pick(row, ['product_id', 'package_id_']),
    thumbUrl: pick(row, ['thumb_url', 'tp_url']),
    cdnUrl: pick(row, ['cdn_url']),
    encryptUrl: pick(row, ['encrypt_url'])
  }
}

export function parseEmoticonPackageRow(row: Record<string, unknown>): EmoticonPackage {
  return {
    packageId: pick(row, ['package_id_', 'package_id']),
    packageName: pick(row, ['package_name_', 'package_name']),
    paymentStatus: Number(row.payment_status_) || 0,
    downloadStatus: Number(row.download_status_) || 0,
    intro: pick(row, ['introduction_', 'introduction'])
  }
}

/** 表情条目 → 可读 sticker 卡片（导出/搜索）。 */
export function emoticonItemToContent(item: EmoticonItem): {
  type: 'sticker'
  md5?: string
  url?: string
  thumbUrl?: string
  encryptUrl?: string
} {
  return {
    type: 'sticker',
    md5: item.md5,
    url: item.cdnUrl || item.thumbUrl,
    thumbUrl: item.thumbUrl,
    encryptUrl: item.encryptUrl
  }
}

export function emoticonDisplayText(item: EmoticonItem): string {
  return item.caption || item.packageName || item.productId || '表情'
}
