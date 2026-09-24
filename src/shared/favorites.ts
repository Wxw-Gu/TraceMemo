import type { ParsedContent } from './types'

/**
 * 收藏类型（`MM_FAV_ITEM_TYPE_*` / `MM_FAV_DATA_TYPE_*`）只读映射。
 * 名称来自 wechat.dylib 导出名；数字为枚举顺序推断，未知值原样回退。
 */

const FAV_TYPE_TEXT: Record<string, string> = {
  all: '全部',
  none: '未知收藏',
  txt: '文字',
  '1': '文字',
  img: '图片',
  '2': '图片',
  voice: '语音',
  chatvoice: '语音',
  '3': '语音',
  video: '视频',
  '4': '视频',
  webpage: '网页',
  '5': '网页',
  loc: '位置',
  location: '位置',
  '6': '位置',
  music: '音乐',
  '7': '音乐',
  file: '文件',
  '8': '文件',
  book: '书籍',
  '9': '书籍',
  goods: '商品',
  general_product: '商品',
  '10': '商品',
  card: '卡券',
  sharecard: '名片',
  record: '聊天记录',
  embeded_record: '聊天记录',
  tv: '视频',
  sight: '视频',
  music_mv: '音乐视频',
  note: '笔记',
  weapp: '小程序',
  liteapp: '小程序',
  finder: '视频号',
  finder_feed: '视频号',
  finder_live: '视频号直播',
  finder_video: '视频号',
  finder_name_card: '视频号名片',
  finder_shop_window_shared: '商品橱窗',
  ting: '听一听',
  ting_list: '听一听',
  collection: '合集',
  openimkf_sharecard: '客服名片'
}

/** `MM_FAV_*` → 展示文案（未知原样返回）。 */
export function describeFavoriteType(raw?: string | number): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  const key = String(raw).trim().toLowerCase()
  if (!key) return undefined
  return FAV_TYPE_TEXT[key] || String(raw).trim()
}

/** 收藏记录（只读展示字段；与 favorite.db 列名对齐时可再扩）。 */
export type FavoriteRecord = {
  favId?: string | number
  /** `MM_FAV_ITEM_TYPE_*` 或 `MM_FAV_DATA_TYPE_*`。 */
  type?: string | number
  dataType?: string | number
  title?: string
  description?: string
  url?: string
  appName?: string
  poiname?: string
  label?: string
  lat?: number
  lng?: number
  md5?: string
  datName?: string
  duration?: number
  width?: number
  height?: number
  raw?: string
}

/**
 * 把收藏记录收成现有 `ParsedContent` 形态，复用聊天卡片/导出。
 * 不做支付、不生成可点开资金动作。
 */
export function favoriteRecordToContent(record: FavoriteRecord): ParsedContent {
  const rawType = record.dataType ?? record.type
  const key = String(rawType ?? '').trim().toLowerCase()
  const label = describeFavoriteType(rawType) || '收藏'
  const title = record.title || label
  const description = record.description

  if (key === 'txt' || key === 'text' || key === '1') {
    return { type: 'text', content: description || record.raw || title }
  }
  if (key === 'img' || key === 'image' || key === '2') {
    return {
      type: 'image',
      md5: record.md5,
      datName: record.datName
    }
  }
  if (key === 'voice' || key === 'chatvoice' || key === '3') {
    return { type: 'voice', duration: record.duration }
  }
  if (
    key === 'video' ||
    key === 'sight' ||
    key === 'tv' ||
    key === 'music_mv' ||
    key === '4'
  ) {
    return {
      type: 'video',
      md5: record.md5,
      duration: record.duration,
      width: record.width,
      height: record.height
    }
  }
  if (key === 'loc' || key === 'location' || key === '6') {
    return {
      type: 'location',
      poiname: record.poiname || title,
      label: record.label || description,
      lat: record.lat ?? 0,
      lng: record.lng ?? 0
    }
  }
  if (key === 'weapp' || key === 'liteapp') {
    return {
      type: 'miniProgram',
      title,
      description,
      appName: record.appName || '小程序'
    }
  }
  if (key === 'record' || key === 'embeded_record') {
    return {
      type: 'forwardBundle',
      title: title || '聊天记录',
      description,
      items: []
    }
  }
  if (key === 'none' || key === '' || key === 'all') {
    return {
      type: 'system',
      content: `收藏 · ${label}`,
      raw: record.raw
    }
  }

  // 网页 / 音乐 / 文件 / 商品 / 视频号 / 笔记 / 名片 / 合集 → 只读 share
  return {
    type: 'share',
    title,
    des: description,
    url: record.url || '',
    appname: record.appName || label,
    typeVal: key || 'favorite'
  }
}
