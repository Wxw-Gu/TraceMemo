import type { Contact } from './types'

type ContactNameSource = Partial<Pick<
  Contact,
  | 'm_nsNickName'
  | 'm_nsUsrName'
  | 'remark'
  | 'alias'
  | 'wechatNickname'
  | 'wechatId'
  | 'wxid'
>>

const nonRenderingCharacters = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}]/gu
const trailingPathCharacters = /[. ]+$/u
const reservedDeviceName = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/iu

/** Remove characters that can make a name invisible while preserving normal emoji and CJK text. */
export function visibleNamePart(value: unknown): string {
  return String(value ?? '')
    .replace(nonRenderingCharacters, '')
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/ {2,}/gu, ' ')
    .trim()
}

export function isVisibleName(value: unknown): boolean {
  return visibleNamePart(value).length > 0
}

/** Resolve a contact label without ever exposing an all-invisible raw nickname. */
export function displayContactName(
  contact: ContactNameSource | null | undefined,
  fallback = '未命名联系人'
): string {
  const candidates = [
    contact?.m_nsNickName,
    contact?.remark,
    contact?.alias,
    contact?.wechatNickname,
    contact?.wechatId,
    contact?.wxid,
    contact?.m_nsUsrName
  ]
  for (const candidate of candidates) {
    const visible = visibleNamePart(candidate)
    if (visible) return visible
  }
  return fallback
}

/** Make a human-readable label safe for a file or directory name. */
export function filesystemSafeName(value: unknown, fallback = '未命名联系人'): string {
  const visible = visibleNamePart(value)
  const replaced = visible
    .replace(/[\\/:*?"<>|]/gu, '_')
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/ {2,}/gu, ' ')
    .replace(trailingPathCharacters, '')
    .trim()
  const candidate = replaced || visibleNamePart(fallback) || '未命名联系人'
  if (reservedDeviceName.test(candidate)) return `${candidate}_`
  return Array.from(candidate).slice(0, 80).join('') || '未命名联系人'
}
