import crypto from 'crypto'

export type DerivedV4ImageKeys = { xorKey: number; aesKey: string }

export function normalizeV4AccountId(value: string): string {
  const leaf = String(value || '')
    .trim()
    .split(/[\\/]/)
    .filter(Boolean)
    .pop()
  if (!leaf) return ''
  const wxid = leaf.match(/^(wxid_[^_]+)/i)
  if (wxid) return wxid[1]
  return leaf.replace(/_[a-z0-9]{4}$/i, '')
}

export function extractKvcommCode(fileName: string): number | null {
  const match = String(fileName || '').match(/^key_(\d+)_.+\.statistic$/i)
  if (!match) return null
  const code = Number.parseInt(match[1], 10)
  if (!Number.isSafeInteger(code) || code <= 0 || code > 0xffffffff) return null
  return code
}

export function deriveV4ImageKeys(code: number, accountId: string): DerivedV4ImageKeys | null {
  const normalizedAccountId = normalizeV4AccountId(accountId)
  if (!Number.isSafeInteger(code) || code <= 0 || code > 0xffffffff || !normalizedAccountId) {
    return null
  }
  const digest = crypto
    .createHash('md5')
    .update(`${code}${normalizedAccountId}`, 'utf8')
    .digest('hex')
  return { xorKey: code & 0xff, aesKey: digest.slice(0, 16) }
}
