import type { Contact } from '../../../shared/types'
import { buildContactSearchIndex, filterContactSearchIndex } from '../../../shared/contact-search'

export function filterContacts(list: Contact[], keyword: string): Contact[] {
  if (!keyword.trim()) return list
  return filterContactSearchIndex(buildContactSearchIndex(list), keyword)
}
