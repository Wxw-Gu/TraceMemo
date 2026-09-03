import type { Contact } from '../../../shared/types'

export function filterContacts(list: Contact[], keyword: string): Contact[] {
  const query = keyword.trim().toLocaleLowerCase()
  if (!query) return list

  return list.filter((contact) =>
    [
      contact.remark,
      contact.wechatNickname,
      contact.m_nsNickName,
      contact.alias,
      contact.wechatId,
      contact.m_nsUsrName
    ].some((value) => value?.trim().toLocaleLowerCase().includes(query))
  )
}
