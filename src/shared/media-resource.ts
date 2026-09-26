/**
 * `message_resource.db` 媒体资源类型解码（只读）。
 * 真机直方图（2026-09-26）：
 * - `MessageResourceInfo.message_local_type` = (appmsg_type << 32) | local_type
 *   例：`0x1300000031` → local 49 (appmsg) + appmsg type 19；`3`/`43` 为纯 local_type
 * - `MessageResourceDetail.type` = (kind << 16) | sub
 *   例：`0x40001` kind=4 sub=1；`0x10002` kind=1 sub=2
 * - `status`：0/1（1 多见于 size>0 的已落地资源）
 */

export type PackedMessageType = {
  /** 低 32 位：消息 local_type。 */
  localType: number
  /** 高 32 位：appmsg type（非 49 时通常为 0）。 */
  appMsgType: number
  packed: string
}

export function decodePackedMessageType(raw: string | number): PackedMessageType {
  const value = typeof raw === 'number' ? raw : Number(String(raw).trim())
  const packed = Number.isFinite(value) ? BigInt(Math.trunc(value)) : 0n
  return {
    localType: Number(packed & 0xffffffffn),
    appMsgType: Number((packed >> 32n) & 0xffffffffn),
    packed: packed.toString()
  }
}

export type ResourceType = {
  /** type 高 16 位。 */
  kind: number
  /** type 低 16 位。 */
  sub: number
  raw: number
  label: string
}

export function decodeResourceType(raw: string | number): ResourceType {
  const value = typeof raw === 'number' ? raw : Number(String(raw).trim())
  const num = Number.isFinite(value) ? Math.trunc(value) : 0
  const kind = (num >> 16) & 0xffff
  const sub = num & 0xffff
  return {
    kind,
    sub,
    raw: num,
    label: describeResourceKind(kind, sub)
  }
}

/** kind/sub → 展示文案（未知用 kind/sub）。 */
export function describeResourceKind(kind: number, sub: number): string {
  // 真机常见 kind（按 size 量级粗分）：1 缩略/小图，2 中图/头像类，4 小附件，
  // 3/0x30+/0x33… 为大文件/视频等；sub 多为变体序号。
  const kindLabel: Record<string, string> = {
    '1': '图片/缩略',
    '2': '中图',
    '3': '大文件',
    '4': '小附件'
  }
  const base = kindLabel[String(kind)] || `资源${kind}`
  return sub ? `${base}-${sub}` : base
}

export function describeResourceStatus(status?: number): string {
  if (status === 1) return '已落地'
  if (status === 0) return '未落地'
  return status === undefined ? '未知' : String(status)
}

/** 媒体资源行摘要（导出侧只读）。 */
export function mediaResourceSummary(row: {
  type?: string | number
  size?: string | number
  status?: string | number
  data_index?: string
  create_time?: string | number
}): string {
  const rt = decodeResourceType(row.type ?? 0)
  const size = Number(row.size) || 0
  const status = describeResourceStatus(Number(row.status))
  return `${rt.label} · ${status} · ${size}B`
}
