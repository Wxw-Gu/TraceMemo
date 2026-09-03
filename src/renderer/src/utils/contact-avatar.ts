import type { Contact } from '../../../shared/types'

export function selectContactAvatarRefreshUsernames(contacts: Contact[]): string[] {
  return Array.from(
    new Set(
      contacts
        .map((contact) => contact.m_nsUsrName)
        .filter(
          (username) =>
            Boolean(username) &&
            !username.startsWith('Group_') &&
            !username.startsWith('Unknown_')
        )
    )
  )
}
