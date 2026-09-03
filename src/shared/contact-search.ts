import { pinyin } from 'pinyin-pro'
import type { Contact } from './types'

export interface ContactSearchText {
  raw: string
  normalized: string
  pinyin: string
  initials: string
}

export interface ContactSearchIndexEntry {
  contact: Contact
  fields: ContactSearchText[]
}

export type ContactSearchIndex = ContactSearchIndexEntry[]

export function normalizeContactSearchIdentity(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase()
}

function buildPinyin(value: string): { full: string; initials: string } {
  if (!value) return { full: '', initials: '' }
  try {
    const syllables = pinyin(value, { toneType: 'none', type: 'array' })
      .map((item) => normalizeContactSearchIdentity(item))
      .filter(Boolean)
    return {
      full: syllables.join(''),
      initials: syllables.map((item) => item.charAt(0)).join('')
    }
  } catch {
    return { full: '', initials: '' }
  }
}

function searchableText(value: unknown, withPinyin: boolean): ContactSearchText | null {
  const raw = String(value ?? '').trim()
  const normalized = normalizeContactSearchIdentity(raw)
  if (!normalized) return null
  const phonetic = withPinyin ? buildPinyin(raw) : { full: '', initials: '' }
  return { raw, normalized, pinyin: phonetic.full, initials: phonetic.initials }
}

export function buildContactSearchIndex(contacts: Contact[]): ContactSearchIndex {
  return contacts.map((contact) => ({
    contact,
    fields: [
      // The WCDB session shape can expose a contact remark as m_nsNickName
      // when the dedicated remark column is unavailable. Index it phonetically
      // so both normalized data shapes support the same search behavior.
      searchableText(contact.m_nsNickName, true),
      searchableText(contact.remark, true),
      searchableText(contact.wechatNickname, true),
      searchableText(contact.alias, false),
      searchableText(contact.wechatId, false),
      searchableText(
        contact.legacyIdentifier === (contact.wxid || contact.m_nsUsrName)
          ? undefined
          : contact.wxid || contact.m_nsUsrName,
        false
      )
    ].filter((field): field is ContactSearchText => Boolean(field))
  }))
}

export function matchesContactSearchText(field: ContactSearchText, query: string): boolean {
  const normalizedQuery = normalizeContactSearchIdentity(query)
  if (!normalizedQuery) return true
  return [field.normalized, field.pinyin, field.initials].some((value) =>
    value.includes(normalizedQuery)
  )
}

export function filterContactSearchIndex(
  index: ContactSearchIndex,
  query: string,
  type: Contact['type'] | 'all' = 'all'
): Contact[] {
  return index
    .filter(({ contact, fields }) => {
      if (type !== 'all' && contact.type !== type) return false
      return fields.some((field) => matchesContactSearchText(field, query))
    })
    .map(({ contact }) => contact)
}
