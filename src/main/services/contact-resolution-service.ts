import type { Contact } from '../../shared/types'
import {
  emptyContactResolution,
  normalizeContactName,
  type ContactResolutionCandidate,
  type ContactResolutionMatch,
  type ContactResolutionResult
} from '../../shared/contact-resolution'

export type ContactResolutionScope = 'any' | 'person' | 'group'

const displayName = (contact: Contact): string =>
  contact.m_nsNickName || contact.remark || contact.wechatNickname || contact.m_nsUsrName

const aliases = (contact: Contact): Array<{ value: string; primary: boolean }> => {
  const groupName = contact.m_nsNickName?.trim() || ''
  const safeGroupAlias =
    contact.type === 'group' && groupName && !/群(?:聊)?$/.test(groupName)
      ? [{ value: `${groupName}群`, primary: false }]
      : []
  return [
    { value: contact.m_nsNickName, primary: true },
    { value: contact.remark || '', primary: false },
    { value: contact.wechatNickname || '', primary: false },
    { value: contact.m_nsUsrName, primary: false },
    ...safeGroupAlias
  ].filter((item) => Boolean(normalizeContactName(item.value)))
}

/**
 * The one main-process authority that converts a user/Agent supplied name to
 * an existing conversation. It only auto-confirms an exact canonical alias.
 * Fuzzy discovery intentionally returns candidates rather than a guessed ID.
 */
export function resolveContact(
  query: string,
  contacts: Contact[],
  scope: ContactResolutionScope = 'any'
): ContactResolutionResult {
  const normalizedQuery = normalizeContactName(query)
  if (!normalizedQuery) return emptyContactResolution()
  const matches = new Map<string, { contact: Contact; matchedBy: ContactResolutionMatch }>()

  for (const contact of contacts) {
    if (!contact.md5) continue
    if (scope === 'person' && contact.type !== 'user') continue
    if (scope === 'group' && contact.type !== 'group') continue
    for (const alias of aliases(contact)) {
      if (normalizeContactName(alias.value) !== normalizedQuery) continue
      const rawExact =
        alias.value.trim().normalize('NFKC').toLocaleLowerCase() ===
        query.trim().normalize('NFKC').toLocaleLowerCase()
      const matchedBy: ContactResolutionMatch = alias.primary
        ? rawExact
          ? 'exact'
          : 'normalized'
        : 'alias'
      const current = matches.get(contact.md5)
      if (!current || (current.matchedBy === 'alias' && matchedBy !== 'alias')) {
        matches.set(contact.md5, { contact, matchedBy })
      }
    }
  }

  const candidates: ContactResolutionCandidate[] = Array.from(matches.values())
    .map(({ contact, matchedBy }) => ({
      conversationId: contact.md5,
      displayName: displayName(contact),
      matchedBy,
      confidence: 1
    }))
    .sort((left, right) => left.displayName.localeCompare(right.displayName, 'zh-CN'))
  if (candidates.length !== 1) {
    return {
      ...emptyContactResolution(),
      candidates,
      ambiguous: candidates.length > 1
    }
  }
  const candidate = candidates[0]
  const contact = matches.get(candidate.conversationId)!.contact
  return {
    matched: true,
    personId: contact.m_nsUsrName,
    conversationId: contact.md5,
    canonicalName: displayName(contact),
    displayName: candidate.displayName,
    matchedBy: candidate.matchedBy,
    confidence: candidate.confidence,
    candidates,
    ambiguous: false
  }
}
