/**
 * 转账 / 红包状态文案（只读展示）。
 * 文案对齐微信 UI 簇（待收款/已收款/…、待领取/已领取/…）。
 * 数字枚举为推断对齐；未知值原样回退。
 */

const TRANSFER_STATUS_TEXT: Record<string, string> = {
  '0': '待收款',
  '1': '已收款，待入账',
  '2': '已收款',
  '3': '已退还',
  '4': '过期未收款，已退还',
  '5': '你已退还',
  '6': '已过期',
  '7': '此笔转账已被撤回',
  paid: '已收款',
  received: '已收款',
  pending: '待收款',
  unreceived: '待收款',
  refunded: '已退还',
  expired: '过期未收款，已退还',
  withdrawn: '此笔转账已被撤回',
  revoked: '此笔转账已被撤回',
  confirmed: '朋友已确认收款',
  accepted: '已被接收',
  accepting: '已被接收'
}

const RED_PACKET_STATUS_TEXT: Record<string, string> = {
  '0': '待领取',
  '1': '已领取',
  '2': '已被领完',
  '3': '已过期',
  '4': '已被领取',
  received: '已领取',
  claimed: '已领取',
  expired: '已过期',
  exhausted: '已被领完',
  pending: '待领取',
  unclaimed: '待领取'
}

const TRANSFER_STATUS_KEYWORDS: Array<[RegExp, string]> = [
  [/撤回|withdraw|revoke/i, '此笔转账已被撤回'],
  [/过期未收款|expired/i, '过期未收款，已退还'],
  [/已退还|退还|refund/i, '已退还'],
  [/待入账|pending.?credit/i, '已收款，待入账'],
  [/已收款|已收|paid|received/i, '已收款'],
  [/已被接收|accepted|accepting/i, '已被接收'],
  [/确认收款|confirmed/i, '朋友已确认收款'],
  [/待收款|请收款|pending|unreceived/i, '待收款'],
  [/已过期|expired/i, '已过期']
]

const RED_PACKET_STATUS_KEYWORDS: Array<[RegExp, string]> = [
  [/领完|exhausted/i, '已被领完'],
  [/已被领取|已领取|received|claimed/i, '已领取'],
  [/过期|expired/i, '已过期'],
  [/待领取|未领取|pending|unclaimed/i, '待领取']
]

function describeByMap(
  raw: string | number | undefined,
  table: Record<string, string>,
  keywords: Array<[RegExp, string]>
): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  const text = String(raw).trim()
  if (!text) return undefined
  const direct = table[text.toLowerCase()] || table[text]
  if (direct) return direct
  for (const [re, label] of keywords) {
    if (re.test(text)) return label
  }
  return text
}

/** `transfer_status` → 展示文案（未知原样返回）。 */
export function describeTransferStatus(raw?: string | number): string | undefined {
  return describeByMap(raw, TRANSFER_STATUS_TEXT, TRANSFER_STATUS_KEYWORDS)
}

/** 红包 `hb_status` / `receive_status` → 展示文案。 */
export function describeRedPacketStatus(
  hbStatus?: string | number,
  receiveStatus?: string | number
): string | undefined {
  return (
    describeByMap(hbStatus, RED_PACKET_STATUS_TEXT, RED_PACKET_STATUS_KEYWORDS) ||
    describeByMap(receiveStatus, RED_PACKET_STATUS_TEXT, RED_PACKET_STATUS_KEYWORDS)
  )
}

/** `paysubtype` 仅作辅助标签（真机见过 1/3/4；语义未在 dylib 钉死）。 */
export function describePaySubtype(raw?: string | number): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  const text = String(raw).trim()
  const table: Record<string, string> = {
    '1': '转账',
    '3': '收款',
    '4': '转账'
  }
  return table[text] || text
}

export const TRANSFER_STATUS_LABELS = TRANSFER_STATUS_TEXT
export const RED_PACKET_STATUS_LABELS = RED_PACKET_STATUS_TEXT
