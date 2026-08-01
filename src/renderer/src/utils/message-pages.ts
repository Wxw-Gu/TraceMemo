import type { Message } from '../../../shared/types'

export const getMessageIdentity = (message: Message): string => {
  if (message.localId) return `local:${message.localId}`
  if (message.id) return `id:${message.id}`
  return `${message.createTime || 0}:${message.from}:${message.type}:${message.content}`
}

export const sortMessagesChronologically = (items: Message[]): Message[] =>
  [...items].sort((left, right) => {
    const timeDelta = (left.createTime || 0) - (right.createTime || 0)
    if (timeDelta !== 0) return timeDelta
    return getMessageIdentity(left).localeCompare(getMessageIdentity(right))
  })

export const mergeMessagePages = (older: Message[], current: Message[]): Message[] => {
  const merged = new Map<string, Message>()
  for (const message of [...older, ...current]) merged.set(getMessageIdentity(message), message)
  return sortMessagesChronologically(Array.from(merged.values()))
}
